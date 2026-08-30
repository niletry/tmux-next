import { test, expect } from "bun:test";
import { collectAnnotations, ANNOTATE_TIMEOUT_MS } from "../plugins/handlers";
import type { PluginAnnotator } from "../plugins/types";

/**
 * 会话列表是内核的页面，插件只能往上贴一小段只读的展示数据。
 *
 * 这里检的不是"标注能贴上"，而是**贴不上的时候列表照常出**：一个抛异常的插件、
 * 一个永远不返回的插件，都不许把内核页面拖下水。这是开这个口子唯一的安全阀。
 */

const SESSIONS = ["修登录页", "跑测试"];

test("正常的插件把标注贴上，按插件 id 分组", async () => {
  const good: PluginAnnotator = async (sessions) =>
    Object.fromEntries(sessions.map((s) => [s, { text: "EXAMPLE-1" }]));
  expect(await collectAnnotations(SESSIONS, { jira: good })).toEqual({
    jira: { 修登录页: { text: "EXAMPLE-1" }, 跑测试: { text: "EXAMPLE-1" } },
  });
});

test("抛异常的插件被忽略，别的插件照常", async () => {
  const boom: PluginAnnotator = async () => {
    throw new Error("插件炸了");
  };
  const good: PluginAnnotator = async () => ({ 修登录页: { text: "OK" } });
  const out = await collectAnnotations(SESSIONS, { bad: boom, good });
  expect(out.bad).toBeUndefined();
  expect(out.good).toEqual({ 修登录页: { text: "OK" } });
});

test("超时的插件被放弃，不拖住列表", async () => {
  const slow: PluginAnnotator = () => new Promise(() => {});
  const started = Date.now();
  const out = await collectAnnotations(SESSIONS, { slow });
  expect(out.slow).toBeUndefined();
  // 上限留一倍余量：断言的是"确实被截断了"，不是精确耗时。
  expect(Date.now() - started).toBeLessThan(ANNOTATE_TIMEOUT_MS * 2);
});

test("返回非对象的插件被忽略", async () => {
  const junk = (async () => "不是对象") as unknown as PluginAnnotator;
  expect(await collectAnnotations(SESSIONS, { junk })).toEqual({});
});

test("标注文本超长会被截断，不许撑破列表", async () => {
  const chatty: PluginAnnotator = async () => ({ 修登录页: { text: "x".repeat(500) } });
  const out = await collectAnnotations(SESSIONS, { chatty });
  expect(out.chatty?.["修登录页"]?.text.length).toBeLessThanOrEqual(120);
});

test("没有插件时是空对象，不是 undefined", async () => {
  expect(await collectAnnotations(SESSIONS, {})).toEqual({});
});
