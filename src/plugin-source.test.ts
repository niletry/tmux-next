import { test, expect } from "bun:test";
import { runSync, refreshFromSource, startPlugins, SOURCE_TIMEOUT_MS } from "../plugins/handlers";
import type { Plugin } from "../plugins/types";
import type { PluginServer, SyncResult } from "../plugins/handlers";

/**
 * 内核只认识「来源」：它拿到一张单只知道 source.provider，据此查一次**插件自己
 * 声明的** provides，把活派过去。内核里没有任何 provider→插件 的名单。
 *
 * 表作为参数注入，理由同 collectFacets：注册表是编译期常量，不注入就没法证明
 * 超时和 try/catch 真的会兜住。
 *
 * 两条"卡住"测试给了一个很小的超时（50ms）而不是默认的 SOURCE_TIMEOUT_MS
 * （30s）——真实预算是"给一次真的网络请求"，测一次真等 30 秒只会让整个套件
 * 慢一分钟，证明的性质（不会永远吊着）跟等多久无关。SOURCE_TIMEOUT_MS 本身
 * 仍是导出常量、仍是 30s，只是两个函数都把超时开成可注入的尾参数。
 */

const TEST_TIMEOUT_MS = 50;

const ok = (n: number): SyncResult => ({ created: n, updated: 0, total: n, truncated: false });

const fakePlugins = (ids: Record<string, string[]>): Plugin[] =>
  Object.entries(ids).map(([id, provides]) => ({
    id,
    titleKey: `${id}.title`,
    icon: "",
    i18n: { zh: {}, en: {} },
    provides,
  })) as Plugin[];

test("没有插件声明 sync 时，汇总是零", async () => {
  expect(await runSync({}, [])).toEqual({ created: 0, updated: 0, total: 0, truncated: false });
});

test("单个插件的结果原样汇总", async () => {
  const servers: Record<string, PluginServer> = { a: { sync: async () => ok(3) } };
  expect(await runSync(servers, fakePlugins({ a: ["a"] }))).toEqual({
    created: 3, updated: 0, total: 3, truncated: false,
  });
});

test("多个插件的数字相加", async () => {
  const servers: Record<string, PluginServer> = {
    a: { sync: async () => ({ created: 2, updated: 1, total: 3, truncated: false }) },
    b: { sync: async () => ({ created: 0, updated: 4, total: 4, truncated: true }) },
  };
  const got = await runSync(servers, fakePlugins({ a: ["a"], b: ["b"] }));
  expect(got).toEqual({ created: 2, updated: 5, total: 7, truncated: true });
});

// 一个来源挂了不该拖垮别的来源。
test("一个插件抛了，别的照常汇总", async () => {
  const servers: Record<string, PluginServer> = {
    bad: { sync: async () => { throw new Error("boom"); } },
    good: { sync: async () => ok(2) },
  };
  const got = await runSync(servers, fakePlugins({ bad: ["bad"], good: ["good"] }));
  expect(got.total).toBe(2);
});

test("插件卡住时超时返回，不吊死", async () => {
  const servers: Record<string, PluginServer> = { slow: { sync: () => new Promise(() => {}) } };
  const started = Date.now();
  const got = await runSync(servers, fakePlugins({ slow: ["slow"] }), TEST_TIMEOUT_MS);
  expect(got.total).toBe(0);
  expect(Date.now() - started).toBeLessThan(SOURCE_TIMEOUT_MS);
});

test("按 provides 找到认领这个来源的插件", async () => {
  let sawRef = "";
  const servers: Record<string, PluginServer> = {
    a: { refreshItem: async (ref) => { sawRef = ref; } },
  };
  const found = await refreshFromSource("jira", "EXAMPLE-1", servers, fakePlugins({ a: ["jira"] }));
  expect(found).toBe(true);
  expect(sawRef).toBe("EXAMPLE-1");
});

// 没人认领要说得出来，页面据此不画一个必然失败的按钮。
test("没有插件认领这个来源时返回 false", async () => {
  const servers: Record<string, PluginServer> = { a: { refreshItem: async () => {} } };
  expect(await refreshFromSource("github", "12", servers, fakePlugins({ a: ["jira"] }))).toBe(false);
});

test("声明了 provides 但没实现 refreshItem，也算没人认领", async () => {
  const servers: Record<string, PluginServer> = { a: {} };
  expect(await refreshFromSource("jira", "x", servers, fakePlugins({ a: ["jira"] }))).toBe(false);
});

test("refreshItem 抛了当作失败，不外泄异常", async () => {
  const servers: Record<string, PluginServer> = {
    a: { refreshItem: async () => { throw new Error("boom"); } },
  };
  expect(await refreshFromSource("jira", "x", servers, fakePlugins({ a: ["jira"] }))).toBe(false);
});

test("refreshItem 卡住时超时返回 false", async () => {
  const servers: Record<string, PluginServer> = { a: { refreshItem: () => new Promise(() => {}) } };
  const started = Date.now();
  expect(
    await refreshFromSource("jira", "x", servers, fakePlugins({ a: ["jira"] }), TEST_TIMEOUT_MS),
  ).toBe(false);
  expect(Date.now() - started).toBeLessThan(SOURCE_TIMEOUT_MS);
});

// TMUX_NEXT_DISABLE_PLUGINS 关掉一个插件，要让它的 sync/refreshItem 一起消失——
// 跟它的 tab、它的 /api/<id> 一样。真表里确实存在 "jira" 这个 id，所以这条测试
// 只能用它（假插件不在真注册表里，天然被放行，证明不了这条过滤）。跑完必须把
// env 还原，Bun 整个套件在一个进程里跑，漏了会把 jira 悄悄关掉到后面的文件。
test("runSync 跳过被 TMUX_NEXT_DISABLE_PLUGINS 关掉的真插件", async () => {
  const prev = process.env.TMUX_NEXT_DISABLE_PLUGINS;
  process.env.TMUX_NEXT_DISABLE_PLUGINS = "jira";
  try {
    let called = false;
    const servers: Record<string, PluginServer> = {
      jira: { sync: async () => { called = true; return ok(1); } },
    };
    const got = await runSync(servers, fakePlugins({ jira: ["jira"] }));
    expect(called).toBe(false);
    expect(got).toEqual({ created: 0, updated: 0, total: 0, truncated: false });
  } finally {
    if (prev === undefined) delete process.env.TMUX_NEXT_DISABLE_PLUGINS;
    else process.env.TMUX_NEXT_DISABLE_PLUGINS = prev;
  }
});

test("refreshFromSource 不会调被 TMUX_NEXT_DISABLE_PLUGINS 关掉的真插件", async () => {
  const prev = process.env.TMUX_NEXT_DISABLE_PLUGINS;
  process.env.TMUX_NEXT_DISABLE_PLUGINS = "jira";
  try {
    let called = false;
    const servers: Record<string, PluginServer> = {
      jira: { refreshItem: async () => { called = true; } },
    };
    const found = await refreshFromSource("jira", "X-1", servers, fakePlugins({ jira: ["jira"] }));
    expect(found).toBe(false);
    expect(called).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.TMUX_NEXT_DISABLE_PLUGINS;
    else process.env.TMUX_NEXT_DISABLE_PLUGINS = prev;
  }
});

test("start 被调一次", async () => {
  let calls = 0;
  startPlugins({ a: { start: () => { calls += 1; } } }, fakePlugins({ a: ["a"] }));
  expect(calls).toBe(1);
});

// 一个插件的 start 抛了，不能挡住服务器起来。
test("start 抛了不外泄，别的插件照常调到", async () => {
  let good = 0;
  expect(() =>
    startPlugins(
      { bad: { start: () => { throw new Error("boom"); } }, good: { start: () => { good += 1; } } },
      fakePlugins({ bad: ["bad"], good: ["good"] }),
    ),
  ).not.toThrow();
  expect(good).toBe(1);
});

test("没有插件声明 start 时什么都不做", () => {
  expect(() => startPlugins({}, [])).not.toThrow();
});
