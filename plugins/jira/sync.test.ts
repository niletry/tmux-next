import { test, expect } from "bun:test";
import { syncIssues } from "./sync";
import type { Issue } from "./client";

const issue = (key: string, summary = `标题 ${key}`, created = 0): Issue =>
  ({ id: key, key, summary, status: "In Progress", statusCategory: "indeterminate", updated: 0, created, type: "Task", parent: null }) as Issue;

/** 记下被要求建/更新的东西，并按调用方给的 created 回答。 */
function recorder(createdKeys: string[] = []) {
  const seen: Array<{ ref: string; title: string; createdAt?: number }> = [];
  return {
    seen,
    ensure: async (ref: string, title: string, createdAt?: number) => {
      seen.push({ ref, title, createdAt });
      return { created: createdKeys.includes(ref) };
    },
  };
}

test("空表同步出零", async () => {
  const r = recorder();
  expect(await syncIssues({ issues: [], truncated: false }, r.ensure)).toEqual({
    created: 0,
    updated: 0,
    total: 0,
    truncated: false,
  });
});

test("每条工单都过一次 ensure，带上标题", async () => {
  const r = recorder();
  await syncIssues({ issues: [issue("EXAMPLE-1"), issue("EXAMPLE-2")], truncated: false }, r.ensure);
  expect(r.seen).toEqual([
    { ref: "EXAMPLE-1", title: "标题 EXAMPLE-1" },
    { ref: "EXAMPLE-2", title: "标题 EXAMPLE-2" },
  ]);
});

test("新建与更新分开计数", async () => {
  const r = recorder(["EXAMPLE-1"]);
  const got = await syncIssues({ issues: [issue("EXAMPLE-1"), issue("EXAMPLE-2")], truncated: false }, r.ensure);
  expect(got).toEqual({ created: 1, updated: 1, total: 2, truncated: false });
});

// truncated 原样从 fetchIssues 的判断透传出来——sync.ts 不再自己另设一个更小
// 的上限去二次截断：这个仓库自己的 Jira 实例装到 249 条匹配工单后，曾经的
// MAX_SYNC_ITEMS=200 比这还小，导致排在后面的工单永远同步不到、且没有提示。
test("truncated 原样透传，不在这里另截一刀", async () => {
  const many = Array.from({ length: 300 }, (_, i) => issue(`E-${i}`));
  const r = recorder();
  const got = await syncIssues({ issues: many, truncated: true }, r.ensure);
  expect(r.seen.length).toBe(300);
  expect(got.total).toBe(300);
  expect(got.truncated).toBe(true);
});

// 静默截断会让页面看起来像"就这么多"——「我们没问到」和「没有」是两回事。
test("fetchIssues 说没截断时 truncated 是 false", async () => {
  const r = recorder();
  expect((await syncIssues({ issues: [issue("E-1")], truncated: false }, r.ensure)).truncated).toBe(false);
});

// 排序要靠得住的是工单真正的创建时间，不是"我们几点钟同步到它的"——见
// src/items.ts 的 ensureItemForSource 那条同样的注释。
test("把工单真正的创建时间（毫秒转秒）传给 ensure", async () => {
  const r = recorder();
  await syncIssues({ issues: [issue("E-1", "标题", 1700000000000)], truncated: false }, r.ensure);
  expect(r.seen[0]?.createdAt).toBe(1700000000);
});

test("created 解析不出来（0）时不传，让调用方退回它自己的默认", async () => {
  const r = recorder();
  await syncIssues({ issues: [issue("E-1", "标题", 0)], truncated: false }, r.ensure);
  expect(r.seen[0]?.createdAt).toBeUndefined();
});

test("某一条 ensure 抛了，其余照常同步", async () => {
  const seen: string[] = [];
  const ensure = async (ref: string) => {
    if (ref === "BAD") throw new Error("boom");
    seen.push(ref);
    return { created: true };
  };
  const got = await syncIssues({ issues: [issue("E-1"), issue("BAD"), issue("E-2")], truncated: false }, ensure);
  expect(seen).toEqual(["E-1", "E-2"]);
  expect(got.total).toBe(2);
});
