import { test, expect } from "bun:test";
import { matches, options, epicOf, NO_FILTERS, filtersFromSearch, searchOfFilters } from "../plugins/jira/public/filter.js";

/**
 * 工单列表的筛选。
 *
 * 两条容易写错的：史诗只能认层级 ≥ 1 的父级（`parent` 字段同时装着子任务的父任务），
 * 以及每一维的计数要在其它维筛过之后算——否则点下去会剩 0 条，而数字说有 5 条。
 */

const issue = (over: Record<string, unknown> = {}) => ({
  key: "EXAMPLE-1",
  status: "To Do",
  parent: null,
  ...over,
});

const epic = (key: string) => ({ key, summary: "", hierarchy: 1 });
const task = (key: string) => ({ key, summary: "", hierarchy: 0 });

test("不筛时全部通过", () => {
  expect(matches(issue(), NO_FILTERS)).toBe(true);
});

test("按史诗筛", () => {
  const i = issue({ parent: epic("EXAMPLE-100") });
  expect(matches(i, { epic: "EXAMPLE-100", status: "" })).toBe(true);
  expect(matches(i, { epic: "EXAMPLE-200", status: "" })).toBe(false);
});

test("子任务的父任务不算史诗", () => {
  // parent 字段同时装着这两种，混为一谈会筛出一堆名不副实的分组。
  const sub = issue({ parent: task("EXAMPLE-9") });
  expect(epicOf(sub)).toBe("");
  expect(matches(sub, { epic: "EXAMPLE-9", status: "" })).toBe(false);
});

test("按状态筛，两维可以叠加", () => {
  const i = issue({ status: "In Progress", parent: epic("E-1") });
  expect(matches(i, { epic: "E-1", status: "In Progress" })).toBe(true);
  expect(matches(i, { epic: "E-1", status: "To Do" })).toBe(false);
});

test("可选项按数量从多到少排", () => {
  const list = [
    issue({ status: "To Do" }),
    issue({ status: "In Progress" }),
    issue({ status: "In Progress" }),
  ];
  expect(options(list, NO_FILTERS).statuses).toEqual([
    ["In Progress", 2],
    ["To Do", 1],
  ]);
});

test("一维的计数在另一维筛过之后算——点下去会剩几条就显示几条", () => {
  const list = [
    issue({ status: "To Do", parent: epic("E-1") }),
    issue({ status: "To Do", parent: epic("E-2") }),
    issue({ status: "QA", parent: epic("E-2") }),
  ];
  // 已经选了 E-2，那么状态那一维只该数 E-2 底下的。
  expect(options(list, { epic: "E-2", status: "" }).statuses).toEqual([
    ["QA", 1],
    ["To Do", 1],
  ]);
  // 而史诗那一维要忽略自己的选择，否则选中之后别的史诗就消失了、再也切不过去。
  expect(options(list, { epic: "E-2", status: "" }).epics.map((e) => e[0]).sort()).toEqual(["E-1", "E-2"]);
});

test("没有史诗的工单不出现在史诗选项里", () => {
  expect(options([issue(), issue()], NO_FILTERS).epics).toEqual([]);
});

test("筛选在地址栏和状态之间往返", () => {
  expect(filtersFromSearch("?epic=ABC-1&status=In+Progress")).toEqual({ epic: "ABC-1", status: "In Progress" });
  expect(filtersFromSearch("")).toEqual(NO_FILTERS);
  expect(filtersFromSearch("?target=x")).toEqual(NO_FILTERS);
  expect(searchOfFilters(NO_FILTERS)).toBe("");
  expect(searchOfFilters({ epic: "ABC-1", status: "In Progress" })).toBe("epic=ABC-1&status=In+Progress");
  // 往返：空格、中文和 & 都得原样回来，不然分享出去的链接筛的是别的东西。
  const filters = { epic: "&x=1", status: "待办 / 进行中" };
  expect(filtersFromSearch("?" + searchOfFilters(filters))).toEqual(filters);
});
