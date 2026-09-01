import { test, expect } from "bun:test";
import { collectFacets, ENRICH_TIMEOUT_MS, MAX_FACETS_PER_ITEM } from "../plugins/handlers";
import type { Facet, ItemRef, PluginEnricher } from "../plugins/types";

/**
 * 这条口子的失败语义只有一种：**拿不到就当没有**。插件抛了、超时了、返回了不是
 * 对象的东西，都只是这一轮没有 facet，首页照常渲染。内核的页面不能因为一个插件
 * 而出不来——这是开这个口子的唯一安全阀。
 *
 * enrichers 是参数而不是直接用 ENRICHERS，正是为了能在这里塞进假插件：注册表是
 * 编译期常量，没有这个参数就没法证明超时和 try/catch 真的会兜住。
 */

const items: ItemRef[] = [
  { id: "it-1", source: { provider: "jira", ref: "EXAMPLE-1" } },
  { id: "it-2", source: null },
];

const ok: PluginEnricher = async () => ({ "it-1": [{ dim: "jira.status", value: "In Progress" }] });
const throws: PluginEnricher = async () => {
  throw new Error("boom");
};
const hangs: PluginEnricher = () => new Promise(() => {});

test("没有插件时给空表", async () => {
  expect(await collectFacets(items, {})).toEqual({});
});

test("正常插件的 facet 收得到", async () => {
  expect(await collectFacets(items, { p: ok })).toEqual({
    "it-1": [{ dim: "jira.status", value: "In Progress" }],
  });
});

test("插件抛了，只是这一轮没有 facet", async () => {
  expect(await collectFacets(items, { bad: throws })).toEqual({});
});

test("一个插件抛了不影响另一个", async () => {
  expect(await collectFacets(items, { bad: throws, good: ok })).toEqual({
    "it-1": [{ dim: "jira.status", value: "In Progress" }],
  });
});

test("插件卡住时超时返回，不吊死页面", async () => {
  const started = Date.now();
  expect(await collectFacets(items, { slow: hangs })).toEqual({});
  expect(Date.now() - started).toBeLessThan(ENRICH_TIMEOUT_MS * 4);
});

test("卡住的插件不影响正常插件", async () => {
  expect(await collectFacets(items, { slow: hangs, good: ok })).toEqual({
    "it-1": [{ dim: "jira.status", value: "In Progress" }],
  });
});

test("返回不是对象时当作没有", async () => {
  const weird = (async () => ["nope"]) as unknown as PluginEnricher;
  expect(await collectFacets(items, { weird })).toEqual({});
});

// 插件只能标注被问到的单，不能塞进没要求的键。
test("没被问到的 item id 被丢掉", async () => {
  const sneaky: PluginEnricher = async () => ({
    "it-1": [{ dim: "a", value: "1" }],
    "it-999": [{ dim: "b", value: "2" }],
  });
  expect(await collectFacets(items, { sneaky })).toEqual({ "it-1": [{ dim: "a", value: "1" }] });
});

test("value 截断到 120 字符", async () => {
  const long: PluginEnricher = async () => ({ "it-1": [{ dim: "a", value: "x".repeat(500) }] });
  const got = await collectFacets(items, { long });
  expect(got["it-1"]![0]!.value.length).toBe(120);
});

test("dim 也截断，且没有 dim 或没有 value 的整条丢掉", async () => {
  const messy = (async () => ({
    "it-1": [
      { dim: "", value: "无维度" },
      { dim: "a", value: "" },
      { dim: "y".repeat(500), value: "有" },
    ],
  })) as unknown as PluginEnricher;
  const got = await collectFacets(items, { messy });
  expect(got["it-1"]!.length).toBe(1);
  expect(got["it-1"]![0]!.dim.length).toBe(120);
});

// 一个插件不能刷爆卡片。
test("每单最多 6 个 facet", async () => {
  const flood: PluginEnricher = async () => ({
    "it-1": Array.from({ length: 50 }, (_, i) => ({ dim: `d${i}`, value: String(i) })),
  });
  const got = await collectFacets(items, { flood });
  expect(got["it-1"]!.length).toBe(MAX_FACETS_PER_ITEM);
});

test("tone 只认三个值，别的丢掉", async () => {
  const toned = (async () => ({
    "it-1": [
      { dim: "a", value: "1", tone: "ok" },
      { dim: "b", value: "2", tone: "purple" },
    ],
  })) as unknown as PluginEnricher;
  const got = await collectFacets(items, { toned });
  expect(got["it-1"]![0]!.tone).toBe("ok");
  expect(got["it-1"]![1]!.tone).toBeUndefined();
});

// 两个插件给同一张单贴维度时，合并成一行 chips，而不是按插件分层。
test("多个插件的 facet 合并到同一张单下", async () => {
  const other: PluginEnricher = async () => ({ "it-1": [{ dim: "git.branch", value: "main" }] });
  const got = await collectFacets(items, { good: ok, other });
  expect(got["it-1"]!.length).toBe(2);
  expect(got["it-1"]!.map((f: Facet) => f.dim).sort()).toEqual(["git.branch", "jira.status"]);
});
