import { test, expect } from "bun:test";
import { facetsFor } from "./server";
import type { Issue } from "./client";
import type { DevResult } from "./dev";
import type { ItemRef } from "../types";

/**
 * 这条路每次页面加载都跑，预算 300ms——所以 enrich 只读已有缓存，绝不发请求。
 * 缓存没命中就少给几个维度，那是正确的降级。这份测试因此把缓存作为参数喂进来。
 *
 * 史诗字段：Issue 上没有 `epicName`，史诗是通过 `parent` 字段表达的——对普通工单，
 * `parent.hierarchy >= 1` 就是它的史诗（见 client.ts 的注释和 public/filter.js 的
 * `epicKeyOf`）。所以这里用 `issue.parent`，不是往 Issue 上加字段。
 */

const jiraItem: ItemRef = { id: "it-1", source: { provider: "jira", ref: "EXAMPLE-1" } };
const localItem: ItemRef = { id: "it-2", source: null };

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: "10001",
    key: "EXAMPLE-1",
    summary: "修登录页",
    status: "In Progress",
    statusCategory: "indeterminate",
    updated: 0,
    type: "Task",
    hierarchy: 0,
    parent: null,
    ...over,
  } as Issue;
}

const dims = (facets: ReturnType<typeof facetsFor>) =>
  Object.fromEntries(facets.map((f) => [f.dim, f.value]));

test("没有来源的单，一个维度都不给", () => {
  expect(facetsFor(localItem, new Map(), new Map())).toEqual([]);
});

test("来源不是 jira 的单，一个维度都不给", () => {
  const other: ItemRef = { id: "it-3", source: { provider: "github", ref: "12" } };
  expect(facetsFor(other, new Map([["EXAMPLE-1", issue()]]), new Map())).toEqual([]);
});

// 缓存没命中就少给几个维度，而不是阻塞、也不是给陈旧值。
test("缓存里没有这个单号时，不给维度也不抛", () => {
  expect(facetsFor(jiraItem, new Map(), new Map())).toEqual([]);
});

test("有工单就给状态", () => {
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue()]]), new Map());
  expect(dims(got)["jira.status"]).toBe("In Progress");
});

test("已完成的工单，状态给 dim 色", () => {
  const got = facetsFor(
    jiraItem,
    new Map([["EXAMPLE-1", issue({ status: "Done", statusCategory: "done" })]]),
    new Map(),
  );
  expect(got.find((f) => f.dim === "jira.status")!.tone).toBe("dim");
});

test("进行中的工单，状态给 ok 色", () => {
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue()]]), new Map());
  expect(got.find((f) => f.dim === "jira.status")!.tone).toBe("ok");
});

test("有史诗父级就给史诗名", () => {
  const got = facetsFor(
    jiraItem,
    new Map([["EXAMPLE-1", issue({ parent: { key: "EXAMPLE-9", summary: "登录改版", hierarchy: 1 } })]]),
    new Map(),
  );
  expect(dims(got)["jira.epic"]).toBe("登录改版");
});

test("子任务的父级是普通任务，不算史诗", () => {
  const got = facetsFor(
    jiraItem,
    new Map([["EXAMPLE-1", issue({ parent: { key: "EXAMPLE-2", summary: "父任务", hierarchy: 0 } })]]),
    new Map(),
  );
  expect(dims(got)["jira.epic"]).toBeUndefined();
});

test("PR 数按 dev 缓存给", () => {
  const dev: DevResult = {
    ok: true,
    hidden: 0,
    prs: [
      { id: "1", title: "a", url: "u", branch: "b", updated: 0, status: "OPEN", checks: [], checksKnown: true },
      { id: "2", title: "b", url: "u", branch: "b", updated: 0, status: "OPEN", checks: [], checksKnown: true },
    ],
  };
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue()]]), new Map([["10001", dev]]));
  expect(dims(got)["jira.prs"]).toBe("2");
});

test("检查全过给 ok 色", () => {
  const dev: DevResult = {
    ok: true,
    hidden: 0,
    prs: [
      {
        id: "1", title: "a", url: "u", branch: "b", updated: 0, status: "OPEN", checksKnown: true,
        checks: [{ name: "ci", state: "SUCCESSFUL", url: "u" }, { name: "lint", state: "SUCCESSFUL", url: "u" }],
      },
    ],
  };
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue()]]), new Map([["10001", dev]]));
  const checks = got.find((f) => f.dim === "jira.checks")!;
  expect(checks.value).toBe("0/2");
  expect(checks.tone).toBe("ok");
});

test("有检查失败给 warn 色", () => {
  const dev: DevResult = {
    ok: true,
    hidden: 0,
    prs: [
      {
        id: "1", title: "a", url: "u", branch: "b", updated: 0, status: "OPEN", checksKnown: true,
        checks: [{ name: "ci", state: "FAILED", url: "u" }, { name: "lint", state: "SUCCESSFUL", url: "u" }],
      },
    ],
  };
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue()]]), new Map([["10001", dev]]));
  const checks = got.find((f) => f.dim === "jira.checks")!;
  expect(checks.value).toBe("1/2");
  expect(checks.tone).toBe("warn");
});

// 「没问到」和「没有检查」是两回事，收成一个会让页面往好看的方向撒谎。
test("checksKnown 为 false 时不产检查维度", () => {
  const dev: DevResult = {
    ok: true,
    hidden: 0,
    prs: [{
      id: "1", title: "a", url: "u", branch: "b", updated: 0, status: "OPEN", checksKnown: false,
      // 非空 checks 是关键：checksKnown:false 配空数组时，「没问到」和
      // 「问到了、答案是零个检查」在计数上分不出来，这条测试就测不出丢过滤
      // 条件的回归。这里给两条真实的 checks，只有真的按 checksKnown 过滤才
      // 会不产出 jira.checks。
      checks: [{ name: "ci", state: "SUCCESSFUL", url: "u" }, { name: "lint", state: "FAILED", url: "u" }],
    }],
  };
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue()]]), new Map([["10001", dev]]));
  expect(dims(got)["jira.checks"]).toBeUndefined();
  expect(dims(got)["jira.prs"]).toBe("1");
});

test("dev 缓存里是失败结果时，只是没有 PR 维度", () => {
  const dev: DevResult = { ok: false, reason: "auth" };
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue()]]), new Map([["10001", dev]]));
  expect(dims(got)["jira.prs"]).toBeUndefined();
  expect(dims(got)["jira.status"]).toBe("In Progress");
});

test("有 assignee 就给一个维度", () => {
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue({ assignee: "李雷" } as Partial<Issue>)]]), new Map());
  expect(dims(got)["jira.assignee"]).toBe("李雷");
});

test("没有 assignee 就不给这个维度", () => {
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue({ assignee: null } as Partial<Issue>)]]), new Map());
  expect(dims(got)["jira.assignee"]).toBeUndefined();
});

// 数字说不出是哪个分支、开着还是并了。明细一行一个 PR。
test("PR 维度带出每个 PR 的标题、状态和链接", () => {
  const dev: DevResult = {
    ok: true,
    hidden: 0,
    prs: [
      { id: "1", title: "修登录页", url: "https://example.com/pr/1", branch: "b1",
        updated: 0, status: "OPEN", checks: [], checksKnown: true },
      { id: "2", title: "", url: "https://example.com/pr/2", branch: "feature/EXAMPLE-1",
        updated: 0, status: "MERGED", checks: [], checksKnown: true },
      { id: "3", title: "废掉的", url: "https://example.com/pr/3", branch: "b3",
        updated: 0, status: "DECLINED", checks: [], checksKnown: true },
    ],
  };
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue()]]), new Map([["10001", dev]]));
  const rows = got.find((f) => f.dim === "jira.prs")!.detail!;

  expect(rows.map((r) => r.value)).toEqual(["OPEN", "MERGED", "DECLINED"]);
  expect(rows[0]!.url).toBe("https://example.com/pr/1");
  // 没标题的退回分支名——空标题会渲染成一行点不到的空白。
  expect(rows[1]!.label).toBe("feature/EXAMPLE-1");
  // 并了的压暗、拒了的报警、开着的不上色（列表里绝大多数是 OPEN，全染等于没染）。
  expect(rows.map((r) => r.tone)).toEqual([undefined, "dim", "warn"]);
});

// checksKnown 为 false 只影响 checks，不该把这个 PR 从 PR 列表里抹掉——
// "我们没问到它的检查"和"它不存在"是两回事。
test("问不到检查的 PR 仍然列在 PR 明细里", () => {
  const dev: DevResult = {
    ok: true,
    hidden: 0,
    prs: [
      { id: "1", title: "问不到", url: "https://example.com/pr/1", branch: "b1",
        updated: 0, status: "OPEN", checks: [], checksKnown: false },
    ],
  };
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue()]]), new Map([["10001", dev]]));
  expect(got.find((f) => f.dim === "jira.prs")!.detail!.length).toBe(1);
  expect(dims(got)["jira.checks"]).toBeUndefined();
});
