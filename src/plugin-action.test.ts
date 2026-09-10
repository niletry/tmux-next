import { test, expect } from "bun:test";
import { runPluginAction } from "../plugins/handlers";
import type { PluginServer } from "../plugins/handlers";
import type { Plugin } from "../plugins/types";

/**
 * 设置页的插件动作按钮（比如 Jira 的「完整同步」）的内核侧闸门。
 *
 * 跟 plugin-settings.test.ts、plugin-source.test.ts 同一套办法：servers/plugins
 * 是参数，好塞进会抛、会卡的假插件——真注册表是编译期常量，没有这个参数就没法
 * 证明这里的安全阀真的会兜住。
 *
 * 闸门要挡的两件事：**清单没声明的键绝不传给插件**（不然这个无认证的服务就成了
 * 一个任意字符串执行器），以及**一个插件的动作不能吊死调用方**——都跟 settings
 * 那道闸门是同一个理由，形状也照抄它。
 */

const ACTIONS: Plugin["actions"] = [{ key: "full-sync", labelKey: "x.full", doneKey: "x.fullDone" }];

const plugin = (over: Partial<Plugin> = {}): Plugin => ({
  id: "fake",
  titleKey: "x.title",
  icon: "",
  i18n: { zh: {}, en: {} },
  actions: ACTIONS,
  ...over,
});

test("声明过的动作交给插件的 runAction，成功即返回 true", async () => {
  let sawKey = "";
  const server: PluginServer = {
    runAction: async (key) => {
      sawKey = key;
      return true;
    },
  };
  const got = await runPluginAction("fake", "full-sync", { fake: server }, [plugin()]);
  expect(got).toBe(true);
  expect(sawKey).toBe("full-sync");
});

test("插件自己回 false 就是 false", async () => {
  const server: PluginServer = { runAction: async () => false };
  const got = await runPluginAction("fake", "full-sync", { fake: server }, [plugin()]);
  expect(got).toBe(false);
});

test("不认识的插件 id 直接 false", async () => {
  const got = await runPluginAction("nope", "full-sync", {}, [plugin()]);
  expect(got).toBe(false);
});

// 清单没声明的键不能传给插件——不然这个无认证的服务就是任意字符串执行器。
test("清单没声明的动作键不会传给插件", async () => {
  let called = false;
  const server: PluginServer = {
    runAction: async () => {
      called = true;
      return true;
    },
  };
  const got = await runPluginAction("fake", "not-declared", { fake: server }, [plugin()]);
  expect(got).toBe(false);
  expect(called).toBe(false);
});

test("没声明 actions 的插件调不到任何动作", async () => {
  const server: PluginServer = { runAction: async () => true };
  const got = await runPluginAction("fake", "full-sync", { fake: server }, [
    plugin({ actions: undefined }),
  ]);
  expect(got).toBe(false);
});

test("没实现 runAction 的插件是 false", async () => {
  const got = await runPluginAction("fake", "full-sync", { fake: {} }, [plugin()]);
  expect(got).toBe(false);
});

test("插件的 runAction 抛了就是 false，不吊死调用方", async () => {
  const server: PluginServer = {
    runAction: async () => {
      throw new Error("boom");
    },
  };
  const got = await runPluginAction("fake", "full-sync", { fake: server }, [plugin()]);
  expect(got).toBe(false);
});

test("插件卡住不会吊死调用方", async () => {
  const server: PluginServer = { runAction: () => new Promise(() => {}) };
  const started = Date.now();
  const got = await runPluginAction("fake", "full-sync", { fake: server }, [plugin()], 50);
  expect(got).toBe(false);
  expect(Date.now() - started).toBeLessThan(500);
});

// TMUX_NEXT_DISABLE_PLUGINS 关掉一个真插件，它的动作要跟着一起消失——跟
// settings 那道闸门同一个理由，isConsidered 是它唯一的关卡。
test("被关掉的真插件调不到动作", async () => {
  const prev = process.env.TMUX_NEXT_DISABLE_PLUGINS;
  process.env.TMUX_NEXT_DISABLE_PLUGINS = "jira";
  try {
    expect(await runPluginAction("jira", "full-sync")).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.TMUX_NEXT_DISABLE_PLUGINS;
    else process.env.TMUX_NEXT_DISABLE_PLUGINS = prev;
  }
});
