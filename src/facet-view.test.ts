import { test, expect } from "bun:test";
import {
  dimensionsOf,
  valuesOf,
  groupItems,
  filterItems,
  pruneSelection,
  AGENT_ORDER,
} from "../public/facet-view.js";

/**
 * 视图层的判断全在这里，而页面文件不做类型检查——所以这一层单独成文件，无头地测。
 *
 * 维度与取值都是**从当前数据里现算**的，不维护写死的表：加一个插件维度不该需要动
 * 这个文件。
 *
 * agent 维度只有 waiting/working/none 三个值——"idle" 是这个仓库里"卡在提示符等你"
 * 的既有叫法，活着的会话要么在等你、要么在干活，"idle" 这个取值不会被产出。
 */

const items = [
  { id: "a", title: "甲" },
  { id: "b", title: "乙" },
  { id: "c", title: "丙" },
];

const facets = {
  a: [
    { dim: "item.agent", value: "waiting" },
    { dim: "jira.status", value: "In Progress" },
    { dim: "item.tag", value: "急" },
  ],
  b: [
    { dim: "item.agent", value: "working" },
    { dim: "jira.status", value: "In Progress" },
  ],
  c: [{ dim: "item.agent", value: "waiting" }],
};

test("维度按首次出现的顺序列出，去重", () => {
  expect(dimensionsOf(facets)).toEqual(["item.agent", "jira.status", "item.tag"]);
});

test("没有数据时没有维度", () => {
  expect(dimensionsOf({})).toEqual([]);
});

test("取值去重且按出现顺序", () => {
  expect(valuesOf(facets, "item.agent")).toEqual(["waiting", "working"]);
  expect(valuesOf(facets, "jira.status")).toEqual(["In Progress"]);
});

test("不存在的维度没有取值", () => {
  expect(valuesOf(facets, "nope")).toEqual([]);
});

test("按维度分组", () => {
  const groups = groupItems(items, facets, "jira.status");
  expect(groups.map((g) => g.value)).toEqual(["In Progress", ""]);
  expect(groups[0]!.items.map((i) => i.id)).toEqual(["a", "b"]);
  expect(groups[1]!.items.map((i) => i.id)).toEqual(["c"]);
});

// 没有这个维度的单不能凭空消失——它们落进最后一组。
test("缺这个维度的单落进最后一个空组", () => {
  const groups = groupItems(items, facets, "item.tag");
  expect(groups[groups.length - 1]!.value).toBe("");
  expect(groups[groups.length - 1]!.items.map((i) => i.id)).toEqual(["b", "c"]);
});

// 一张单可以有多个标签，它在每个标签下都该出现。
test("一张单在某维度上有多个取值时进入每一组", () => {
  const multi = { a: [{ dim: "item.tag", value: "急" }, { dim: "item.tag", value: "前端" }] };
  const groups = groupItems([{ id: "a", title: "甲" }], multi, "item.tag");
  expect(groups.map((g) => g.value)).toEqual(["急", "前端"]);
  expect(groups[0]!.items.map((i) => i.id)).toEqual(["a"]);
  expect(groups[1]!.items.map((i) => i.id)).toEqual(["a"]);
});

// 手机上第一眼要回答的是「该我动了吗」，所以 agent 维度不按出现顺序，按紧急程度。
test("按 agent 分组时用固定顺序，不按出现顺序", () => {
  const groups = groupItems(items, facets, "item.agent");
  expect(groups.map((g) => g.value)).toEqual(["waiting", "working"]);
  expect(AGENT_ORDER).toEqual(["waiting", "working", "none"]);
});

// "空的分组不出现" 原来断言的是 groups.some(g => g.items.length === 0) 恒为
// false——但 groupItems 的实现只从数据里实际出现的取值建组（byValue 的 key
// 本身就不会是空列表），missing 桶也只在非空时才 push，代码里根本没有能产出
// 空组的分支，这条断言测不出任何东西会被打破。
//
// 真正会被打破的地方是 AGENT_ORDER 那条白名单过滤：它把"固定顺序里有、但这批
// 数据里没人取这个值"的取值滤掉（`known = AGENT_ORDER.filter(v => byValue.has(v))`），
// 不然 "none" 会作为一个没有单的空组占位。这里换成测这条真正的属性。
test("AGENT_ORDER 里的取值没人用时不占出一个空组", () => {
  // fixture 里没有任何单是 item.agent === "none"，只有 waiting/working。
  const groups = groupItems(items, facets, "item.agent");
  expect(groups.map((g) => g.value)).not.toContain("none");
  expect(groups.every((g) => g.items.length > 0)).toBe(true);
});

// AGENT_ORDER 是个白名单，不是过滤器——排完已知值之后，没见过的值也该按出现顺序
// 追加一组，而不是把带着这个取值的单悄悄吞掉。
test("agent 取值不在 AGENT_ORDER 里时仍单独成组，不丢单", () => {
  const withUnknown = {
    a: [{ dim: "item.agent", value: "waiting" }],
    b: [{ dim: "item.agent", value: "blocked" }],
    c: [{ dim: "item.agent", value: "working" }],
  };
  const groups = groupItems(items, withUnknown, "item.agent");
  expect(groups.map((g) => g.value)).toEqual(["waiting", "working", "blocked"]);
  const blocked = groups.find((g) => g.value === "blocked");
  expect(blocked?.items.map((i) => i.id)).toEqual(["b"]);
});

test("没有筛选时原样返回", () => {
  expect(filterItems(items, facets, {}).map((i) => i.id)).toEqual(["a", "b", "c"]);
  expect(filterItems(items, facets, { "item.agent": [] }).map((i) => i.id)).toEqual(["a", "b", "c"]);
});

test("同一维度内多选是或", () => {
  const got = filterItems(items, facets, { "item.agent": ["waiting", "working"] });
  expect(got.map((i) => i.id)).toEqual(["a", "b", "c"]);
});

test("跨维度是与", () => {
  const got = filterItems(items, facets, {
    "item.agent": ["waiting"],
    "jira.status": ["In Progress"],
  });
  expect(got.map((i) => i.id)).toEqual(["a"]);
});

test("筛掉所有单时返回空表，不抛", () => {
  expect(filterItems(items, facets, { "item.agent": ["nope"] })).toEqual([]);
});

test("没有 facet 记录的单在有筛选时被筛掉", () => {
  const got = filterItems([...items, { id: "d", title: "丁" }], facets, {
    "item.agent": ["waiting"],
  });
  expect(got.map((i) => i.id)).toEqual(["a", "c"]);
});

/**
 * 存下来的筛选要跟当前数据对账。
 *
 * chips 只画 `valuesOf` —— 当前数据里真实存在的取值。一旦某个被选中的取值从数据里
 * 消失（工单状态变了、同步换了一批单），它就变成一个**看不见、点不掉、却仍在生效**
 * 的筛选：页面被筛空，屏幕上却没有任何一个 chip 是选中态，用户无从知道发生了什么。
 *
 * 这跟"移除字段时要连它的选择一起清掉"是同一个失败模式，只是走的另一条路——那次
 * 是字段被拿掉，这次是取值自己没了。
 */

test("当前数据里还在的取值原样保留", () => {
  const got = pruneSelection(facets, { "item.agent": ["waiting"] });
  expect(got).toEqual({ "item.agent": ["waiting"] });
});

test("数据里已经没有的取值被丢掉", () => {
  const got = pruneSelection(facets, { "jira.status": ["In Progress", "Done"] });
  expect(got).toEqual({ "jira.status": ["In Progress"] });
});

// 这条就是用户真实遇到的那一幕：筛选把页面清空，而没有一个 chip 是选中的。
test("一个维度的取值全没了，这个维度整条丢掉，而不是留一个空数组", () => {
  const got = pruneSelection(facets, { "jira.status": ["Done"] });
  expect(got).toEqual({});
});

test("维度本身在数据里消失了，也整条丢掉", () => {
  const got = pruneSelection(facets, { "gone.dim": ["x"] });
  expect(got).toEqual({});
});

test("空选择原样返回空", () => {
  expect(pruneSelection(facets, {})).toEqual({});
});

test("没有数据时一切都对不上账，返回空", () => {
  expect(pruneSelection({}, { "item.agent": ["waiting"] })).toEqual({});
});

// 对账之后再筛，结果必须是"筛选自动放宽了"，不是"页面空了"。
test("对账后再筛，失效的取值不再把页面筛空", () => {
  const stale = { "jira.status": ["Done"] };
  expect(filterItems(items, facets, stale)).toEqual([]);
  expect(filterItems(items, facets, pruneSelection(facets, stale)).length).toBe(items.length);
});
