import { test, expect } from "bun:test";
import { diffSessions, type Snapshot } from "./diff";
import type { SessionSummary } from "../tmux/session-list";

/** 只填比对用得到的字段，其余补成合法值。 */
function session(over: Partial<SessionSummary> & { sessionId: string; name: string }): SessionSummary {
  return {
    windowWidth: 80, windowHeight: 24, lastActivityEpoch: 0, attached: false,
    preview: [], pendingInput: null, idle: false, pinned: false, claudeId: null,
    task: null, path: "/tmp", lastAction: null, turn: null, agent: null,
    agentLabel: null, version: null, ...over,
  };
}

test("第一次看见的会话发 created", () => {
  const { drafts, next } = diffSessions(new Map(), [
    session({ sessionId: "$1", name: "alpha", path: "/p", agent: "claude", agentLabel: "Claude Code" }),
  ]);
  expect(drafts).toEqual([{
    type: "session.created", session: "alpha",
    data: { sessionId: "$1", path: "/p", agent: "claude", agentLabel: "Claude Code" },
  }]);
  expect(next.get("$1")).toEqual({ name: "alpha", state: "working" });
});

test("消失的会话发 ended", () => {
  const prev = new Map<string, Snapshot>([["$1", { name: "alpha", state: "working" }]]);
  const { drafts, next } = diffSessions(prev, []);
  expect(drafts).toEqual([
    { type: "session.ended", session: "alpha", data: { sessionId: "$1" } },
  ]);
  expect(next.size).toBe(0);
});

/**
 * 去重的全部机制就在这里：状态没变就没有事件。这是"两个生产者谁先发现谁发"能够
 * 成立的原因——不需要时间窗，不需要知道是谁发过。
 */
test("什么都没变就不发事件", () => {
  const prev = new Map<string, Snapshot>([["$1", { name: "alpha", state: "waiting" }]]);
  const { drafts } = diffSessions(prev, [
    session({ sessionId: "$1", name: "alpha", turn: "waiting" }),
  ]);
  expect(drafts).toEqual([]);
});

test("轮次变了发 session.turn，带上前一个状态", () => {
  const prev = new Map<string, Snapshot>([["$1", { name: "alpha", state: "working" }]]);
  const { drafts } = diffSessions(prev, [
    session({ sessionId: "$1", name: "alpha", turn: "waiting" }),
  ]);
  expect(drafts).toEqual([{
    type: "session.turn", session: "alpha",
    data: { sessionId: "$1", turn: "waiting", previous: "working" },
  }]);
});

/**
 * 改名靠 `sessionId` 认人。用名字当主键的话，一次改名会变成"一个死了、一个新生"，
 * 而任何按会话名记账的客户端都会丢掉它攒下来的东西。
 */
test("id 不变名字变了发 renamed", () => {
  const prev = new Map<string, Snapshot>([["$1", { name: "alpha", state: "working" }]]);
  const { drafts, next } = diffSessions(prev, [
    session({ sessionId: "$1", name: "beta" }),
  ]);
  expect(drafts).toEqual([{
    type: "session.renamed", session: "beta",
    data: { sessionId: "$1", previousName: "alpha" },
  }]);
  expect(next.get("$1")?.name).toBe("beta");
});

test("同一轮里改名又换了轮次，两条都发", () => {
  const prev = new Map<string, Snapshot>([["$1", { name: "alpha", state: "working" }]]);
  const { drafts } = diffSessions(prev, [
    session({ sessionId: "$1", name: "beta", turn: "waiting" }),
  ]);
  expect(drafts.map((d) => d.type)).toEqual(["session.renamed", "session.turn"]);
});

/** ended 排在最后，一轮里既有新生又有死亡时顺序才是确定的。 */
test("新生排在死亡之前", () => {
  const prev = new Map<string, Snapshot>([["$1", { name: "alpha", state: "working" }]]);
  const { drafts } = diffSessions(prev, [session({ sessionId: "$2", name: "gamma" })]);
  expect(drafts.map((d) => d.type)).toEqual(["session.created", "session.ended"]);
});

/** 没有 turn 的会话（不是 Claude，或没有绑定记录）只能靠屏幕标记，这条路必须活着。 */
test("没有 turn 时用 idle 推状态", () => {
  const { next } = diffSessions(new Map(), [
    session({ sessionId: "$1", name: "alpha", turn: null, idle: true }),
  ]);
  expect(next.get("$1")?.state).toBe("waiting");
});
