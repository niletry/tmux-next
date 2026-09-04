import { test, expect } from "bun:test";
import { tableColumns, facetsIn, FIXED_DIMS } from "../public/item-table.js";

const f = (dim: string, value: string) => ({ dim, value });

test("列表里的 facet chip 就是已加的筛选字段", () => {
  expect(tableColumns(["jira.status", "jira.epic"], ["jira.epic", "jira.status"]))
    .toEqual(["jira.epic", "jira.status"]);
});

// 存下来的字段是原样保留的（一个维度暂时不在这批单里不该被抹掉），所以这一步
// 必须自己对账——否则会画出一颗永远空着的 chip。
test("数据里已经没有的维度不画成 chip", () => {
  expect(tableColumns(["jira.status"], ["jira.status", "jira.epic"])).toEqual(["jira.status"]);
});

// item.agent / item.sessions 已经各有固定的画法。它们同时也是可以加进筛选区的
// 维度，加了就会画出两颗一模一样的东西。
test("跟固定位置重复的维度不再单独成 chip", () => {
  expect(tableColumns(["item.agent", "item.sessions", "jira.status"],
    ["item.agent", "item.sessions", "jira.status"])).toEqual(["jira.status"]);
  expect(FIXED_DIMS).toContain("item.agent");
});

test("重复的字段只画一颗 chip", () => {
  expect(tableColumns(["jira.status"], ["jira.status", "jira.status"])).toEqual(["jira.status"]);
});

// 半新半旧的后端、隐私窗口里读不出 localStorage——两个入参都可能是空。
test("空输入不炸", () => {
  expect(tableColumns([], [])).toEqual([]);
  // @ts-expect-error 故意传 undefined：loadFields 兜底之外的最后一道
  expect(tableColumns(undefined, undefined)).toEqual([]);
});

test("一个维度可以有多个取值，取的是全部", () => {
  const list = [f("item.tag", "紧急"), f("item.tag", "前端"), f("jira.status", "In Progress")];
  expect(facetsIn(list, "item.tag").map((x) => x.value)).toEqual(["紧急", "前端"]);
  expect(facetsIn(list, "jira.status").map((x) => x.value)).toEqual(["In Progress"]);
  expect(facetsIn(list, "nope")).toEqual([]);
  expect(facetsIn(undefined, "item.tag")).toEqual([]);
});
