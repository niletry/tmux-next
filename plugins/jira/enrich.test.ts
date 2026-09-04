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
      { id: "1", title: "a", url: "u", branch: "b", destinationBranch: "", repo: "", updated: 0, status: "OPEN", checks: [], checksKnown: true },
      { id: "2", title: "b", url: "u", branch: "b", destinationBranch: "", repo: "", updated: 0, status: "OPEN", checks: [], checksKnown: true },
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
        id: "1", title: "a", url: "u", branch: "b", destinationBranch: "", repo: "", updated: 0, status: "OPEN", checksKnown: true,
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
        id: "1", title: "a", url: "u", branch: "b", destinationBranch: "", repo: "", updated: 0, status: "OPEN", checksKnown: true,
        checks: [{ name: "ci", state: "FAILED", url: "u" }, { name: "lint", state: "SUCCESSFUL", url: "u" }],
      },
    ],
  };
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue()]]), new Map([["10001", dev]]));
  const checks = got.find((f) => f.dim === "jira.checks")!;
  expect(checks.value).toBe("1/2");
  expect(checks.tone).toBe("warn");
});

// 一个单常挂着好几个 PR（多仓库改动、或重开过一次）——拉平成一条检查列表时
// 不能丢掉"这条检查属于哪个 PR"，明细行因此按 PR 分组。
test("检查明细按 PR 分组，group 是「仓库 #编号 · 源分支 → 目标分支 · 状态」", () => {
  const dev: DevResult = {
    ok: true,
    hidden: 0,
    prs: [
      {
        id: "1", title: "a", url: "u", branch: "fix/login", destinationBranch: "main",
        repo: "web-app", updated: 0, status: "OPEN", checksKnown: true,
        checks: [{ name: "ci/circleci: test", state: "SUCCESSFUL", url: "u" }],
      },
      {
        id: "2", title: "b", url: "u", branch: "fix/api", destinationBranch: "develop",
        repo: "backend", updated: 0, status: "MERGED", checksKnown: true,
        checks: [
          { name: "ci/circleci: build", state: "FAILED", url: "u" },
          { name: "ci/circleci: test", state: "SUCCESSFUL", url: "u" },
        ],
      },
    ],
  };
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue()]]), new Map([["10001", dev]]));
  const rows = got.find((f) => f.dim === "jira.checks")!.detail!;

  expect(rows.map((r) => r.group)).toEqual([
    "web-app #1 · fix/login → main · OPEN",
    "backend #2 · fix/api → develop · MERGED",
    "backend #2 · fix/api → develop · MERGED",
  ]);
  expect(rows.map((r) => r.label)).toEqual([
    "ci/circleci: test",
    "ci/circleci: build",
    "ci/circleci: test",
  ]);
});

// 老版本 dev-status 或字段缺失时 repo/destinationBranch 是空串——group 诚实地
// 缺那一段，不画空括号，也不该整条 group 消失（label/status 还在）。
test("缺目标分支或仓库名时，group 只留有的那几段", () => {
  const dev: DevResult = {
    ok: true,
    hidden: 0,
    prs: [
      {
        id: "1", title: "a", url: "u", branch: "fix/login", destinationBranch: "",
        repo: "", updated: 0, status: "OPEN", checksKnown: true,
        checks: [{ name: "ci", state: "SUCCESSFUL", url: "u" }],
      },
    ],
  };
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue()]]), new Map([["10001", dev]]));
  const rows = got.find((f) => f.dim === "jira.checks")!.detail!;
  expect(rows[0]!.group).toBe("#1 · fix/login · OPEN");
});

// 「没问到」和「没有检查」是两回事，收成一个会让页面往好看的方向撒谎。
test("checksKnown 为 false 时不产检查维度", () => {
  const dev: DevResult = {
    ok: true,
    hidden: 0,
    prs: [{
      id: "1", title: "a", url: "u", branch: "b", destinationBranch: "", repo: "", updated: 0, status: "OPEN", checksKnown: false,
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
      { id: "1", title: "修登录页", url: "https://example.com/pr/1", branch: "b1", destinationBranch: "", repo: "",
        updated: 0, status: "OPEN", checks: [], checksKnown: true },
      { id: "2", title: "", url: "https://example.com/pr/2", branch: "feature/EXAMPLE-1", destinationBranch: "", repo: "",
        updated: 0, status: "MERGED", checks: [], checksKnown: true },
      { id: "3", title: "废掉的", url: "https://example.com/pr/3", branch: "b3", destinationBranch: "", repo: "",
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
      { id: "1", title: "问不到", url: "https://example.com/pr/1", branch: "b1", destinationBranch: "", repo: "",
        updated: 0, status: "OPEN", checks: [], checksKnown: false },
    ],
  };
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue()]]), new Map([["10001", dev]]));
  expect(got.find((f) => f.dim === "jira.prs")!.detail!.length).toBe(1);
  expect(dims(got)["jira.checks"]).toBeUndefined();
});

/**
 * 工单类型这一维。
 *
 * 首页的单列表在此之前完全看不出一张单是史诗、缺陷还是子任务——只有工单号和一排
 * 状态 chip，而工单号本身不带类型。工单页早就按类型画了不同形状，首页没有，于是
 * 同一个东西在两个页面上长得不一样。
 *
 * 形状由插件给（一串 SVG 路径），不是图标名：内核不认识 epic，也不该认识——类型
 * 是 Jira 的概念，而且是开放集合。内核只套外壳并过一道白名单，见
 * src/plugin-enrich.test.ts。
 */
test("类型是第一个维度：先说这是什么，再说它到哪一步了", () => {
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue()]]), new Map());
  expect(got[0]!.dim).toBe("jira.type");
  expect(got[0]!.value).toBe("Task");
});

/**
 * 层级优先于名字。
 *
 * `hierarchy` 是 Jira 自己给的结构，改不掉；类型**名字**是每个实例自己定的，可以
 * 被改成任何东西（这个实例上就有中文的"任务"）。拿名字当主判据的话，一个把史诗
 * 改名叫 "Initiative" 的实例上，所有史诗都会掉成普通工单。
 */
test.each([
  [{ hierarchy: 1, type: "Initiative" }, "史诗按层级认，不按名字"],
  [{ hierarchy: 1, type: "史诗" }, "改成中文也认"],
])("%o：%s", (over) => {
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue(over as never)]]), new Map());
  const type = got.find((f) => f.dim === "jira.type")!;
  expect(type.icon).toBe('<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>');
});

test("子任务有自己的形状", () => {
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue({ hierarchy: -1 })]]), new Map());
  const type = got.find((f) => f.dim === "jira.type")!;
  expect(type.icon).toContain("<rect");
});

test.each([
  ["Bug", "circle"],
  ["Story", "M6 3h12v18"],
  ["Task", "<rect"],
  ["任务", "<rect"],
])("%s 有自己的形状", (name, mark) => {
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue({ type: name })]]), new Map());
  expect(got.find((f) => f.dim === "jira.type")!.icon).toContain(mark);
});

/**
 * 认不出来的类型不画图标，但仍然给出维度。
 *
 * 少画一个图标好过画错一个：一个实例可以有 "Spike"、"Chore"、"技术债" 这类自定义
 * 类型，随便挑一个形状套上去，等于告诉人一件不成立的事。而类型这个**词**本身
 * 永远是对的，所以 chip 照出。
 */
test("认不出来的类型：有维度，没形状", () => {
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue({ type: "Spike" })]]), new Map());
  const type = got.find((f) => f.dim === "jira.type")!;
  expect(type.value).toBe("Spike");
  expect(type.icon).toBeUndefined();
});
