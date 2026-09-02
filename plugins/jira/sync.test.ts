import { test, expect } from "bun:test";
import { syncIssues, MAX_SYNC_ITEMS } from "./sync";
import type { Issue } from "./client";

const issue = (key: string, summary = `标题 ${key}`): Issue =>
  ({ id: key, key, summary, status: "In Progress", statusCategory: "indeterminate", updated: 0, type: "Task", parent: null }) as Issue;

/** 记下被要求建/更新的东西，并按调用方给的 created 回答。 */
function recorder(createdKeys: string[] = []) {
  const seen: Array<{ ref: string; title: string }> = [];
  return {
    seen,
    ensure: async (ref: string, title: string) => {
      seen.push({ ref, title });
      return { created: createdKeys.includes(ref) };
    },
  };
}

test("空表同步出零", async () => {
  const r = recorder();
  expect(await syncIssues([], r.ensure)).toEqual({ created: 0, updated: 0, total: 0, truncated: false });
});

test("每条工单都过一次 ensure，带上标题", async () => {
  const r = recorder();
  await syncIssues([issue("EXAMPLE-1"), issue("EXAMPLE-2")], r.ensure);
  expect(r.seen).toEqual([
    { ref: "EXAMPLE-1", title: "标题 EXAMPLE-1" },
    { ref: "EXAMPLE-2", title: "标题 EXAMPLE-2" },
  ]);
});

test("新建与更新分开计数", async () => {
  const r = recorder(["EXAMPLE-1"]);
  const got = await syncIssues([issue("EXAMPLE-1"), issue("EXAMPLE-2")], r.ensure);
  expect(got).toEqual({ created: 1, updated: 1, total: 2, truncated: false });
});

// 一条写错的 JQL 能返回几千条，而 items.json 是纯文本全量读写。
test("超过上限就截断", async () => {
  const many = Array.from({ length: MAX_SYNC_ITEMS + 5 }, (_, i) => issue(`E-${i}`));
  const r = recorder();
  const got = await syncIssues(many, r.ensure);
  expect(r.seen.length).toBe(MAX_SYNC_ITEMS);
  expect(got.total).toBe(MAX_SYNC_ITEMS);
  expect(got.truncated).toBe(true);
});

// 静默截断会让页面看起来像"就这么多"——「我们没问到」和「没有」是两回事。
test("没超过上限时 truncated 是 false", async () => {
  const r = recorder();
  expect((await syncIssues([issue("E-1")], r.ensure)).truncated).toBe(false);
});

test("某一条 ensure 抛了，其余照常同步", async () => {
  const seen: string[] = [];
  const ensure = async (ref: string) => {
    if (ref === "BAD") throw new Error("boom");
    seen.push(ref);
    return { created: true };
  };
  const got = await syncIssues([issue("E-1"), issue("BAD"), issue("E-2")], ensure);
  expect(seen).toEqual(["E-1", "E-2"]);
  expect(got.total).toBe(2);
});
