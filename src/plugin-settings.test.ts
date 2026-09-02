import { test, expect } from "bun:test";
import { pluginSettings, savePluginSettings, MAX_SETTING_LEN } from "../plugins/handlers";
import type { PluginServer } from "../plugins/handlers";
import type { Plugin } from "../plugins/types";

/**
 * 插件配置的内核侧闸门。
 *
 * 这一层存在的理由是它挡住的两件事：**密钥绝不出门**，以及**只有清单声明过的键
 * 才交给插件**。前者是因为这个服务没有认证，token 进了浏览器就等于摊在任何能打开
 * 页面的东西面前；后者是因为不挡的话，这里就成了一个任意 JSON 写入器。
 *
 * 跟 plugin-enrich.test.ts 同一套办法：servers/plugins 是参数，好塞进会抛、会卡的
 * 假插件——真注册表是编译期常量，没有这个参数就没法证明安全阀真的会兜住。
 */

const FIELDS: Plugin["settings"] = [
  { key: "url", type: "url", labelKey: "x.url" },
  { key: "token", type: "secret", labelKey: "x.token" },
  { key: "flag", type: "boolean", labelKey: "x.flag" },
];

const plugin = (over: Partial<Plugin> = {}): Plugin => ({
  id: "fake",
  titleKey: "x.title",
  icon: "",
  i18n: { zh: {}, en: {} },
  settings: FIELDS,
  ...over,
});

const read = (values: Record<string, unknown>): PluginServer => ({
  readSettings: async () => values as never,
});

test("密钥只报设没设过，值绝不出门", async () => {
  const got = await pluginSettings(
    "fake",
    { fake: read({ url: "https://example.com", token: "super-secret", flag: true }) },
    [plugin()],
  );
  expect(got).toEqual({ url: "https://example.com", token: { set: true }, flag: true });
  // 整个响应里不能出现那串东西——不只是那个字段。
  expect(JSON.stringify(got)).not.toContain("super-secret");
});

// 插件自己就该只回一个布尔（jira/server.ts 是这么做的），但内核不能只靠那份自觉：
// 这里再压一次，插件回了字符串也照样压成一个比特。
test("插件即使回了密钥原文，内核也压成一个比特", async () => {
  const got = await pluginSettings(
    "fake",
    { fake: read({ url: "", token: "leaked-token", flag: false }) },
    [plugin()],
  );
  expect(got!.token).toEqual({ set: true });
  expect(JSON.stringify(got)).not.toContain("leaked");
});

test("没设过的密钥报 set:false", async () => {
  const got = await pluginSettings("fake", { fake: read({ token: "" }) }, [plugin()]);
  expect(got!.token).toEqual({ set: false });
});

// 清单没声明的键不该被带出去：插件内部叫什么是它自己的事，页面只该看见声明过的。
test("插件多回的字段被丢掉", async () => {
  const got = await pluginSettings(
    "fake",
    { fake: read({ url: "https://example.com", token: "t", flag: true, internalCache: "…" }) },
    [plugin()],
  );
  expect(Object.keys(got!).sort()).toEqual(["flag", "token", "url"]);
});

test("插件抛了就当读不到，不是让调用方炸", async () => {
  const got = await pluginSettings(
    "fake",
    { fake: { readSettings: async () => { throw new Error("boom"); } } },
    [plugin()],
  );
  expect(got).toBeNull();
});

test("插件卡住不会吊死调用方", async () => {
  const got = await pluginSettings(
    "fake",
    { fake: { readSettings: () => new Promise(() => {}) } },
    [plugin()],
    5,
  );
  expect(got).toBeNull();
});

test("没声明 settings 的插件读不到配置", async () => {
  const got = await pluginSettings("fake", { fake: read({ url: "x" }) }, [plugin({ settings: undefined })]);
  expect(got).toBeNull();
});

// --- 写入 -------------------------------------------------------------------

function writer() {
  const seen: Record<string, unknown>[] = [];
  const server: PluginServer = {
    writeSettings: async (values: Record<string, string | boolean>) => {
      seen.push(values);
    },
  };
  return { seen, server };
}

test("只把清单声明过的键交给插件", async () => {
  const { seen, server } = writer();
  const ok = await savePluginSettings(
    "fake",
    { url: "https://example.com", token: "t", flag: true, evil: "rm -rf", __proto__: "no" },
    { fake: server },
    [plugin()],
  );
  expect(ok).toBe(true);
  expect(Object.keys(seen[0]!).sort()).toEqual(["flag", "token", "url"]);
});

// 表单里的复选框在 JSON 里可能是字符串。"false" 是真值，原样传下去会把开关拧反。
test("boolean 字段收到字符串也归一成真假", async () => {
  const { seen, server } = writer();
  await savePluginSettings("fake", { flag: "false" }, { fake: server }, [plugin()]);
  expect(seen[0]!.flag).toBe(false);
  await savePluginSettings("fake", { flag: "true" }, { fake: server }, [plugin()]);
  expect(seen[1]!.flag).toBe(true);
});

test("超长的值被截断", async () => {
  const { seen, server } = writer();
  await savePluginSettings("fake", { url: "x".repeat(MAX_SETTING_LEN + 500) }, { fake: server }, [plugin()]);
  expect((seen[0]!.url as string).length).toBe(MAX_SETTING_LEN);
});

// 清单说了是字符串，来的是别的（数字、对象、null），就是不认——不做隐式转换，
// 那只会把一个坏值悄悄变成一个像样的坏值。
test("类型不对的值被忽略而不是硬转", async () => {
  const { seen, server } = writer();
  const ok = await savePluginSettings(
    "fake",
    { url: 42, token: null, flag: true },
    { fake: server },
    [plugin()],
  );
  expect(ok).toBe(true);
  expect(Object.keys(seen[0]!)).toEqual(["flag"]);
});

test("一个能用的键都没有就不调插件", async () => {
  const { seen, server } = writer();
  const ok = await savePluginSettings("fake", { nothing: "here" }, { fake: server }, [plugin()]);
  expect(ok).toBe(false);
  expect(seen.length).toBe(0);
});

test("插件写的时候抛了就是没存上", async () => {
  const ok = await savePluginSettings(
    "fake",
    { url: "https://example.com" },
    { fake: { writeSettings: async () => { throw new Error("disk full"); } } },
    [plugin()],
  );
  expect(ok).toBe(false);
});

test("插件写的时候卡住也是没存上，不吊死调用方", async () => {
  const ok = await savePluginSettings(
    "fake",
    { url: "https://example.com" },
    { fake: { writeSettings: () => new Promise(() => {}) } },
    [plugin()],
    5,
  );
  expect(ok).toBe(false);
});

test("请求体不是对象就不认", async () => {
  const { seen, server } = writer();
  for (const body of [null, "url=x", 42, undefined]) {
    expect(await savePluginSettings("fake", body, { fake: server }, [plugin()])).toBe(false);
  }
  expect(seen.length).toBe(0);
});

// TMUX_NEXT_DISABLE_PLUGINS 关掉一个真插件，它的配置读写要一起消失——这条路径
// 绕过了 /api/<id> 那道 404 闸门，isConsidered 是它唯一的关卡。
test("被关掉的真插件读不到也写不进", async () => {
  const prev = process.env.TMUX_NEXT_DISABLE_PLUGINS;
  process.env.TMUX_NEXT_DISABLE_PLUGINS = "jira";
  try {
    expect(await pluginSettings("jira")).toBeNull();
    expect(await savePluginSettings("jira", { url: "https://example.org" })).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.TMUX_NEXT_DISABLE_PLUGINS;
    else process.env.TMUX_NEXT_DISABLE_PLUGINS = prev;
  }
});
