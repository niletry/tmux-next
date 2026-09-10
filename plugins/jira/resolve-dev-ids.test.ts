import { test, expect } from "bun:test";
import { resolveDevIds } from "./server";
import type { Issue } from "./client";

/**
 * `resolveDevIds` 存在的理由：增量同步的结果里只有"这次变了的那几条"，一个
 * 活跃绑定的单如果没变，就不在这次的结果里——但它仍然可能需要重刷一次
 * PR/CI（比如：单子本身没动，但它挂的 PR 刚跑完一次构建）。所以解析 id 不能只
 * 看这次的结果，要把上一次缓存的全量列表也算进去；只有两边都查不到才跳过
 * （今天对着一个未知单号的行为）。
 *
 * 抽成纯函数，跟 devTargets 是同一个理由：网络那半（真的去打 dev-status）
 * 测不了也不需要测，"该拿谁的 id"这一步的判断能且应该无头测。
 */

const issue = (key: string, id: string): Issue =>
  ({ id, key, summary: "", status: "", statusCategory: "", updated: 0, type: "", parent: null, assignee: null }) as Issue;

test("当次结果里有的，直接用当次的 id/key", () => {
  const current = [issue("A-1", "101")];
  const cached: Issue[] = [];
  expect(resolveDevIds(current, cached, ["A-1"])).toEqual([{ id: "101", key: "A-1" }]);
});

test("当次结果里没有（增量没问到这条，说明它没变），退回上次缓存的全量列表", () => {
  const current: Issue[] = []; // 这次没变的单不在增量结果里
  const cached = [issue("A-1", "101")];
  expect(resolveDevIds(current, cached, ["A-1"])).toEqual([{ id: "101", key: "A-1" }]);
});

test("两边都没有就跳过，不发明一个请求", () => {
  expect(resolveDevIds([], [], ["A-404"])).toEqual([]);
});

test("当次结果与缓存都有同一个 key 时，当次的更新（更可能是最新的）", () => {
  const current = [issue("A-1", "new-id")];
  const cached = [issue("A-1", "old-id")];
  expect(resolveDevIds(current, cached, ["A-1"])).toEqual([{ id: "new-id", key: "A-1" }]);
});

test("按 keys 的顺序输出，重复的 key 不重复输出", () => {
  const current = [issue("A-1", "101"), issue("A-2", "102")];
  expect(resolveDevIds(current, [], ["A-2", "A-1", "A-2"])).toEqual([
    { id: "102", key: "A-2" },
    { id: "101", key: "A-1" },
  ]);
});
