import { test, expect } from "bun:test";
import { collectFacets, ENRICH_TIMEOUT_MS, MAX_FACETS_PER_ITEM, MAX_DETAIL_ROWS } from "../plugins/handlers";
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

// 上一条用单个插件×50 条，就算把封顶挪回每个插件自己清理那一步（每个插件各自
// 砍到 6 条）也照样绿——那条测不出"两个插件加起来不能刷爆一张卡片"这条真正的
// 属性。这里换成两个插件各给 4 条，合起来 8 条：封顶必须在合并之后做才能压到
// MAX_FACETS_PER_ITEM，挪回每插件清理的话两个插件各自都不到 6 条、谁都不会被
// 砍，这条测试就会失败。
test("两个插件各自没超上限，合起来仍然砍到卡片的上限", async () => {
  const a: PluginEnricher = async () => ({
    "it-1": Array.from({ length: 4 }, (_, i) => ({ dim: `a${i}`, value: String(i) })),
  });
  const b: PluginEnricher = async () => ({
    "it-1": Array.from({ length: 4 }, (_, i) => ({ dim: `b${i}`, value: String(i) })),
  });
  const got = await collectFacets(items, { a, b });
  expect(got["it-1"]!.length).toBe(MAX_FACETS_PER_ITEM);
});

// 插件冒充内核自己的命名空间：一个坏插件贴一个 item.agent 就能在页面上再画一个
// Agent chip、把卡片重新分到别的组，等于让插件替内核的事实撒谎。内核已经不信
// 插件的长度、id、tone，这里是同一个姿势。
test("插件不能冒充 item.* 命名空间下的维度", async () => {
  const impostor: PluginEnricher = async () => ({
    "it-1": [
      { dim: "item.agent", value: "waiting" },
      { dim: "jira.status", value: "In Progress" },
    ],
  });
  const got = await collectFacets(items, { impostor });
  expect(got["it-1"]).toEqual([{ dim: "jira.status", value: "In Progress" }]);
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

/**
 * facet 底下可展开的明细。
 *
 * 内核不解释这些行是什么——是 CI 检查还是别的，只有插件知道。但它照样不信插件给
 * 的长度和数量：截断、封顶、tone 只认三个值，跟 facet 本身同一套姿态。
 */

test("明细原样带过来", async () => {
  const withDetail: PluginEnricher = async () => ({
    "it-1": [
      {
        dim: "jira.checks",
        value: "1/2",
        detail: [
          { label: "ci/circleci: test", value: "FAILED", tone: "warn" },
          { label: "ci/circleci: build", value: "SUCCESSFUL", tone: "ok" },
        ],
      },
    ],
  });
  const got = await collectFacets(items, { p: withDetail });
  expect(got["it-1"]![0]!.detail?.length).toBe(2);
  expect(got["it-1"]![0]!.detail?.[0]!.label).toBe("ci/circleci: test");
});

test("没有明细的 facet 不带 detail 字段", async () => {
  const got = await collectFacets(items, { p: ok });
  expect(got["it-1"]![0]!.detail).toBeUndefined();
});

// 一个坏插件不能靠明细撑爆浮层。
test("明细行数封顶", async () => {
  const flood: PluginEnricher = async () => ({
    "it-1": [
      {
        dim: "a",
        value: "1",
        detail: Array.from({ length: 100 }, (_, i) => ({ label: `c${i}`, value: "OK" })),
      },
    ],
  });
  const got = await collectFacets(items, { p: flood });
  expect(got["it-1"]![0]!.detail?.length).toBe(MAX_DETAIL_ROWS);
});

test("明细的 label 截断到 120，没有 label 的整行丢掉", async () => {
  const messy = (async () => ({
    "it-1": [
      {
        dim: "a",
        value: "1",
        detail: [{ label: "x".repeat(500), value: "OK" }, { label: "", value: "OK" }],
      },
    ],
  })) as unknown as PluginEnricher;
  const got = await collectFacets(items, { p: messy });
  expect(got["it-1"]![0]!.detail?.length).toBe(1);
  expect(got["it-1"]![0]!.detail?.[0]!.label.length).toBe(120);
});

test("明细的 tone 只认三个值", async () => {
  const toned = (async () => ({
    "it-1": [
      { dim: "a", value: "1", detail: [{ label: "c", value: "OK", tone: "purple" }] },
    ],
  })) as unknown as PluginEnricher;
  const got = await collectFacets(items, { p: toned });
  expect(got["it-1"]![0]!.detail?.[0]!.tone).toBeUndefined();
});

// detail 不是绕过 item.* 保护的后门：整条 facet 仍然按 dim 被拦掉。
test("冒充 item.* 的 facet 连带它的明细一起被拦", async () => {
  const sneaky = (async () => ({
    "it-1": [{ dim: "item.agent", value: "waiting", detail: [{ label: "c", value: "OK" }] }],
  })) as unknown as PluginEnricher;
  expect(await collectFacets(items, { p: sneaky })).toEqual({});
});

// 明细行的链接会变成页面上的 href，所以内核只放行 http/https。这几条不是"格式校验"，
// javascript: 是一条真的注入路径，相对地址则按当前页解析——插件不知道自己挂在哪。
test("明细里的 http/https 链接原样带过去", async () => {
  const got = await collectFacets([{ id: "a", source: null }], {
    p: async () => ({
      a: [{ dim: "x", value: "1", detail: [
        { label: "PR-1", value: "OPEN", url: "https://example.com/pr/1" },
        { label: "PR-2", value: "OPEN", url: "http://example.com/pr/2" },
      ] }],
    }),
  });
  expect(got.a![0]!.detail![0]!.url).toBe("https://example.com/pr/1");
  expect(got.a![0]!.detail![1]!.url).toBe("http://example.com/pr/2");
});

test("非 http/https 的链接被丢掉，但那一行还在", async () => {
  const got = await collectFacets([{ id: "a", source: null }], {
    p: async () => ({
      a: [{ dim: "x", value: "1", detail: [
        { label: "坏的", value: "OPEN", url: "javascript:alert(1)" },
        { label: "相对", value: "OPEN", url: "/p/jira/" },
        { label: "文件", value: "OPEN", url: "file:///etc/passwd" },
        // 插件清单那一侧是 JS，类型挡不住这个；safeHttpUrl 挡的正是运行时。
        { label: "不是字符串", value: "OPEN", url: { toString: () => "https://x/" } as unknown as string },
      ] }],
    }),
  });
  const rows = got.a![0]!.detail!;
  expect(rows.length).toBe(4);
  expect(rows.every((r) => r.url === undefined)).toBe(true);
  expect(rows[0]!.label).toBe("坏的");
});
