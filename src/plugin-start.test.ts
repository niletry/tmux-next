import { test, expect } from "bun:test";
import { startPlugins } from "../plugins/handlers";
import type { Plugin } from "../plugins/types";
import type { PluginServer } from "../plugins/handlers";

/**
 * `startPlugins` 是插件接缝里唯一跟来源无关的那一半，所以它留在 handlers.ts，
 * 用例也单独住一个文件（从 src/plugin-source.test.ts 搬来）。
 *
 * servers/plugins 作为参数、真表做默认值：注册表是编译期常量，不注入就没法证明
 * "一个插件抛了不挡别的插件"这条安全阀真的会兜住。
 */

const fakePlugins = (ids: string[]): Plugin[] =>
  ids.map((id) => ({ id, titleKey: `${id}.title`, icon: "", i18n: { zh: {}, en: {} } })) as Plugin[];

test("start 被调一次", async () => {
  let calls = 0;
  startPlugins({ a: { start: () => { calls += 1; } } }, fakePlugins(["a"]));
  expect(calls).toBe(1);
});

// 一个插件的 start 抛了，不能挡住服务器起来。
test("start 抛了不外泄，别的插件照常调到", async () => {
  let good = 0;
  const servers: Record<string, PluginServer> = {
    bad: { start: () => { throw new Error("boom"); } },
    good: { start: () => { good += 1; } },
  };
  expect(() => startPlugins(servers, fakePlugins(["bad", "good"]))).not.toThrow();
  expect(good).toBe(1);
});

test("没有插件声明 start 时什么都不做", () => {
  expect(() => startPlugins({}, [])).not.toThrow();
});
