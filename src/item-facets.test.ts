import { test, expect } from "bun:test";
import { kernelFacets } from "./item-facets";
import type { WorkItem } from "./items";
import type { SessionSummary } from "./tmux/session-list";
import type { ResolvedBinding } from "./session-binding";

/**
 * 内核的 facet 跟插件的走同一条路、同一种形状，于是视图层不需要知道一个维度是谁
 * 产的。这份测试盯的是取值的判断，不是格式。
 */

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "it-1",
    title: "修登录页",
    cwd: null,
    source: null,
    tags: [],
    createdAt: 0,
    closedAt: null,
    ...over,
  };
}

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    name: "甲",
    sessionId: "$1",
    windowWidth: 80,
    windowHeight: 24,
    lastActivityEpoch: 0,
    attached: false,
    preview: [],
    pendingInput: null,
    idle: false,
    pinned: false,
    claudeId: null,
    task: null,
    path: "/tmp/x",
    lastAction: null,
    turn: null,
    agent: null,
    ...over,
  } as SessionSummary;
}

const bind = (session: string, itemId: string, live = true): ResolvedBinding => ({
  session,
  itemId,
  live,
});

function dims(facets: Record<string, ReturnType<typeof kernelFacets>[string]>, id: string) {
  return Object.fromEntries((facets[id] ?? []).map((f) => [f.dim, f.value]));
}

test("没有会话的单，agent 维度是 none", () => {
  const got = kernelFacets([item()], [], []);
  expect(dims(got, "it-1")["item.agent"]).toBe("none");
});

test("有活着的会话但都不在跑，是 idle", () => {
  const got = kernelFacets([item()], [session({ turn: null, idle: true })], [bind("甲", "it-1")]);
  expect(dims(got, "it-1")["item.agent"]).toBe("idle");
});

test("turn 说在跑就是 working", () => {
  const got = kernelFacets([item()], [session({ turn: "working" })], [bind("甲", "it-1")]);
  expect(dims(got, "it-1")["item.agent"]).toBe("working");
});

// 一张单只要有一个会话在等你，整张单就该排在前面。
test("一个等你、一个在跑，整张单算等你", () => {
  const got = kernelFacets(
    [item()],
    [session({ name: "甲", turn: "working" }), session({ name: "乙", sessionId: "$2", turn: "waiting" })],
    [bind("甲", "it-1"), bind("乙", "it-1")],
  );
  expect(dims(got, "it-1")["item.agent"]).toBe("waiting");
});

test("等你的那条会话给 warn 色", () => {
  const got = kernelFacets([item()], [session({ turn: "waiting" })], [bind("甲", "it-1")]);
  expect(got["it-1"]!.find((f) => f.dim === "item.agent")!.tone).toBe("warn");
});

// turn 读不到时退回屏幕推出来的 idle，而不是当作没有状态。
test("没有 turn 时用 idle 兜底", () => {
  const got = kernelFacets([item()], [session({ turn: null, idle: false })], [bind("甲", "it-1")]);
  expect(dims(got, "it-1")["item.agent"]).toBe("working");
});

test("已经死掉的绑定不算数", () => {
  const got = kernelFacets([item()], [], [bind("甲", "it-1", false)]);
  expect(dims(got, "it-1")["item.agent"]).toBe("none");
});

test("会话条数只数活着的", () => {
  const got = kernelFacets(
    [item()],
    [session({ name: "甲" })],
    [bind("甲", "it-1"), bind("乙", "it-1", false)],
  );
  expect(dims(got, "it-1")["item.sessions"]).toBe("1");
});

test("目录只取最后一段", () => {
  const got = kernelFacets([item({ cwd: "/Users/x/projects/orbit" })], [], []);
  expect(dims(got, "it-1")["item.cwd"]).toBe("orbit");
});

test("没有目录就没有这个维度", () => {
  const got = kernelFacets([item({ cwd: null })], [], []);
  expect(dims(got, "it-1")["item.cwd"]).toBeUndefined();
});

test("来源维度给 provider 名", () => {
  const got = kernelFacets([item({ source: { provider: "jira", ref: "EXAMPLE-1" } })], [], []);
  expect(dims(got, "it-1")["item.source"]).toBe("jira");
});

test("每个标签一个 facet", () => {
  const got = kernelFacets([item({ tags: ["急", "前端"] })], [], []);
  const tags = got["it-1"]!.filter((f) => f.dim === "item.tag").map((f) => f.value);
  expect(tags).toEqual(["急", "前端"]);
});

test("多张单各算各的", () => {
  const got = kernelFacets(
    [item({ id: "it-1" }), item({ id: "it-2" })],
    [session({ turn: "waiting" })],
    [bind("甲", "it-1")],
  );
  expect(dims(got, "it-1")["item.agent"]).toBe("waiting");
  expect(dims(got, "it-2")["item.agent"]).toBe("none");
});
