import { test, expect } from "bun:test";
import jira from "./plugin.js";
import { devTargets } from "./server";

test("清单声明认领 jira 这个来源", () => {
  expect(jira.provides).toEqual(["jira"]);
});

/**
 * PR/检查只给**有活跃会话**的单拉。
 *
 * 全量拉是一个单一次 dev-status、每个 PR 再一次 Bitbucket——四十个单就是上百次
 * 请求。而你真正盯着 CI 的那个 PR，一定是你正开着会话在做的那个；请求数因此从
 * "你有多少工单"变成"你开着几个会话"。
 */
test("只挑有活跃绑定的单去拉 PR", () => {
  const items = [
    { id: "it-1", source: { provider: "jira", ref: "E-1" } },
    { id: "it-2", source: { provider: "jira", ref: "E-2" } },
    { id: "it-3", source: null },
  ];
  const bindings = [
    { session: "甲", itemId: "it-1", live: true },
    { session: "乙", itemId: "it-2", live: false },
  ];
  expect(devTargets(items as never, bindings as never)).toEqual(["E-1"]);
});

test("没有活跃会话时一个都不拉", () => {
  const items = [{ id: "it-1", source: { provider: "jira", ref: "E-1" } }];
  expect(devTargets(items as never, [] as never)).toEqual([]);
});
