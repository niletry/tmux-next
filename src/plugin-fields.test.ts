import { test, expect } from "bun:test";
import {
  collectFields,
  FIELD_TIMEOUT_MS,
  MAX_FIELD_LEN,
  MAX_FIELDS_PER_ITEM,
} from "../plugins/handlers";
import type { ItemRef, PluginFieldSource } from "../plugins/types";

/**
 * 跟 src/plugin-enrich.test.ts 同一条道理：这个口子的失败语义只有一种——**拿不到就当
 * 没有**，占位符渲染成空。sources 是参数而不是直接用 FIELD_SOURCES，正是为了能在这里
 * 塞进会抛、会卡住的假插件；注册表是编译期常量，没有这个参数就没法证明安全阀会触发。
 */

const item: ItemRef = { id: "it-1", source: { provider: "jira", ref: "EXAMPLE-1" } };

const ok: PluginFieldSource = async () => ({ "jira.summary": "修登录页" });
const throws: PluginFieldSource = async () => {
  throw new Error("boom");
};
const hangs: PluginFieldSource = () => new Promise(() => {});

test("没有插件时给空表", async () => {
  expect(await collectFields(item, {})).toEqual({});
});

test("正常插件的字段收得到", async () => {
  expect(await collectFields(item, { p: ok })).toEqual({ "jira.summary": "修登录页" });
});

test("插件抛了，只是这一轮没有字段", async () => {
  expect(await collectFields(item, { bad: throws })).toEqual({});
});

test("一个插件抛了不影响另一个", async () => {
  expect(await collectFields(item, { bad: throws, good: ok })).toEqual({
    "jira.summary": "修登录页",
  });
});

test("插件卡住时超时返回，不吊死调用方", async () => {
  const started = Date.now();
  // 注入 50ms 的超时值而不是用 5 秒的默认值，让这条测试能在毫秒级证明超时会兜住，
  // 不用等真实的预算时间。
  expect(await collectFields(item, { slow: hangs }, 50)).toEqual({});
  expect(Date.now() - started).toBeLessThan(200);
});

test("返回不是对象时当作没有", async () => {
  const weird = (async () => ["nope"]) as unknown as PluginFieldSource;
  expect(await collectFields(item, { weird })).toEqual({});
});

// item.* 是内核的命名空间。让插件写进来，等于让它伪造这张单的标题和单号，
// 而模板渲染分不出是谁写的。
test("插件不能占用 item.* 前缀", async () => {
  const sneaky: PluginFieldSource = async () => ({ "item.title": "假的", "jira.ok": "真的" });
  expect(await collectFields(item, { sneaky })).toEqual({ "jira.ok": "真的" });
});

test("占位符语法认不出的键被丢掉", async () => {
  const weird: PluginFieldSource = async () => ({ "有空格 的键": "x", "jira.ok": "真的" });
  expect(await collectFields(item, { weird })).toEqual({ "jira.ok": "真的" });
});

test("空值被丢掉，跟没给这个键一样", async () => {
  const blank: PluginFieldSource = async () => ({ "jira.epic": "" });
  expect(await collectFields(item, { blank })).toEqual({});
});

test("值截到 MAX_FIELD_LEN", async () => {
  const long: PluginFieldSource = async () => ({ "jira.description": "x".repeat(MAX_FIELD_LEN + 100) });
  const got = await collectFields(item, { long });
  expect(got["jira.description"]!.length).toBe(MAX_FIELD_LEN);
});

// 封顶是"合并之后"，不是"每个插件"：两个插件加起来也不能灌爆一张单。
test("合并后按 MAX_FIELDS_PER_ITEM 封顶", async () => {
  const many = (prefix: string): PluginFieldSource => async () =>
    Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`${prefix}.k${i}`, "v"]));
  const got = await collectFields(item, { a: many("a"), b: many("b") });
  expect(Object.keys(got).length).toBe(MAX_FIELDS_PER_ITEM);
});
