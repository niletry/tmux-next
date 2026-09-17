# 事件流实施计划（第 1 期）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 tmux-next 能主动告诉客户端「有会话的状态变了」，而不是让每个客户端每五秒问一遍。

**Architecture:** 一条按需启停的服务端轮询循环把 `listSessions()` 的结果交给一个纯函数比对，
比对出的差异发布到一个进程内事件总线，总线扇出到 SSE 连接。总线、比对、SSE 流三者分开，
前两者不碰网络也不碰 tmux，可以纯逻辑测试。

**Tech Stack:** Bun、TypeScript、`bun:test`。无新增运行时依赖。

**Spec:** `docs/superpowers/specs/2026-09-17-headless-session-api-design.md`

## Global Constraints

- **只用 Bun，不加运行时依赖。** 本包的卖点之一是零服务端依赖。
- **每一次 tmux 调用都走 `tmux(argv)`（`src/tmux/run.ts`），绝不用 `Bun.$`。**
- **绝不 `tmux kill-server`，绝不杀不是本次运行创建的会话。** 清理只按精确名字
  `kill-session -t =<name>`。
- **孤儿断言按 `web-${process.pid}-` 收窄**，绝不数整台机器上的 `web-` 会话。
- **提交信息不带任何助手署名**，不写 `Co-Authored-By`、不写 `Claude-Session:`、不写
  `🤖 Generated with`。仓库是公开的，这些 trailer 会变成额外贡献者。
- **不跑裸 `bun test`**，它会挂住。按文件或按目录跑：`bun test src/events/`。
- **`bun` 在 `~/.bun/bin`，可能不在 PATH 里**，必要时用绝对路径。
- 在 worktree 里改代码，不在主检出里改。
- 新的磁盘状态路径要可用环境变量覆盖、在函数内惰性读取。本期不新增磁盘状态。

## 本期范围内 / 外

**内**：`stateOf` 提取成共享叶子模块、事件总线、会话比对、按需轮询、`GET /api/events`
（SSE）、`GET /api/capabilities`、`/api/notify` 发布 `session.attention`。

**外（明确留给后面几期）**：Webhook、会话资源整形（`include`、过滤、单会话读路由）、
终端契约、写操作。以及 **hook 加速 `session.turn`**：hook 只知道会话名而快照表按
`sessionId` 索引，要让两个生产者共用一张表需要一个名字到 id 的索引，而在 Webhook 存在
之前这点延迟没有收益。`attention` 不受影响，它是边沿不是状态，没有去重问题。

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/agents/session-state.ts` | 新建。`sessionState(session)`，`turn` 优先、退回 `idle` 那条规则的唯一实现。 |
| `src/items/facets.ts` | 改。删掉私有的 `stateOf`，改为引用上面那个。 |
| `src/events/types.ts` | 新建。事件信封与事件类型名。 |
| `src/events/bus.ts` | 新建。发布、订阅、环形缓冲、按 `Last-Event-ID` 补发。不碰网络不碰 tmux。 |
| `src/events/diff.ts` | 新建。纯函数：上一轮快照 + 这一轮会话列表 → 要发的事件 + 新快照。 |
| `src/events/poller.ts` | 新建。按需启停的轮询循环，把 `diff` 的产物喂给 `bus`。 |
| `src/events/sse.ts` | 新建。把一个订阅变成一个 `Response`（`ReadableStream` + 心跳）。 |
| `src/server.ts` | 改。挂 `GET /api/events`、`GET /api/capabilities`；`/api/notify` 改为发布到总线。 |

---

### Task 1: 把 `stateOf` 提取成共享叶子模块

轮询循环要判断一个会话是在等你还是在跑，用的必须和工单 facet 完全同一条规则。
`src/items/facets.ts:34` 的 `stateOf` 是模块私有的，第三个调用方出现意味着这条规则
要么被抄第三遍，要么提取出来。抄第三遍是这个仓库反复吃过亏的形状。

**Files:**
- Create: `src/agents/session-state.ts`
- Modify: `src/items/facets.ts:34-37`
- Test: `src/agents/session-state.test.ts`

**Interfaces:**
- Consumes: `SessionSummary`（`src/tmux/session-list.ts`）、`TurnState`（`src/agents/turn-state.ts`）
- Produces: `sessionState(session: Pick<SessionSummary, "turn" | "idle">): "waiting" | "working"`

- [ ] **Step 1: 写失败的测试**

```ts
// src/agents/session-state.test.ts
import { test, expect } from "bun:test";
import { sessionState } from "./session-state";

/**
 * `turn` 优先、`idle` 兜底这条规则原本在三处各写一遍（工单 facet、sessions 列表页、
 * 以及现在要加的轮询循环）。抽出来之后这个文件是它唯一的说明书。
 *
 * 最后一条是真正要钉住的：`turn` 存在时 `idle` 的值必须被完全忽略。反过来写——
 * 「idle 为真就算在等」——在大多数会话上给出相同答案，只在一个刚跑起来、屏幕上还
 * 留着上一轮空闲标记的会话上说错，而那恰好是最需要说对的时刻。
 */
test("turn 为 waiting 时算在等你", () => {
  expect(sessionState({ turn: "waiting", idle: false })).toBe("waiting");
});

test("turn 为 working 时算在跑", () => {
  expect(sessionState({ turn: "working", idle: true })).toBe("working");
});

test("没有 turn 时退回屏幕上的 idle 标记", () => {
  expect(sessionState({ turn: null, idle: true })).toBe("waiting");
  expect(sessionState({ turn: null, idle: false })).toBe("working");
});

test("turn 存在时 idle 被完全忽略", () => {
  expect(sessionState({ turn: "working", idle: true })).toBe("working");
  expect(sessionState({ turn: "waiting", idle: false })).toBe("waiting");
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `bun test src/agents/session-state.test.ts`
Expected: FAIL，`Cannot find module './session-state'`

- [ ] **Step 3: 写最小实现**

```ts
// src/agents/session-state.ts
import type { SessionSummary } from "../tmux/session-list";

/**
 * 一个会话此刻是在等你还是在跑。
 *
 * `turn` 优先：它从 transcript 的 `stop_reason` 读出来，是记录格式的一部分。读不到
 * 才退回 `idle`——那是认 TUI 屏幕上的空闲标记，会随 agent 改版无声失效，所以只当
 * 兜底，不当依据。
 *
 * 这条规则有三个消费者：工单 facet（`src/items/facets.ts`）、会话列表页
 * （`public/session-state.js`，浏览器侧的同一条规则）、以及事件流的轮询比对
 * （`src/events/diff.ts`）。它住在这里而不是其中任何一个里面，是因为三份实现
 * 只要有一份说得不一样，页面和事件流就会对同一个会话给出两种状态，而不会有任何
 * 东西变红。
 *
 * 注意 `idle` 是本仓库对"在提示符等你"这个状态的既定叫法，不是"闲置"。
 */
export function sessionState(
  session: Pick<SessionSummary, "turn" | "idle">,
): "waiting" | "working" {
  if (session.turn) return session.turn;
  return session.idle ? "waiting" : "working";
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/agents/session-state.test.ts`
Expected: PASS，4 个测试

- [ ] **Step 5: 改 `facets.ts` 引用它**

删掉 `src/items/facets.ts` 里第 34-37 行那个私有的 `stateOf` 函数和它上面的文档注释，
在文件顶部的 import 区加：

```ts
import { sessionState } from "../agents/session-state";
```

然后把该文件里所有 `stateOf(` 的调用改成 `sessionState(`。用以下命令确认没有漏网的：

```bash
grep -n "stateOf" src/items/facets.ts
```

Expected: 无输出

- [ ] **Step 6: 跑受影响的测试**

Run: `bun test src/items/ && bun run typecheck`
Expected: 全部 PASS

- [ ] **Step 7: 提交**

```bash
git add src/agents/session-state.ts src/agents/session-state.test.ts src/items/facets.ts
git commit -m "Move the turn-over-idle rule into a module the poller can share

A third caller is about to need it, and three copies of a rule that reads
two fields in a fixed order is the shape this repo has been bitten by: each
copy looks right on its own while disagreeing about one session, and nothing
goes red when they drift."
```

---

### Task 2: 事件信封与总线

**Files:**
- Create: `src/events/types.ts`, `src/events/bus.ts`
- Test: `src/events/bus.test.ts`

**Interfaces:**
- Produces:
  - `type EventType = "session.created" | "session.ended" | "session.renamed" | "session.turn" | "session.attention"`
  - `type EventDraft = { type: EventType; session: string; data: Record<string, unknown> }`
  - `type AppEvent = EventDraft & { id: string; seq: number; at: number }`
  - `publish(draft: EventDraft, at?: number): AppEvent`
  - `subscribe(fn: (event: AppEvent) => void): () => void`
  - `subscriberCount(): number`
  - `replayFrom(lastEventId: string | null): { ok: true; events: AppEvent[] } | { ok: false }`
  - `bootId(): string`
  - `resetBus(): void`

- [ ] **Step 1: 写失败的测试**

```ts
// src/events/bus.test.ts
import { test, expect, beforeEach } from "bun:test";
import { publish, subscribe, subscriberCount, replayFrom, bootId, resetBus } from "./bus";

beforeEach(() => resetBus());

test("订阅者收到发布的事件", () => {
  const seen: string[] = [];
  subscribe((e) => seen.push(e.type));
  publish({ type: "session.created", session: "a", data: {} });
  expect(seen).toEqual(["session.created"]);
});

test("取消订阅之后不再收到", () => {
  const seen: string[] = [];
  const off = subscribe((e) => seen.push(e.type));
  off();
  publish({ type: "session.created", session: "a", data: {} });
  expect(seen).toEqual([]);
  expect(subscriberCount()).toBe(0);
});

/**
 * 一个订阅者抛异常不能带走其余订阅者。SSE 扇出和（第 3 期的）Webhook 派发会是同一个
 * 总线上的两个订阅者，让一个接收方的失败静音掉另一个，是那种只在生产环境出现的故障。
 */
test("一个订阅者抛异常不影响其他订阅者", () => {
  const seen: string[] = [];
  subscribe(() => { throw new Error("boom"); });
  subscribe((e) => seen.push(e.type));
  publish({ type: "session.ended", session: "a", data: {} });
  expect(seen).toEqual(["session.ended"]);
});

test("seq 单调递增，id 带上 bootId", () => {
  const first = publish({ type: "session.created", session: "a", data: {} });
  const second = publish({ type: "session.ended", session: "a", data: {} });
  expect(second.seq).toBe(first.seq + 1);
  expect(first.id).toBe(`evt_${bootId()}_${first.seq}`);
});

test("按 Last-Event-ID 补发它之后的事件", () => {
  const first = publish({ type: "session.created", session: "a", data: {} });
  publish({ type: "session.turn", session: "a", data: {} });
  const got = replayFrom(first.id);
  expect(got.ok).toBe(true);
  if (!got.ok) throw new Error("unreachable");
  expect(got.events.map((e) => e.type)).toEqual(["session.turn"]);
});

test("没带 Last-Event-ID 是全新连接，不补发也不要求 resync", () => {
  publish({ type: "session.created", session: "a", data: {} });
  const got = replayFrom(null);
  expect(got).toEqual({ ok: true, events: [] });
});

/**
 * bootId 对不上意味着服务器重启过：seq 从头开始，旧 id 指向的位置在新进程里是另一个
 * 事件。这必须是 resync 而不是"补发 seq 之后的全部"，后者会把不相干的事件当成补发内容
 * 交给客户端，而客户端没有任何办法发现这件事。
 */
test("bootId 对不上要求 resync", () => {
  expect(replayFrom("evt_deadbeef_1")).toEqual({ ok: false });
});

test("形状不对的 Last-Event-ID 要求 resync", () => {
  expect(replayFrom("garbage")).toEqual({ ok: false });
});

/**
 * 注意这里要三条事件才构成缺口。客户端说"我看到第 1 条了"，那么第 1 条自己被挤出
 * 缓冲并不算丢——它要的是第 1 条**之后**的。只有当第 2 条也被挤掉、缓冲里最旧的是
 * 第 3 条时，中间才真的缺了东西。把这个测试写成两条事件会让它在一个正确的实现上
 * 失败，然后逼着人把判断改成"最旧的一条在不在"，那是错的。
 */
test("缺口被挤出缓冲时要求 resync", () => {
  const first = publish({ type: "session.created", session: "a", data: {} }, 1000);
  publish({ type: "session.turn", session: "a", data: {} }, 1000);
  // 缓冲按时间保留 300 秒；把时钟推过窗口，前两条都该被挤掉。
  publish({ type: "session.ended", session: "a", data: {} }, 1000 + 301);
  expect(replayFrom(first.id)).toEqual({ ok: false });
});

/** 挤出的是客户端已经看过的那条，不算缺口，照常补发。 */
test("只挤掉已看过的那条不算缺口", () => {
  const first = publish({ type: "session.created", session: "a", data: {} }, 1000);
  const second = publish({ type: "session.ended", session: "a", data: {} }, 1000 + 301);
  const got = replayFrom(first.id);
  expect(got).toEqual({ ok: true, events: [second] });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `bun test src/events/bus.test.ts`
Expected: FAIL，`Cannot find module './bus'`

- [ ] **Step 3: 写 `types.ts`**

```ts
// src/events/types.ts

/** 对外承诺的事件类型。新增要同步改 `/api/capabilities` 的 events 清单。 */
export type EventType =
  | "session.created"
  | "session.ended"
  | "session.renamed"
  | "session.turn"
  | "session.attention";

/** 生产者交给总线的东西：只说发生了什么，id / seq / 时间由总线盖。 */
export type EventDraft = {
  type: EventType;
  session: string;
  data: Record<string, unknown>;
};

/**
 * 投递给订阅者的信封。SSE 和（第 3 期的）Webhook 发的是同一个对象——一份定义、
 * 两种投递，两边就不可能对同一件事给出不同说法。
 *
 * `id` 用来去重，`seq` 用来发现缺口。两者不是冗余的：`id` 能让接收方认出重复投递，
 * 但认不出"有一条根本没送到"，而 Webhook 在重试耗尽时就是真的没送到。`seq` 跳号
 * 就是缺口。`id` 由 `seq` 加进程启动标识派生，所以没有第二个计数器要维护。
 */
export type AppEvent = EventDraft & {
  id: string;
  seq: number;
  /** epoch 秒，与会话资源的 `lastActivityEpoch` 同一单位。 */
  at: number;
};
```

- [ ] **Step 4: 写 `bus.ts`**

```ts
// src/events/bus.ts
import type { AppEvent, EventDraft } from "./types";

export type { AppEvent, EventDraft, EventType } from "./types";

/**
 * 进程内事件总线。
 *
 * 只有一个真相来源：所有投递方式（SSE 扇出、Web Push、第 3 期的 Webhook）都是这里
 * 的订阅者，所以它们不可能对同一件事给出不同说法。这是把推送直接写在 `/api/notify`
 * 里那个做法要改掉的原因。
 *
 * 缓冲按**时间**保留而不是按条数：客户端关心的是"我离开了多久"，不是"这期间发生了
 * 多少事"。条数上限只是一个防失控的保险丝，正常情况下够不着。
 */
const RETAIN_SECONDS = 300;
const MAX_BUFFERED = 2000;

/**
 * 每个进程一个启动标识，进了事件 id。
 *
 * 没有它，重启之后 seq 从 1 重新开始，而客户端手里那个 `Last-Event-ID` 会指向新进程
 * 里的另一条事件——补发出去的东西看着完全正常，客户端没有任何办法发现自己错过了
 * 什么。带上它，重启就变成一次明确的 resync。
 */
let boot = crypto.randomUUID().slice(0, 8);
let seq = 0;
let buffer: AppEvent[] = [];
const subscribers = new Set<(event: AppEvent) => void>();

export function bootId(): string {
  return boot;
}

export function subscriberCount(): number {
  return subscribers.size;
}

export function subscribe(fn: (event: AppEvent) => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** `at` 可注入，测试才能推动时钟去验证缓冲的挤出行为。 */
export function publish(
  draft: EventDraft,
  at: number = Math.floor(Date.now() / 1000),
): AppEvent {
  seq += 1;
  const event: AppEvent = { ...draft, id: `evt_${boot}_${seq}`, seq, at };

  buffer.push(event);
  const cutoff = at - RETAIN_SECONDS;
  buffer = buffer.filter((e) => e.at > cutoff);
  if (buffer.length > MAX_BUFFERED) buffer = buffer.slice(-MAX_BUFFERED);

  for (const fn of subscribers) {
    // 一个订阅者抛异常不能带走其余订阅者，也不能带走发布方。
    try {
      fn(event);
    } catch (e) {
      console.error("event subscriber failed", e);
    }
  }
  return event;
}

/**
 * 一个重连的客户端能拿到什么。
 *
 * `{ ok: false }` 是"我跟不上了，你自己去重新拉一次列表"，调用方把它翻译成一条
 * `resync`。三种情况都落在这一个答案上——没带过 id 以外的任何不认识的形状、
 * 别的进程发的 id、已经被挤出缓冲的 id——因为对客户端来说它们的处置完全一样，
 * 而假装区分它们只会让客户端多写三个分支去做同一件事。
 */
export function replayFrom(
  lastEventId: string | null,
): { ok: true; events: AppEvent[] } | { ok: false } {
  if (!lastEventId) return { ok: true, events: [] };

  const match = lastEventId.match(/^evt_([0-9a-f]+)_(\d+)$/);
  if (!match) return { ok: false };
  if (match[1] !== boot) return { ok: false };

  const from = Number(match[2]);
  // 缓冲里最旧的一条必须不晚于 from+1，否则中间有事件已经被挤掉了。
  const oldest = buffer[0];
  if (oldest && oldest.seq > from + 1) return { ok: false };
  return { ok: true, events: buffer.filter((e) => e.seq > from) };
}

/** 测试专用：把总线恢复成刚启动的样子。 */
export function resetBus(): void {
  boot = crypto.randomUUID().slice(0, 8);
  seq = 0;
  buffer = [];
  subscribers.clear();
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test src/events/bus.test.ts && bun run typecheck`
Expected: PASS，10 个测试

- [ ] **Step 6: 提交**

```bash
git add src/events/types.ts src/events/bus.ts src/events/bus.test.ts
git commit -m "Add the in-process event bus every delivery path will subscribe to

One definition of an event, and the ways of delivering it are subscribers
rather than parallel implementations, so SSE and a later webhook cannot end
up saying different things about the same change. Event ids carry a
per-process boot id: without it a restart resets the sequence and a
reconnecting client's saved id silently points at a different event."
```

---

### Task 3: 会话比对

**Files:**
- Create: `src/events/diff.ts`
- Test: `src/events/diff.test.ts`

**Interfaces:**
- Consumes: `sessionState`（Task 1）、`EventDraft`（Task 2）、`SessionSummary`
- Produces:
  - `type Snapshot = { name: string; state: "waiting" | "working" }`
  - `diffSessions(previous: Map<string, Snapshot>, current: SessionSummary[]): { drafts: EventDraft[]; next: Map<string, Snapshot> }`

- [ ] **Step 1: 写失败的测试**

```ts
// src/events/diff.test.ts
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
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `bun test src/events/diff.test.ts`
Expected: FAIL，`Cannot find module './diff'`

- [ ] **Step 3: 写实现**

```ts
// src/events/diff.ts
import { sessionState } from "../agents/session-state";
import type { SessionSummary } from "../tmux/session-list";
import type { EventDraft } from "./types";

/**
 * 上一轮看到的、关于一个会话的全部内容。
 *
 * 刻意只存名字和状态：快照存在的唯一目的是回答"这一轮和上一轮比有什么不一样"，
 * 存进来的每个字段都是一个以后要维护的比对分支。路径和 agent 只在 created 里发一次，
 * 因为它们不会变——`session_path` 用的是会话打开时的目录，pane 里 `cd` 不会移动它。
 */
export type Snapshot = { name: string; state: "waiting" | "working" };

/**
 * 纯函数，事件流的全部判断都在这里。
 *
 * 按 `sessionId`（tmux 的 `$7`）索引而不是按名字：改名时 id 不变，所以一次改名是一条
 * `renamed` 而不是一死一生。反过来 id 会在 tmux server 重启时重排，但那种重启会带走
 * 所有会话，于是上一轮的快照整体作废、这一轮整体是新生，结论依然正确。
 *
 * 去重不需要任何额外机制：这里发的都是**状态变化**，状态没变就没有事件。这正是
 * "轮询和 hook 谁先发现谁发"能够成立的原因，不需要时间窗，也不需要记住是谁发过。
 */
export function diffSessions(
  previous: Map<string, Snapshot>,
  current: SessionSummary[],
): { drafts: EventDraft[]; next: Map<string, Snapshot> } {
  const drafts: EventDraft[] = [];
  const next = new Map<string, Snapshot>();

  for (const s of current) {
    const state = sessionState(s);
    next.set(s.sessionId, { name: s.name, state });
    const before = previous.get(s.sessionId);

    if (!before) {
      drafts.push({
        type: "session.created",
        session: s.name,
        data: { sessionId: s.sessionId, path: s.path, agent: s.agent, agentLabel: s.agentLabel },
      });
      continue;
    }

    if (before.name !== s.name) {
      drafts.push({
        type: "session.renamed",
        session: s.name,
        data: { sessionId: s.sessionId, previousName: before.name },
      });
    }

    if (before.state !== state) {
      drafts.push({
        type: "session.turn",
        session: s.name,
        data: { sessionId: s.sessionId, turn: state, previous: before.state },
      });
    }
  }

  // 死亡排在最后，一轮里既有新生又有死亡时顺序才是确定的，测试才钉得住。
  for (const [sessionId, before] of previous) {
    if (next.has(sessionId)) continue;
    drafts.push({
      type: "session.ended",
      session: before.name,
      data: { sessionId },
    });
  }

  return { drafts, next };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/events/diff.test.ts && bun run typecheck`
Expected: PASS，8 个测试

- [ ] **Step 5: 提交**

```bash
git add src/events/diff.ts src/events/diff.test.ts
git commit -m "Derive session events by comparing snapshots, keyed by tmux session id

Deduplication falls out of comparing state rather than being a mechanism of
its own: unchanged means no event, so two producers can both watch and
whichever notices first is the one that reports, with no time window to tune.
Keying on the session id rather than the name is what makes a rename one
event instead of a death and a birth."
```

---

### Task 4: 按需启停的轮询循环

**Files:**
- Create: `src/events/poller.ts`
- Test: `src/events/poller.test.ts`

**Interfaces:**
- Consumes: `diffSessions`、`Snapshot`（Task 3）、`publish`（Task 2）、`listSessions`
- Produces:
  - `pollOnce(lister?: () => Promise<SessionSummary[]>, publishChanges?: boolean): Promise<number>`
  - `startPolling(opts?: { lister?: () => Promise<SessionSummary[]>; intervalMs?: number }): void`
  - `stopPolling(): void`
  - `pollingActive(): boolean`
  - `setPollLister(lister: (() => Promise<SessionSummary[]>) | null): void`
  - `resetPoller(): void`

- [ ] **Step 1: 写失败的测试**

```ts
// src/events/poller.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  pollOnce, startPolling, stopPolling, pollingActive, setPollLister, resetPoller,
} from "./poller";
import { subscribe, resetBus, type AppEvent } from "./bus";
import type { SessionSummary } from "../tmux/session-list";

function session(sessionId: string, name: string, turn: SessionSummary["turn"] = null): SessionSummary {
  return {
    sessionId, name, windowWidth: 80, windowHeight: 24, lastActivityEpoch: 0,
    attached: false, preview: [], pendingInput: null, idle: false, pinned: false,
    claudeId: null, task: null, path: "/tmp", lastAction: null, turn,
    agent: null, agentLabel: null, version: null,
  };
}

beforeEach(() => { resetBus(); resetPoller(); });
afterEach(() => { stopPolling(); });

test("一轮比对把差异发布到总线", async () => {
  const seen: AppEvent[] = [];
  subscribe((e) => seen.push(e));
  await pollOnce(async () => [session("$1", "alpha")]);
  expect(seen.map((e) => e.type)).toEqual(["session.created"]);
});

/** 快照是跨轮保留的，否则每一轮都会把所有会话重新报一遍 created。 */
test("第二轮没有变化就不发事件", async () => {
  const seen: AppEvent[] = [];
  subscribe((e) => seen.push(e));
  const lister = async () => [session("$1", "alpha")];
  await pollOnce(lister);
  await pollOnce(lister);
  expect(seen.length).toBe(1);
});

test("状态变了第二轮才发 turn", async () => {
  const seen: AppEvent[] = [];
  subscribe((e) => seen.push(e));
  await pollOnce(async () => [session("$1", "alpha", "working")]);
  await pollOnce(async () => [session("$1", "alpha", "waiting")]);
  expect(seen.map((e) => e.type)).toEqual(["session.created", "session.turn"]);
});

/**
 * 列举失败不能让循环死掉。tmux 可能正在重启，下一轮就好了；把这一轮的异常放出去会
 * 让定时器永久停摆，而症状是事件流安静下来，没有任何东西报错。
 */
test("列举抛异常时这一轮无事发生，不抛出去", async () => {
  const count = await pollOnce(async () => { throw new Error("tmux gone"); });
  expect(count).toBe(0);
});

test("列举失败不会清空快照", async () => {
  const seen: AppEvent[] = [];
  subscribe((e) => seen.push(e));
  await pollOnce(async () => [session("$1", "alpha")]);
  await pollOnce(async () => { throw new Error("tmux gone"); });
  await pollOnce(async () => [session("$1", "alpha")]);
  // 若失败那轮把快照清了，第三轮会再报一次 created。
  expect(seen.map((e) => e.type)).toEqual(["session.created"]);
});

/**
 * 起步时快照是空的，而机器上通常已经有十几个会话。若第一轮照常发布，刚连上的客户端
 * 会收到一串 `session.created`，说的是一件没有发生过的事——它们不是刚创建的，只是
 * 这个进程第一次看见。所以第一轮只填快照、不发事件。
 */
test("启动时先静默填一次快照，不把已有会话报成新生", async () => {
  const seen: AppEvent[] = [];
  subscribe((e) => seen.push(e));
  await pollOnce(async () => [session("$1", "alpha")], false);
  expect(seen).toEqual([]);
  // 但快照要填上了：下一轮的变化才是真变化。
  await pollOnce(async () => [session("$1", "alpha", "waiting")]);
  expect(seen.map((e) => e.type)).toEqual(["session.turn"]);
});

test("startPolling 会先静默填一次快照", async () => {
  const seen: AppEvent[] = [];
  subscribe((e) => seen.push(e));
  startPolling({ lister: async () => [session("$1", "alpha")], intervalMs: 10_000 });
  await Bun.sleep(20);
  expect(seen).toEqual([]);
});

test("setPollLister 注入的列举器会被 startPolling 采用", async () => {
  let calls = 0;
  setPollLister(async () => { calls += 1; return []; });
  startPolling({ intervalMs: 10_000 });
  await Bun.sleep(20);
  expect(calls).toBe(1);
});

test("启动和停止改变 pollingActive", () => {
  expect(pollingActive()).toBe(false);
  startPolling({ lister: async () => [], intervalMs: 10_000 });
  expect(pollingActive()).toBe(true);
  stopPolling();
  expect(pollingActive()).toBe(false);
});

/**
 * 用"填快照那一次列举跑了几遍"来判断，而不是用事件条数：起步的静默填充之后，一个
 * 没有变化的机器不会再产生任何事件，数事件就什么也数不出来。间隔设得远大于测试时长，
 * 于是唯一会发生的列举就是各自的起步填充——第二次 startPolling 一次都不该加。
 */
test("重复启动不会叠加出第二个定时器", async () => {
  let calls = 0;
  const lister = async () => { calls += 1; return [session("$1", "alpha")]; };
  startPolling({ lister, intervalMs: 10_000 });
  startPolling({ lister, intervalMs: 10_000 });
  await Bun.sleep(20);
  expect(calls).toBe(1);
  expect(pollingActive()).toBe(true);
});

test("停止之后不再产生事件", async () => {
  const seen: AppEvent[] = [];
  subscribe((e) => seen.push(e));
  let calls = 0;
  startPolling({ lister: async () => { calls += 1; return []; }, intervalMs: 10 });
  await Bun.sleep(35);
  stopPolling();
  const after = calls;
  await Bun.sleep(35);
  expect(calls).toBe(after);
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `bun test src/events/poller.test.ts`
Expected: FAIL，`Cannot find module './poller'`

- [ ] **Step 3: 写实现**

```ts
// src/events/poller.ts
import { listSessions, type SessionSummary } from "../tmux/session-list";
import { publish } from "./bus";
import { diffSessions, type Snapshot } from "./diff";

/**
 * 服务端的会话轮询循环。
 *
 * 这是新造的东西，不是把既有机制接起来：在此之前服务端**没有**任何会话轮询——
 * 浏览器每五秒自己调一次 `/api/sessions`（`public/list.js`、`public/items.js`），
 * 服务端唯一的定时器是 60 秒的孤儿回收。所以一台没有浏览器连着的 tmux-next 几乎
 * 什么都不做，而那恰恰是事件流最该工作的时刻。
 *
 * 代价是实打实的：`listSessions()` 为每个会话起一次 `capture-pane` 子进程，负载按
 * 会话数线性增长。所以这个循环由需求驱动启停（见 `src/events/sse.ts` 的订阅/退订），
 * 没人订阅时它不跑，服务回到原本的静息状态。让"没人关心就不烧 CPU"成为结构性的
 * 事实，比调一个间隔值去平衡要可靠。
 */
const DEFAULT_INTERVAL_MS = 5000;

let timer: ReturnType<typeof setInterval> | null = null;
let snapshot = new Map<string, Snapshot>();
let busy = false;
let injected: (() => Promise<SessionSummary[]>) | null = null;

export function pollingActive(): boolean {
  return timer !== null;
}

/**
 * 换掉列举器。测试用——`eventsResponse` 无参调 `startPolling()`，没有这个缝，
 * SSE 的单元测试就会去打真的 tmux。这和 `collectFacets` 把来源列表留成可选参数
 * 是同一个理由：注册表是编译期常量，不给一条注入的缝就没办法证明这里的行为。
 */
export function setPollLister(lister: (() => Promise<SessionSummary[]>) | null): void {
  injected = lister;
}

/**
 * 跑一轮，返回发出去的事件条数。
 *
 * 列举失败时这一轮什么也不做，**并且保留快照**。清空快照会让下一轮把每个会话都重报
 * 一次 created；把异常放出去会让定时器永久停摆，而症状只是事件流安静下来，不会有
 * 任何东西报错。tmux 短暂不可用（正在重启）是正常情况，不是需要惊动调用方的事。
 */
export async function pollOnce(
  lister: () => Promise<SessionSummary[]> = injected ?? listSessions,
  publishChanges = true,
): Promise<number> {
  let current: SessionSummary[];
  try {
    current = await lister();
  } catch (e) {
    console.error("session poll failed", e);
    return 0;
  }

  const { drafts, next } = diffSessions(snapshot, current);
  snapshot = next;
  if (!publishChanges) return 0;
  for (const draft of drafts) publish(draft);
  return drafts.length;
}

export function startPolling(opts?: {
  lister?: () => Promise<SessionSummary[]>;
  intervalMs?: number;
}): void {
  if (timer) return;
  const lister = opts?.lister ?? injected ?? listSessions;

  // 起步先静默填一次快照。不填的话，第一轮会把机器上已经存在的每个会话都报成
  // `session.created`——说的是一件没发生过的事，而刚连上的客户端没有任何办法
  // 分辨"刚创建"和"这个进程第一次看见"。
  //
  // 它也要占住 busy：一台会话很多的机器上这一次列举可能慢过间隔，不占住的话第一个
  // 定时器滴答会和它并行跑，两份比对写同一张快照。
  busy = true;
  void pollOnce(lister, false).finally(() => { busy = false; });

  timer = setInterval(() => {
    // 一轮还没跑完就不开下一轮：一台会话很多的机器上 `capture-pane` 可能慢过间隔，
    // 叠加起来只会让它更慢。
    if (busy) return;
    busy = true;
    void pollOnce(lister).finally(() => { busy = false; });
  }, opts?.intervalMs ?? DEFAULT_INTERVAL_MS);
}

export function stopPolling(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * 测试专用：把快照也清掉。
 *
 * `stopPolling` 刻意不清快照——真实运行里最后一个订阅者走开又回来，不该收到一份
 * 把所有会话重报一遍的 created。
 */
export function resetPoller(): void {
  stopPolling();
  snapshot = new Map();
  busy = false;
  injected = null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/events/poller.test.ts && bun run typecheck`
Expected: PASS，11 个测试

- [ ] **Step 5: 提交**

```bash
git add src/events/poller.ts src/events/poller.test.ts
git commit -m "Add the server-side session poll the event stream needs, started on demand

There was none before: the browser polls every five seconds and the server's
only timer is the orphan reaper, so an instance with nothing attached does
essentially nothing. That is exactly when an event stream is most wanted, so
this is new work with a real cost, and it runs only while something is
subscribed rather than always."
```

---

### Task 5: SSE 端点

**Files:**
- Create: `src/events/sse.ts`
- Modify: `src/server.ts`（在 `/api/notify` 之后、`/api/dirs` 之前挂上路由）
- Test: `src/events/sse.test.ts`

**Interfaces:**
- Consumes: `subscribe`、`replayFrom`、`AppEvent`（Task 2）、`startPolling`/`stopPolling`（Task 4）
- Produces: `eventsResponse(lastEventId: string | null): Response`

- [ ] **Step 1: 写失败的测试**

```ts
// src/events/sse.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { eventsResponse } from "./sse";
import { publish, resetBus, subscriberCount } from "./bus";
import { pollingActive, resetPoller, setPollLister } from "./poller";

beforeEach(() => {
  resetBus();
  resetPoller();
  // 没有这一行，`eventsResponse` 里的 `startPolling()` 会去列举真的 tmux 会话，
  // 让这个纯粹的流格式测试依赖开发机上恰好开着什么。
  setPollLister(async () => []);
});
afterEach(() => { resetPoller(); });

/**
 * 读出流里已经落下的字节，不等流结束——SSE 的流永远不会结束。
 *
 * 那个 `pending` 必须跨循环留住。每轮新起一个 `reader.read()` 去 race 的话，上一轮
 * 输给超时的那个 read 依然挂着，它稍后拿到的那块数据再也没人去 await——测试于是
 * 随机丢帧，表现成"偶尔收不到事件"，而实现是好的。
 */
async function drain(res: Response, ms = 60): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  const deadline = Date.now() + ms;
  let pending: ReturnType<typeof reader.read> | null = null;
  while (Date.now() < deadline) {
    pending ??= reader.read();
    const got = await Promise.race([pending, Bun.sleep(15).then(() => "timeout" as const)]);
    if (got === "timeout") continue;
    pending = null;
    if (got.done) break;
    out += decoder.decode(got.value, { stream: true });
  }
  await reader.cancel();
  return out;
}

test("响应头是 SSE 该有的那几个", () => {
  const res = eventsResponse(null);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  // 反代默认会攒够一块再吐，事件流会变成几十秒一批，看起来像服务端不发事件。
  expect(res.headers.get("x-accel-buffering")).toBe("no");
  void res.body!.cancel();
});

test("发布的事件按 SSE 帧格式落到流里", async () => {
  const res = eventsResponse(null);
  const read = drain(res);
  await Bun.sleep(10);
  const event = publish({ type: "session.turn", session: "alpha", data: { turn: "waiting" } });
  const text = await read;
  expect(text).toContain(`id: ${event.id}`);
  expect(text).toContain("event: session.turn");
  expect(text).toContain(`data: ${JSON.stringify(event)}`);
});

test("连上就启动轮询，断开就停", async () => {
  expect(pollingActive()).toBe(false);
  const res = eventsResponse(null);
  await Bun.sleep(10);
  expect(pollingActive()).toBe(true);
  await res.body!.cancel();
  await Bun.sleep(10);
  expect(pollingActive()).toBe(false);
  expect(subscriberCount()).toBe(0);
});

test("带着还在缓冲里的 id 重连会拿到补发", async () => {
  const first = publish({ type: "session.created", session: "alpha", data: {} });
  publish({ type: "session.turn", session: "alpha", data: {} });
  const res = eventsResponse(first.id);
  const text = await drain(res);
  expect(text).toContain("event: session.turn");
  expect(text).not.toContain("event: session.created");
});

test("带着认不出来的 id 重连先拿到一条 resync", async () => {
  const res = eventsResponse("evt_deadbeef_9");
  const text = await drain(res);
  expect(text).toContain("event: resync");
});

test("两个订阅者各自收到同一条事件", async () => {
  const a = eventsResponse(null);
  const b = eventsResponse(null);
  const readA = drain(a);
  const readB = drain(b);
  await Bun.sleep(10);
  publish({ type: "session.ended", session: "alpha", data: {} });
  expect(await readA).toContain("event: session.ended");
  expect(await readB).toContain("event: session.ended");
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `bun test src/events/sse.test.ts`
Expected: FAIL，`Cannot find module './sse'`

- [ ] **Step 3: 写实现**

```ts
// src/events/sse.ts
import { replayFrom, subscribe, subscriberCount, type AppEvent } from "./bus";
import { startPolling, stopPolling } from "./poller";

/**
 * 心跳间隔。反代和移动网络会掐掉长时间没有字节的连接，而一台安静的机器可以几十分钟
 * 没有任何会话事件。
 */
const HEARTBEAT_MS = 15_000;

function frame(event: AppEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * 一条 SSE 连接。
 *
 * 订阅与轮询的启停绑在这里：第一个订阅者让轮询跑起来，最后一个走开就停掉。这是
 * "没人关心就不烧 CPU"的落点——`listSessions()` 为每个会话起一次 `capture-pane`
 * 子进程，永远跑着的代价按会话数线性增长。
 *
 * `cancel` 必须退订并可能停掉轮询。少写这一段不会有任何测试变红，但每一次断线重连
 * 都会留下一个死订阅者，几小时之后一条事件要扇出给几百个已经没人读的流。
 */
export function eventsResponse(lastEventId: string | null): Response {
  const replay = replayFrom(lastEventId);
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // 客户端已经走了，下一次 cancel 会来收尾。
        }
      };

      if (!replay.ok) {
        // 跟丢了。这是关于**这条连接**的事实，不是关于会话的，所以它不进事件总线，
        // 也不会投递给（第 3 期的）Webhook——一次性的 Webhook 投递没有"跟丢"这回事。
        send(`event: resync\ndata: {}\n\n`);
      } else {
        for (const event of replay.events) send(frame(event));
      }

      unsubscribe = subscribe((event) => send(frame(event)));
      startPolling();

      heartbeat = setInterval(() => send(`:ping\n\n`), HEARTBEAT_MS);
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = null;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      if (subscriberCount() === 0) stopPolling();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // 反代默认攒够一块再吐，事件流会变成"几十秒一批"，看起来像服务端不发事件。
      "X-Accel-Buffering": "no",
    },
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/events/sse.test.ts && bun run typecheck`
Expected: PASS，6 个测试

- [ ] **Step 5: 挂上路由**

在 `src/server.ts` 顶部的 import 区加：

```ts
import { eventsResponse } from "./events/sse";
```

在 `/api/notify` 那个 `if` 块**之后**、`/api/dirs` 那个 `if` 块**之前**插入：

```ts
      // 事件流。放在具体的 /api/sessions/... 正则之前无所谓——它是精确路径匹配，
      // 不会被那些贪婪的 (.+) 吞掉，也吞不掉别人。
      if (url.pathname === "/api/events" && req.method === "GET") {
        return eventsResponse(req.headers.get("last-event-id"));
      }
```

- [ ] **Step 6: 跑服务器测试**

Run: `bun test src/server.test.ts && bun run typecheck`
Expected: PASS（不应有新增失败）

- [ ] **Step 7: 提交**

```bash
git add src/events/sse.ts src/events/sse.test.ts src/server.ts
git commit -m "Serve the event stream over SSE, and tie the poll to having a reader

Subscribing starts the poll and the last reader leaving stops it, so an
instance nobody is watching costs what it costs today. The stream answers a
Last-Event-ID it cannot honour with a resync rather than a plausible-looking
replay, because a client has no way to tell the difference and would carry
on believing it had missed nothing."
```

---

### Task 6: `/api/capabilities`

**Files:**
- Modify: `src/server.ts`（`/api/version` 那个 `if` 块之后）
- Test: `src/capabilities.test.ts`

**Interfaces:**
- Consumes: 无新增
- Produces: `GET /api/capabilities` → `{ version, build, events, streamEvents, includes, features }`

- [ ] **Step 1: 写失败的测试**

```ts
// src/capabilities.test.ts
import { test, expect, afterAll } from "bun:test";
import { startServer } from "./server";

const server = startServer(0);
afterAll(() => server.stop());

const base = () => `http://127.0.0.1:${server.port}`;

/**
 * 能力声明代替 URL 版本号。真正会发生的不一致不是"第三方没跟上"，而是手机上的
 * App 和机器上的服务端版本对不上——服务端是 npm 包由用户自己升级，客户端要过应用
 * 商店审核。`/api/v1` 解决不了这个；一份"我实际支持什么"的清单可以。
 */
test("能力端点列出本期已经存在的事件类型", async () => {
  const res = await fetch(`${base()}/api/capabilities`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.events).toContain("session.turn");
  expect(body.events).toContain("session.created");
  expect(body.streamEvents).toContain("resync");
  expect(body.features).toContain("sse");
});

/** 版本要跟 /api/version 说的是同一个，否则客户端会拿到两个都像真的答案。 */
test("版本与 /api/version 一致", async () => {
  const [caps, version] = await Promise.all([
    fetch(`${base()}/api/capabilities`).then((r) => r.json()),
    fetch(`${base()}/api/version`).then((r) => r.json()),
  ]);
  expect(caps.version).toBe(version.version);
  expect(caps.build).toBe(version.build);
});

/**
 * 本期还没做的能力不能出现在清单里。一个提前写上的名字比没有这个端点更糟：客户端
 * 会据此走上一条不存在的路径，而它本可以降级。
 */
test("未实现的能力不出现在清单里", async () => {
  const body = await fetch(`${base()}/api/capabilities`).then((r) => r.json());
  expect(body.features).not.toContain("webhooks");
  expect(body.features).not.toContain("batch-input");
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `bun test src/capabilities.test.ts`
Expected: FAIL，`/api/capabilities` 返回 404

- [ ] **Step 3: 写实现**

在 `src/server.ts` 里 `/api/version` 那个 `if` 块之后插入：

```ts
      /**
       * 这台服务器实际支持什么。
       *
       * 用它代替 URL 版本号：调用方是自己的第二个前端，真正会发生的不一致是手机上的
       * App 和机器上的服务端版本对不上——服务端是 npm 包由用户自己升级，客户端要过
       * 应用商店审核。`/api/v1` 对此无能为力，一份能力清单可以让新客户端自己降级，
       * 而不是撞上 404 再猜原因。
       *
       * 清单里只能有**已经实现**的东西。提前写上一个名字比没有这个端点更糟：客户端
       * 会据此走上一条不存在的路径，而它本可以降级。
       */
      if (url.pathname === "/api/capabilities" && req.method === "GET") {
        return Response.json(
          {
            version: pkg.version,
            build: BUILD,
            events: [
              "session.created",
              "session.ended",
              "session.renamed",
              "session.turn",
              "session.attention",
            ],
            streamEvents: ["resync"],
            includes: [],
            features: ["sse"],
          },
          { headers: { "Cache-Control": "no-cache" } },
        );
      }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/capabilities.test.ts && bun run typecheck`
Expected: PASS，3 个测试

- [ ] **Step 5: 提交**

```bash
git add src/server.ts src/capabilities.test.ts
git commit -m "Answer what this server actually supports, in place of a URL version

The mismatch that will really happen is a phone app meeting an older server,
since the server is an npm package the user upgrades and the client waits on
app review. A version prefix cannot help with that; a list of what is
actually implemented lets a newer client degrade instead of guessing at a
404. Only shipped capabilities may be listed."
```

---

### Task 7: `/api/notify` 发布到总线

今天 `/api/notify` 直接调 `notify()` 发 Web Push。改成也发布到事件总线，让推送和 SSE
由同一个来源喂养。本期只接 `attention`——它是边沿不是状态，没有去重问题；`waiting` 和
`ended` 的 hook 加速留给第 3 期（见「本期范围内 / 外」）。

**Files:**
- Modify: `src/server.ts:566-583`（`/api/notify` 那个 `if` 块）
- Test: `src/events/notify-bus.test.ts`

**Interfaces:**
- Consumes: `publish`（Task 2）
- Produces: 无新导出

- [ ] **Step 1: 写失败的测试**

```ts
// src/events/notify-bus.test.ts
import { test, expect, afterAll, beforeEach } from "bun:test";
import { startServer } from "../server";
import { subscribe, resetBus, type AppEvent } from "./bus";

const server = startServer(0);
afterAll(() => server.stop());
beforeEach(() => resetBus());

const base = () => `http://127.0.0.1:${server.port}`;

async function notify(event: string, session: string, message?: string) {
  return fetch(`${base()}/api/notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, session, message }),
  });
}

/**
 * 推送和 SSE 必须由同一个来源喂养，否则两者会对同一件事给出不同说法。这条测试钉的
 * 就是那一个来源：hook 打进来，总线上要看得见。
 */
test("attention 钩子发布成 session.attention", async () => {
  const seen: AppEvent[] = [];
  subscribe((e) => seen.push(e));
  const res = await notify("attention", "alpha", "需要你确认一下");
  expect(res.status).toBe(202);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.type).toBe("session.attention");
  expect(seen[0]!.session).toBe("alpha");
  expect(seen[0]!.data.message).toBe("需要你确认一下");
});

/** 本期不接 waiting/ended 的 hook 加速：轮询会在一个间隔内报同一件事。 */
test("本期 waiting 不进总线", async () => {
  const seen: AppEvent[] = [];
  subscribe((e) => seen.push(e));
  await notify("waiting", "alpha");
  expect(seen).toHaveLength(0);
});

/** 校验失败的请求不该在总线上留下任何痕迹。 */
test("非法事件名不发布", async () => {
  const seen: AppEvent[] = [];
  subscribe((e) => seen.push(e));
  const res = await notify("nonesuch", "alpha");
  expect(res.status).toBe(400);
  expect(seen).toHaveLength(0);
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `bun test src/events/notify-bus.test.ts`
Expected: FAIL，第一条测试 `seen` 为空

- [ ] **Step 3: 写实现**

在 `src/server.ts` 顶部的 import 区加：

```ts
import { publish as publishEvent } from "./events/bus";
```

把 `/api/notify` 块里 `const result = await notify(...)` 那一行**之前**插入：

```ts
        // 推送和 SSE 由同一个来源喂养，否则两者会对同一件事给出不同说法。
        //
        // 本期只接 `attention`：它是**边沿**（agent 主动要人），没有去重问题。
        // `waiting` / `ended` 是**状态**，它们的去重靠轮询那张按 sessionId 索引的
        // 快照表，而 hook 只知道会话名——要让两个生产者共用那张表需要一个名字到 id
        // 的索引，在 Webhook 存在之前这点延迟换不来什么。见第 3 期。
        if (body.event === "attention") {
          publishEvent({
            type: "session.attention",
            session: body.session,
            data: message === undefined ? {} : { message },
          });
        }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/events/notify-bus.test.ts && bun run typecheck`
Expected: PASS，3 个测试

- [ ] **Step 5: 跑整个 events 目录和服务器测试**

Run: `bun test src/events/ && bun test src/server.test.ts && bun test src/items/ && bun run typecheck`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add src/server.ts src/events/notify-bus.test.ts
git commit -m "Feed the event bus from the notify hook as well as the poll

Push notifications and the event stream now read from one source, so they
cannot end up describing the same moment differently. Only attention crosses
over for now: it is an edge and needs no deduplication, while the level
events are deduplicated against a snapshot keyed by session id that a hook,
knowing only a name, cannot reach yet."
```

---

## 收尾

- [ ] **文档**：在 `CLAUDE.md` 的架构段里加一段讲事件流——重点是「服务端在此之前没有
      轮询循环」这件事，以及轮询按需启停的理由。这是下一个读代码的人最容易想当然的
      地方。
- [ ] **`docs/deploy.md`**：加一节讲 SSE 不能被反代缓冲，Caddy 需要 `flush_interval -1`；
      以及 SSE 是普通 GET，Basic Auth 能覆盖它，和 `/ws` 那个 cookie 的坑不是一回事。
- [ ] 跑一遍受影响的测试目录（不要跑裸 `bun test`，它会挂住）：
      `bun test src/events/ && bun test src/items/ && bun test src/server.test.ts && bun run typecheck`

## 手工验收

服务跑起来之后：

```bash
curl -N http://127.0.0.1:7682/api/events
```

另开一个终端 `tmux new-session -d -s probe-$$`，流里应当出现一条 `session.created`；
`tmux kill-session -t =probe-<pid>` 之后应当出现 `session.ended`。安静时每 15 秒一行
`:ping`。

注意验收用的会话要用自己创建的名字，清理只按精确名字 `kill-session -t =<name>`。
