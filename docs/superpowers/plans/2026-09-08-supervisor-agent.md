# 监察者 Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a self-contained `supervisor` plugin that lets a user spin up one "监察者" agent per working directory — a normal Claude Code session, primed with a fixed prompt template, that patrols sibling Claude Code sessions in the same `cwd`, and a read-only page that shows each patrol's logged results.

**Architecture:** All detection/decision logic lives in the primed agent's own prompt (no kernel-side heuristics). The plugin supplies only the boring, code-appropriate parts: a one-per-cwd registry, a prompt-template renderer, an orchestration function that creates + primes the session, and read routes for a page that renders the JSONL patrol log the agent itself appends to.

**Tech Stack:** Bun, TypeScript, the existing plugin architecture (`plugins/types.ts`, `plugins/handlers.ts`, `plugins/registry.js`), existing tmux/session helpers (`src/tmux/session-create.ts`, `src/tmux/prime.ts`, `src/paths.ts`), existing tail-read helper (`src/agents/tail.ts`).

**Spec:** `docs/superpowers/specs/2026-09-08-supervisor-agent-design.md`

## Global Constraints

- Only Claude Code sessions are ever considered siblings — a `SessionRecord.agent` of `undefined` or `"claude"` (per `src/claude-sessions.ts`'s documented convention that "absent means Claude Code").
- One supervisor per `cwd`, keyed by the *resolved* (realpath'd) directory, not the raw input string.
- `autoConfirmPermission` defaults to `false` and is only ever set by an explicit user choice at creation time; the kernel never inspects prompt content to decide this — it is a value the agent's own prompt is told to obey.
- All new on-disk state lives under `pluginStateDir("supervisor")` (`TMUX_NEXT_SUPERVISOR_DIR` env override), read lazily inside functions, never captured at module load — this is the existing rule for every state path in this repo and `plugins/state.ts` already implements the override.
- No new kernel API is granted to the supervisor for observing or acting on siblings — it uses the shell access every Claude Code session already has (`tmux capture-pane`, `tmux send-keys`, reading `~/.claude/projects/...`). The plugin code never runs those commands on the supervisor's behalf.
- Every new state-mutating function must be injectable-deps testable (matching this repo's existing pattern of injecting `enrich`/`fields` tables, `capture`/`sleep` in `waitForReady`, etc.) so tests don't have to spin a real tmux session for orchestration logic.
- No new CSS: the page reuses existing kernel classes (`.card`, `.card-main`, `.row`, `.name`, `.time`, `.preview`, `.empty`, `.btn`, `.btn.primary`) already defined in `public/style.css`, so `plugins/supervisor/public/style.css` is not created.

---

### Task 1: Registry — one supervisor per cwd

**Files:**
- Create: `plugins/supervisor/state.ts`
- Test: `plugins/supervisor/state.test.ts`

**Interfaces:**
- Produces: `export type SupervisorRecord = { session: string; startedAt: number; autoConfirmPermission: boolean }`
- Produces: `export type Registry = Record<string, SupervisorRecord>` (key is a resolved cwd path)
- Produces: `export async function readRegistry(): Promise<Registry>`
- Produces: `export async function setSupervisor(cwd: string, record: SupervisorRecord): Promise<void>`
- Produces: `export async function removeSupervisor(cwd: string): Promise<void>`
- Produces: `export async function listLiveSupervisors(hasSession: (session: string) => Promise<boolean>): Promise<Array<{ cwd: string } & SupervisorRecord>>` — takes liveness-check as a parameter so the test never touches real tmux; also prunes registry entries whose session is no longer live.

- [ ] **Step 1: Write the failing tests**

```ts
// plugins/supervisor/state.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supervisor-state-"));
  process.env.TMUX_NEXT_SUPERVISOR_DIR = dir;
});
afterEach(() => {
  delete process.env.TMUX_NEXT_SUPERVISOR_DIR;
  rmSync(dir, { recursive: true, force: true });
});

test("空目录读出空登记表", async () => {
  const { readRegistry } = await import("./state");
  expect(await readRegistry()).toEqual({});
});

test("写入后能读回同一条记录", async () => {
  const { setSupervisor, readRegistry } = await import("./state");
  await setSupervisor("/tmp/proj", { session: "supervisor-proj", startedAt: 1000, autoConfirmPermission: false });
  expect(await readRegistry()).toEqual({
    "/tmp/proj": { session: "supervisor-proj", startedAt: 1000, autoConfirmPermission: false },
  });
});

test("removeSupervisor 只删指定的 cwd", async () => {
  const { setSupervisor, removeSupervisor, readRegistry } = await import("./state");
  await setSupervisor("/tmp/a", { session: "s-a", startedAt: 1, autoConfirmPermission: false });
  await setSupervisor("/tmp/b", { session: "s-b", startedAt: 2, autoConfirmPermission: true });
  await removeSupervisor("/tmp/a");
  expect(await readRegistry()).toEqual({
    "/tmp/b": { session: "s-b", startedAt: 2, autoConfirmPermission: true },
  });
});

test("损坏的登记表文件当成空表，不抛异常", async () => {
  const { readRegistry } = await import("./state");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "registry.json"), "not json");
  expect(await readRegistry()).toEqual({});
});

test("listLiveSupervisors 只保留存活会话，并清掉登记表里的死记录", async () => {
  const { setSupervisor, listLiveSupervisors, readRegistry } = await import("./state");
  await setSupervisor("/tmp/alive", { session: "s-alive", startedAt: 1, autoConfirmPermission: false });
  await setSupervisor("/tmp/dead", { session: "s-dead", startedAt: 2, autoConfirmPermission: false });
  const hasSession = async (session: string) => session === "s-alive";

  const live = await listLiveSupervisors(hasSession);

  expect(live).toEqual([{ cwd: "/tmp/alive", session: "s-alive", startedAt: 1, autoConfirmPermission: false }]);
  expect(await readRegistry()).toEqual({
    "/tmp/alive": { session: "s-alive", startedAt: 1, autoConfirmPermission: false },
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test plugins/supervisor/state.test.ts`
Expected: FAIL — `Cannot find module './state'` (file doesn't exist yet)

- [ ] **Step 3: Implement**

```ts
// plugins/supervisor/state.ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pluginStateDir } from "../state";

export type SupervisorRecord = {
  session: string;
  startedAt: number;
  autoConfirmPermission: boolean;
};

export type Registry = Record<string, SupervisorRecord>;

function registryPath(): string {
  return join(pluginStateDir("supervisor"), "registry.json");
}

export async function readRegistry(): Promise<Registry> {
  try {
    const data: unknown = await Bun.file(registryPath()).json();
    if (data === null || typeof data !== "object" || Array.isArray(data)) return {};
    return data as Registry;
  } catch {
    return {};
  }
}

async function writeRegistry(registry: Registry): Promise<void> {
  await mkdir(pluginStateDir("supervisor"), { recursive: true });
  await Bun.write(registryPath(), JSON.stringify(registry, null, 2));
}

export async function setSupervisor(cwd: string, record: SupervisorRecord): Promise<void> {
  const registry = await readRegistry();
  registry[cwd] = record;
  await writeRegistry(registry);
}

export async function removeSupervisor(cwd: string): Promise<void> {
  const registry = await readRegistry();
  delete registry[cwd];
  await writeRegistry(registry);
}

/**
 * Live supervisors, and a side effect: any registry entry whose tmux session
 * is gone is dropped, so a dead supervisor never blocks a fresh one for that
 * cwd. `hasSession` is injected so tests never need a real tmux server.
 */
export async function listLiveSupervisors(
  hasSession: (session: string) => Promise<boolean>,
): Promise<Array<{ cwd: string } & SupervisorRecord>> {
  const registry = await readRegistry();
  const live: Array<{ cwd: string } & SupervisorRecord> = [];
  const dead: string[] = [];

  for (const [cwd, record] of Object.entries(registry)) {
    if (await hasSession(record.session)) live.push({ cwd, ...record });
    else dead.push(cwd);
  }

  if (dead.length) {
    const fresh = await readRegistry();
    for (const cwd of dead) delete fresh[cwd];
    await writeRegistry(fresh);
  }

  return live;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test plugins/supervisor/state.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add plugins/supervisor/state.ts plugins/supervisor/state.test.ts
git commit -m "监察者：一人一岗登记表"
```

---

### Task 2: Patrol log — path + tolerant tail parsing

**Files:**
- Create: `plugins/supervisor/log.ts`
- Test: `plugins/supervisor/log.test.ts`

**Interfaces:**
- Consumes: `readTailOf` from `../../src/agents/tail` (signature: `(path: string) => Promise<string | null>`)
- Produces: `export function encodeCwd(cwd: string): string` — turns a resolved cwd into a filesystem-safe basename (same replace rule as `encodeProjectDir` in `src/claude-history.ts`: strip trailing `/`, then replace every `/` and `.` with `-`), used as the log's filename stem.
- Produces: `export function logPathFor(cwd: string): string` — `join(pluginStateDir("supervisor"), "logs", encodeCwd(cwd) + ".jsonl")`
- Produces: `export type PatrolCheck = { session: string; turn: "waiting" | "working" | null; note: string }`
- Produces: `export type PatrolAction = { session: string; type: "answered" | "notified" | "noop"; detail: string }`
- Produces: `export type PatrolEntry = { ts: string; checked: PatrolCheck[]; actions: PatrolAction[] }`
- Produces: `export function patrolEntriesFrom(chunk: string): PatrolEntry[]` — pure parser, tolerant of a truncated leading line and malformed lines, oldest-to-newest in read order.
- Produces: `export async function readPatrolLog(cwd: string, limit: number): Promise<PatrolEntry[]>` — reads the tail of `logPathFor(cwd)` via `readTailOf`, parses it, returns at most the last `limit` entries (newest last, same order convention as `turnFrom`'s tail scan).

- [ ] **Step 1: Write the failing tests**

```ts
// plugins/supervisor/log.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { encodeCwd, logPathFor, patrolEntriesFrom, readPatrolLog } from "./log";

test("encodeCwd 把斜杠和点换成短横线", () => {
  expect(encodeCwd("/Users/you/projects/tmux-next")).toBe("-Users-you-projects-tmux-next");
  expect(encodeCwd("/Users/you/proj.name/")).toBe("-Users-you-proj-name");
});

test("logPathFor 落在 supervisor 状态目录的 logs 子目录下", () => {
  process.env.TMUX_NEXT_SUPERVISOR_DIR = "/tmp/sup-state";
  expect(logPathFor("/a/b")).toBe("/tmp/sup-state/logs/-a-b.jsonl");
  delete process.env.TMUX_NEXT_SUPERVISOR_DIR;
});

test("patrolEntriesFrom 跳过残缺的第一行和坏 JSON", () => {
  const chunk = [
    '{"partial line from a previous',
    '{"ts":"2026-01-01T00:00:00Z","checked":[{"session":"a","turn":"waiting","note":"n"}],"actions":[{"session":"a","type":"noop","detail":"d"}]}',
    "not json at all",
    '{"ts":"2026-01-01T00:01:00Z","checked":[],"actions":[]}',
  ].join("\n");

  expect(patrolEntriesFrom(chunk)).toEqual([
    {
      ts: "2026-01-01T00:00:00Z",
      checked: [{ session: "a", turn: "waiting", note: "n" }],
      actions: [{ session: "a", type: "noop", detail: "d" }],
    },
    { ts: "2026-01-01T00:01:00Z", checked: [], actions: [] },
  ]);
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supervisor-log-"));
  process.env.TMUX_NEXT_SUPERVISOR_DIR = dir;
});
afterEach(() => {
  delete process.env.TMUX_NEXT_SUPERVISOR_DIR;
  rmSync(dir, { recursive: true, force: true });
});

test("readPatrolLog 读不到文件时返回空数组", async () => {
  expect(await readPatrolLog("/nope", 10)).toEqual([]);
});

test("readPatrolLog 按 limit 只留最新的几条", async () => {
  const path = logPathFor("/proj");
  mkdirSync(dirname(path), { recursive: true });
  const lines = [1, 2, 3].map(
    (n) => `{"ts":"t${n}","checked":[],"actions":[]}`,
  );
  writeFileSync(path, lines.join("\n") + "\n");

  const entries = await readPatrolLog("/proj", 2);
  expect(entries.map((e) => e.ts)).toEqual(["t2", "t3"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test plugins/supervisor/log.test.ts`
Expected: FAIL — `Cannot find module './log'`

- [ ] **Step 3: Implement**

```ts
// plugins/supervisor/log.ts
import { join } from "node:path";
import { pluginStateDir } from "../state";
import { readTailOf } from "../../src/agents/tail";

export function encodeCwd(cwd: string): string {
  return cwd.replace(/\/+$/, "").replace(/[/.]/g, "-");
}

export function logPathFor(cwd: string): string {
  return join(pluginStateDir("supervisor"), "logs", `${encodeCwd(cwd)}.jsonl`);
}

export type PatrolCheck = { session: string; turn: "waiting" | "working" | null; note: string };
export type PatrolAction = { session: string; type: "answered" | "notified" | "noop"; detail: string };
export type PatrolEntry = { ts: string; checked: PatrolCheck[]; actions: PatrolAction[] };

const TURNS = new Set(["waiting", "working", null]);
const ACTION_TYPES = new Set(["answered", "notified", "noop"]);

function checksFrom(value: unknown): PatrolCheck[] {
  if (!Array.isArray(value)) return [];
  const out: PatrolCheck[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const { session, turn, note } = raw as Record<string, unknown>;
    if (typeof session !== "string" || typeof note !== "string") continue;
    if (!TURNS.has(turn as string | null)) continue;
    out.push({ session, turn: turn as PatrolCheck["turn"], note });
  }
  return out;
}

function actionsFrom(value: unknown): PatrolAction[] {
  if (!Array.isArray(value)) return [];
  const out: PatrolAction[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const { session, type, detail } = raw as Record<string, unknown>;
    if (typeof session !== "string" || typeof detail !== "string") continue;
    if (typeof type !== "string" || !ACTION_TYPES.has(type)) continue;
    out.push({ session, type: type as PatrolAction["type"], detail });
  }
  return out;
}

/**
 * Tolerant by construction, same reasoning as `turnFrom`: a tail read starts
 * mid-record, so the first line is normally a fragment, and any line may be
 * malformed if a write was interrupted. Both are skipped rather than failed.
 */
export function patrolEntriesFrom(chunk: string): PatrolEntry[] {
  const out: PatrolEntry[] = [];
  for (const line of chunk.split("\n")) {
    const raw = line.trim();
    if (!raw.startsWith("{")) continue;
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const { ts, checked, actions } = record as Record<string, unknown>;
    if (typeof ts !== "string") continue;
    out.push({ ts, checked: checksFrom(checked), actions: actionsFrom(actions) });
  }
  return out;
}

export async function readPatrolLog(cwd: string, limit: number): Promise<PatrolEntry[]> {
  const chunk = await readTailOf(logPathFor(cwd));
  if (chunk === null) return [];
  const entries = patrolEntriesFrom(chunk);
  return entries.slice(Math.max(0, entries.length - limit));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test plugins/supervisor/log.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add plugins/supervisor/log.ts plugins/supervisor/log.test.ts
git commit -m "监察者：巡检日志的路径规则与容错解析"
```

---

### Task 3: Prompt template renderer

**Files:**
- Create: `plugins/supervisor/prompt.ts`
- Test: `plugins/supervisor/prompt.test.ts`

**Interfaces:**
- Produces: `export type PromptParams = { cwd: string; selfSession: string; autoConfirmPermission: boolean; logPath: string; port: string }`
- Produces: `export function renderSupervisorPrompt(params: PromptParams): string`

This is the template finalized in the design doc (`docs/superpowers/specs/2026-09-08-supervisor-agent-design.md`, section 四), verbatim, with `{{...}}` placeholders substituted.

- [ ] **Step 1: Write the failing tests**

```ts
// plugins/supervisor/prompt.test.ts
import { expect, test } from "bun:test";
import { renderSupervisorPrompt } from "./prompt";

test("替换全部占位符，不残留任何 {{ }}", () => {
  const text = renderSupervisorPrompt({
    cwd: "/Users/you/proj",
    selfSession: "supervisor-proj",
    autoConfirmPermission: true,
    logPath: "/Users/you/.tmux-next/supervisor/logs/-Users-you-proj.jsonl",
    port: "7682",
  });

  expect(text).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
  expect(text).toContain("/Users/you/proj");
  expect(text).toContain("supervisor-proj");
  expect(text).toContain("true");
  expect(text).toContain("/Users/you/.tmux-next/supervisor/logs/-Users-you-proj.jsonl");
  expect(text).toContain("http://127.0.0.1:7682/api/notify");
});

test("autoConfirmPermission=false 也原样写进文本", () => {
  const text = renderSupervisorPrompt({
    cwd: "/a",
    selfSession: "s",
    autoConfirmPermission: false,
    logPath: "/a.jsonl",
    port: "7682",
  });
  expect(text).toContain("false");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test plugins/supervisor/prompt.test.ts`
Expected: FAIL — `Cannot find module './prompt'`

- [ ] **Step 3: Implement**

```ts
// plugins/supervisor/prompt.ts

/**
 * The supervisor's entire behaviour lives here, in prose, not in code — see
 * "不做什么" in the design doc. This module's only job is safe substitution;
 * it must never try to interpret what the template says.
 */
const TEMPLATE = `你是「监察者」。你是一个普通的 Claude Code 会话，没有专属工具，只是角色和职责不同：
你要巡视目录 {{cwd}} 下、这台机器上正在运行的其他 Claude Code 会话，防止它们卡住，
必要时替它们理解上下文并代为回答。你自己的 tmux 会话名是 {{selfSession}}，检查名单时要
排除自己。

一、找到同伴
1. 读 ~/.tmux-next/sessions/*.json，每个文件形如
   {"id":"<claude session id>","session":"<tmux 会话名>","cwd":"...","agent":"..."}。
2. 只关心 cwd 等于或位于 {{cwd}} 之下、且 agent 缺省或等于 "claude" 的记录（缺省即 Claude Code）。
3. 用 tmux list-sessions -F "#{session_name}" 核对该 tmux 会话是否还活着；已经不在的记录跳过。
4. 排除 {{selfSession}} 自己。

二、读一个同伴的状态
Claude Code 把每个会话的完整记录写在
~/.claude/projects/<cwd 编码>/<session id>.jsonl。<cwd 编码> 的规则是：把该会话的 cwd
字符串末尾的 / 去掉，再把所有 / 和 . 换成 -（例如 /Users/you/proj → -Users-you-proj）。

只读文件尾部（比如最后 32KB，用 tail -c 32768），逐行按 JSON 解析，最新的一条判断结果覆盖前面的：
- 遇到 "type":"user" 的行 → 当前状态记为 working（球在它那边，上一句 assistant 的话作废）。
- 遇到 "type":"assistant" 且 message.stop_reason == "tool_use" → working。
- 遇到 "type":"assistant" 且 stop_reason 是 end_turn / stop_sequence → waiting，把
  message.content 里 type=="text" 的块拼起来，作为「它最后说的话」。
- 其余 type（system、attachment 等）忽略。
- 如果某一行带 timestamp 字段，记下最后一条能解析的记录的时间，用来算「已经多久没动静」。

三、判断要不要管，怎么管
- working 且很久没有新记录（比如 10 分钟以上）：先看它最后的话/工具调用像不像在跑测试、
  装依赖、编译这种正常耗时任务；看不出理由、又确实长时间没有任何新记录 → 怀疑卡住，走「上报」。
- waiting 且最后一句话是需要理解上下文才能回答的开放问题：你可以基于你对这个仓库、这个
  工作区里其他会话在做什么的理解，直接代为回答（见下面「怎么介入」）。
- waiting 且最后一句话明显是权限确认/y-n 选择类提示（例如「是否允许运行 xxx」「1. Yes 2.
  Yes, don't ask again 3. No」这种）：只有 {{autoConfirmPermission}} 为 true 时才可以代为
  确认，否则只报告、不要替它按下确认。
- 其他一切正常 → 不用管，本轮记为 noop。

四、怎么介入
1. 介入前先 tmux capture-pane -p -t "=<session>" 看一眼屏幕，确认它现在确实停在你从
   transcript 里读到的那个提示上——transcript 可能比屏幕滞后，别对着已经翻篇的画面发言。
2. 用 tmux send-keys -t "=<session>" -l "<你的回答文本>" 输入文本，再单独一次
   tmux send-keys -t "=<session>" Enter 提交。一次只发一段简短明确的回答，不要模拟多轮对话。
3. 绝不要 kill-session、绝不要对不是自己创建的会话做任何销毁性操作——你的角色是观察和补一句
   话，不是接管。

五、上报卡住的情况
调用（loopback，无需鉴权）：
curl -s -X POST http://127.0.0.1:{{port}}/api/notify \\
  -H 'Content-Type: application/json' \\
  -d '{"event":"attention","session":"<那个会话名>","message":"<一句话说明为什么怀疑卡住>"}'

六、记录这一轮巡检
每轮检查完，不管有没有发现问题，都往 {{logPath}} 追加一行 JSON（一行一个对象，不要换行、
不要漂亮打印）：
{"ts":"<当前 ISO8601 时间>","checked":[{"session":"...","turn":"waiting|working|null","note":"..."}],"actions":[{"session":"...","type":"answered|notified|noop","detail":"..."}]}
用类似 printf '%s\\n' '<这行 json>' >> {{logPath}} 追加，不要用 > 覆盖。

七、节奏
做完一轮巡视后，调用 /loop，把这份指示原样带回去，让自己按分钟级自定步调继续巡视——发现
异常时可以缩短下一次的间隔，长时间平静就拉长间隔，没必要死板固定成某个数字。收到用户在这个
会话里直接发的消息时，优先处理那条消息，处理完再回到巡视循环。
`;

export type PromptParams = {
  cwd: string;
  selfSession: string;
  autoConfirmPermission: boolean;
  logPath: string;
  port: string;
};

export function renderSupervisorPrompt(params: PromptParams): string {
  return TEMPLATE.replaceAll("{{cwd}}", params.cwd)
    .replaceAll("{{selfSession}}", params.selfSession)
    .replaceAll("{{autoConfirmPermission}}", String(params.autoConfirmPermission))
    .replaceAll("{{logPath}}", params.logPath)
    .replaceAll("{{port}}", params.port);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test plugins/supervisor/prompt.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add plugins/supervisor/prompt.ts plugins/supervisor/prompt.test.ts
git commit -m "监察者：首条提示词模板"
```

---

### Task 4: Create orchestration

**Files:**
- Create: `plugins/supervisor/create.ts`
- Test: `plugins/supervisor/create.test.ts`

**Interfaces:**
- Consumes: `resolveDirectory` from `../../src/paths` (`(input: string) => Promise<{ok:true;path:string}|{ok:false;reason:"denied"|"missing"}>`)
- Consumes: `createSession`, `sessionNames` from `../../src/tmux/session-create` / `../../src/tmux/session-list` (signatures per Task's Global Constraints research: `createSession(dir, requested, existing, command?) => Promise<{ok:true;name:string;created:boolean}|{ok:false;reason:...}>`, `sessionNames() => Promise<string[]>`)
- Consumes: `primeSession` from `../../src/tmux/prime` (`(session: string, text: string, agentId?: unknown) => Promise<void>`)
- Consumes: `setSupervisor`, `readRegistry` from `./state`
- Consumes: `logPathFor` from `./log`
- Consumes: `renderSupervisorPrompt` from `./prompt`
- Produces: `export type CreateSupervisorParams = { cwd: string; autoConfirmPermission: boolean; port: string }`
- Produces: `export type CreateSupervisorResult = { ok: true; session: string } | { ok: false; reason: "baddir" | "exists" | "failed" }`
- Produces: `export type CreateSupervisorDeps = { resolveDirectory: typeof resolveDirectory; createSession: typeof createSession; sessionNames: typeof sessionNames; hasSession: (session: string) => Promise<boolean>; primeSession: typeof primeSession; nowMs: () => number }`
- Produces: `export const defaultCreateSupervisorDeps: CreateSupervisorDeps`
- Produces: `export async function createSupervisor(params: CreateSupervisorParams, deps?: CreateSupervisorDeps): Promise<CreateSupervisorResult>`

- [ ] **Step 1: Write the failing tests**

```ts
// plugins/supervisor/create.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateSupervisorDeps } from "./create";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supervisor-create-"));
  process.env.TMUX_NEXT_SUPERVISOR_DIR = dir;
});
afterEach(() => {
  delete process.env.TMUX_NEXT_SUPERVISOR_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function fakeDeps(overrides: Partial<CreateSupervisorDeps> = {}): CreateSupervisorDeps {
  return {
    resolveDirectory: async (input) => ({ ok: true, path: input }),
    createSession: async (_dir, requested) => ({ ok: true, name: requested ?? "auto-name", created: true }),
    sessionNames: async () => [],
    hasSession: async () => true,
    primeSession: async () => {},
    nowMs: () => 12345,
    ...overrides,
  };
}

test("目录解析失败时返回 baddir，不建会话", async () => {
  const { createSupervisor } = await import("./create");
  let createCalled = false;
  const deps = fakeDeps({
    resolveDirectory: async () => ({ ok: false, reason: "missing" }),
    createSession: async () => {
      createCalled = true;
      return { ok: true, name: "x", created: true };
    },
  });

  const result = await createSupervisor({ cwd: "/nope", autoConfirmPermission: false, port: "7682" }, deps);

  expect(result).toEqual({ ok: false, reason: "baddir" });
  expect(createCalled).toBe(false);
});

test("该 cwd 已有存活监察者时返回 exists，不建会话", async () => {
  const { createSupervisor } = await import("./create");
  const { setSupervisor } = await import("./state");
  await setSupervisor("/proj", { session: "old-sup", startedAt: 1, autoConfirmPermission: false });
  let createCalled = false;
  const deps = fakeDeps({
    hasSession: async (session) => session === "old-sup",
    createSession: async () => {
      createCalled = true;
      return { ok: true, name: "x", created: true };
    },
  });

  const result = await createSupervisor({ cwd: "/proj", autoConfirmPermission: false, port: "7682" }, deps);

  expect(result).toEqual({ ok: false, reason: "exists" });
  expect(createCalled).toBe(false);
});

test("旧记录的会话已经不在了，视为空位可以新建", async () => {
  const { createSupervisor } = await import("./create");
  const { setSupervisor, readRegistry } = await import("./state");
  await setSupervisor("/proj", { session: "dead-sup", startedAt: 1, autoConfirmPermission: false });
  const deps = fakeDeps({
    hasSession: async () => false,
    createSession: async (_dir, requested) => ({ ok: true, name: requested ?? "auto", created: true }),
  });

  const result = await createSupervisor({ cwd: "/proj", autoConfirmPermission: true, port: "7682" }, deps);

  expect(result.ok).toBe(true);
  const registry = await readRegistry();
  expect(registry["/proj"].autoConfirmPermission).toBe(true);
});

test("createSession 失败时透传 failed，不写登记表", async () => {
  const { createSupervisor } = await import("./create");
  const { readRegistry } = await import("./state");
  const deps = fakeDeps({ createSession: async () => ({ ok: false, reason: "baddir" }) });

  const result = await createSupervisor({ cwd: "/proj", autoConfirmPermission: false, port: "7682" }, deps);

  expect(result).toEqual({ ok: false, reason: "failed" });
  expect(await readRegistry()).toEqual({});
});

test("createSession 返回 created:false（撞名而非同一个监察者）也算失败，不误认成功", async () => {
  const { createSupervisor } = await import("./create");
  const deps = fakeDeps({ createSession: async (_dir, requested) => ({ ok: true, name: requested ?? "x", created: false }) });

  const result = await createSupervisor({ cwd: "/proj", autoConfirmPermission: false, port: "7682" }, deps);

  expect(result).toEqual({ ok: false, reason: "failed" });
});

test("成功时把渲染好的提示词灌给新会话，并记入登记表", async () => {
  const { createSupervisor } = await import("./create");
  const { readRegistry } = await import("./state");
  let primed: { session: string; text: string } | null = null;
  const deps = fakeDeps({
    createSession: async (_dir, requested) => ({ ok: true, name: requested ?? "auto", created: true }),
    primeSession: async (session, text) => {
      primed = { session, text };
    },
    nowMs: () => 999,
  });

  const result = await createSupervisor({ cwd: "/proj", autoConfirmPermission: false, port: "7682" }, deps);

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(primed).not.toBeNull();
  expect(primed!.session).toBe(result.session);
  expect(primed!.text).toContain("/proj");
  expect(primed!.text).toContain(result.session);
  const registry = await readRegistry();
  expect(registry["/proj"]).toEqual({ session: result.session, startedAt: 999, autoConfirmPermission: false });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test plugins/supervisor/create.test.ts`
Expected: FAIL — `Cannot find module './create'`

- [ ] **Step 3: Implement**

```ts
// plugins/supervisor/create.ts
import { resolveDirectory } from "../../src/paths";
import { createSession } from "../../src/tmux/session-create";
import { sessionNames } from "../../src/tmux/session-list";
import { primeSession } from "../../src/tmux/prime";
import { tmux } from "../../src/tmux/run";
import { setSupervisor } from "./state";
import { logPathFor } from "./log";
import { renderSupervisorPrompt } from "./prompt";

export type CreateSupervisorParams = {
  cwd: string;
  autoConfirmPermission: boolean;
  port: string;
};

export type CreateSupervisorResult =
  | { ok: true; session: string }
  | { ok: false; reason: "baddir" | "exists" | "failed" };

export type CreateSupervisorDeps = {
  resolveDirectory: typeof resolveDirectory;
  createSession: typeof createSession;
  sessionNames: typeof sessionNames;
  hasSession: (session: string) => Promise<boolean>;
  primeSession: typeof primeSession;
  nowMs: () => number;
};

export const defaultCreateSupervisorDeps: CreateSupervisorDeps = {
  resolveDirectory,
  createSession,
  sessionNames,
  hasSession: async (session) => (await tmux(["has-session", "-t", `=${session}`])).ok,
  primeSession,
  nowMs: () => Date.now(),
};

/** `supervisor-<最后一段目录名>`，字符集跟 pickName 对 UNTARGETABLE 的要求看齐。 */
function requestedNameFor(cwd: string): string {
  const base = cwd.replace(/\/+$/, "").split("/").pop() || "session";
  return `supervisor-${base.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

export async function createSupervisor(
  params: CreateSupervisorParams,
  deps: CreateSupervisorDeps = defaultCreateSupervisorDeps,
): Promise<CreateSupervisorResult> {
  const dir = await deps.resolveDirectory(params.cwd);
  if (!dir.ok) return { ok: false, reason: "baddir" };

  const { readRegistry } = await import("./state");
  const registry = await readRegistry();
  const existing = registry[dir.path];
  if (existing && (await deps.hasSession(existing.session))) {
    return { ok: false, reason: "exists" };
  }

  const names = await deps.sessionNames();
  const created = await deps.createSession(dir.path, requestedNameFor(dir.path), names);
  // `created.created === false` means the requested name collided with an
  // unrelated existing session (the registry check above already ruled out
  // "this cwd already has a live supervisor", so this is the rarer case of a
  // same-named session that isn't ours) — never treat a reused session as a
  // fresh supervisor, and never prime text into a session we didn't just start.
  if (!created.ok || !created.created) return { ok: false, reason: "failed" };

  const prompt = renderSupervisorPrompt({
    cwd: dir.path,
    selfSession: created.name,
    autoConfirmPermission: params.autoConfirmPermission,
    logPath: logPathFor(dir.path),
    port: params.port,
  });
  await deps.primeSession(created.name, prompt);

  await setSupervisor(dir.path, {
    session: created.name,
    startedAt: deps.nowMs(),
    autoConfirmPermission: params.autoConfirmPermission,
  });

  return { ok: true, session: created.name };
}
```

Note: `readRegistry` is imported dynamically inside the function body rather than statically at the top, purely to keep this file's static imports limited to what every call path needs during review — static top-level import is equally correct; if the reviewing engineer prefers it, change `const { readRegistry } = await import("./state");` to a normal top-level `import { readRegistry, setSupervisor } from "./state";` and delete the inline `import(...)` line. Either form passes the tests above unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test plugins/supervisor/create.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add plugins/supervisor/create.ts plugins/supervisor/create.test.ts
git commit -m "监察者：查重、建会话、灌提示词的编排逻辑"
```

---

### Task 5: Plugin manifest + server routes + registration

**Files:**
- Create: `plugins/supervisor/plugin.js`
- Create: `plugins/supervisor/server.ts`
- Modify: `plugins/registry.js`
- Modify: `plugins/handlers.ts`
- Test: `plugins/supervisor/server.test.ts`

**Interfaces:**
- Consumes: `CreateSupervisorParams`, `createSupervisor` from `./create`
- Consumes: `listLiveSupervisors` from `./state`
- Consumes: `readPatrolLog` from `./log`
- Consumes: `tmux` from `../../src/tmux/run` (for the route's own liveness check, passed into `listLiveSupervisors`)
- Produces: `export async function handle(req: Request, url: URL): Promise<Response | null>` in `plugins/supervisor/server.ts`, matching `PluginHandler` from `plugins/types.ts`
- Routes:
  - `GET /api/supervisor` → `{ supervisors: Array<{ cwd: string; session: string; startedAt: number; autoConfirmPermission: boolean }> }`
  - `GET /api/supervisor/log?cwd=<path>` → `{ entries: PatrolEntry[] }` (400 if `cwd` missing)
  - `POST /api/supervisor/create` with JSON body `{ cwd: string, autoConfirmPermission?: boolean }` → `201 { session }` on success, `400 { error: "cwd" }` if `cwd` isn't a non-empty string, `409 { error: "exists" }` / `422 { error: "baddir" | "failed" }` mapped from `CreateSupervisorResult`

- [ ] **Step 1: Write the failing test**

```ts
// plugins/supervisor/server.test.ts
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "supervisor-server-"));
  process.env.TMUX_NEXT_SUPERVISOR_DIR = stateDir;
});
afterEach(() => {
  delete process.env.TMUX_NEXT_SUPERVISOR_DIR;
  rmSync(stateDir, { recursive: true, force: true });
});

test("GET /api/supervisor 在没有监察者时返回空数组", async () => {
  const { handle } = await import("./server");
  const res = await handle(
    new Request("http://x/api/supervisor"),
    new URL("http://x/api/supervisor"),
  );
  expect(res).not.toBeNull();
  expect(await res!.json()).toEqual({ supervisors: [] });
});

test("GET /api/supervisor/log 缺 cwd 参数时 400", async () => {
  const { handle } = await import("./server");
  const res = await handle(
    new Request("http://x/api/supervisor/log"),
    new URL("http://x/api/supervisor/log"),
  );
  expect(res!.status).toBe(400);
});

test("GET /api/supervisor/log 带 cwd 时返回该目录的巡检记录（这里是空数组）", async () => {
  const { handle } = await import("./server");
  const res = await handle(
    new Request("http://x/api/supervisor/log?cwd=%2Ftmp%2Fproj"),
    new URL("http://x/api/supervisor/log?cwd=%2Ftmp%2Fproj"),
  );
  expect(await res!.json()).toEqual({ entries: [] });
});

test("不认识的子路径返回 null，交回给内核 404", async () => {
  const { handle } = await import("./server");
  const res = await handle(
    new Request("http://x/api/supervisor/nonesuch"),
    new URL("http://x/api/supervisor/nonesuch"),
  );
  expect(res).toBeNull();
});

test("插件注册表与服务端表保持同步（既有断言，验证接线正确）", async () => {
  const { PLUGINS } = await import("../registry.js");
  const { SERVERS } = await import("../handlers");
  expect(PLUGINS.map((p: { id: string }) => p.id)).toContain("supervisor");
  expect(Object.keys(SERVERS)).toContain("supervisor");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test plugins/supervisor/server.test.ts`
Expected: FAIL — `Cannot find module './server'`

- [ ] **Step 3: Implement**

```js
// plugins/supervisor/plugin.js
// @ts-check
/**
 * 监察者：一个自己去理解上下文、巡视同一 cwd 下其他 Claude Code 会话的 agent。
 * 检测/介入的判断全在首条提示词里（见 prompt.ts），这个插件只管创建入口、
 * 一人一岗的登记表，和只读的巡检记录页。
 */

/** @type {import("../types").Plugin} */
export default {
  id: "supervisor",
  titleKey: "supervisor.title",
  icon:
    '<circle cx="12" cy="12" r="3"/>' +
    '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>',
  page: { mainId: "list" },
  i18n: {
    zh: {
      "supervisor.title": "监察者",
      "supervisor.cwdPlaceholder": "要监控的目录",
      "supervisor.autoConfirmLabel": "允许自动确认权限提示",
      "supervisor.createButton": "创建监察者",
      "supervisor.createFailed_baddir": "目录无效",
      "supervisor.createFailed_exists": "该目录已有监察者",
      "supervisor.createFailed_failed": "创建失败",
      "supervisor.loadFailed": "加载失败",
      "supervisor.empty": "还没有监察者",
      "supervisor.logEmpty": "还没有巡检记录",
      "supervisor.autoConfirmOn": "自动确认权限：开",
      "supervisor.autoConfirmOff": "自动确认权限：关",
      "supervisor.actionAnswered": "已代答",
      "supervisor.actionNotified": "已上报",
      "supervisor.actionNoop": "无需处理",
    },
    en: {
      "supervisor.title": "Supervisor",
      "supervisor.cwdPlaceholder": "Directory to watch",
      "supervisor.autoConfirmLabel": "Allow auto-confirming permission prompts",
      "supervisor.createButton": "Create supervisor",
      "supervisor.createFailed_baddir": "Invalid directory",
      "supervisor.createFailed_exists": "This directory already has a supervisor",
      "supervisor.createFailed_failed": "Could not create",
      "supervisor.loadFailed": "Could not load",
      "supervisor.empty": "No supervisors yet",
      "supervisor.logEmpty": "No patrol entries yet",
      "supervisor.autoConfirmOn": "Auto-confirm permissions: on",
      "supervisor.autoConfirmOff": "Auto-confirm permissions: off",
      "supervisor.actionAnswered": "Answered",
      "supervisor.actionNotified": "Reported",
      "supervisor.actionNoop": "No action needed",
    },
  },
};
```

```ts
// plugins/supervisor/server.ts
import { tmux } from "../../src/tmux/run";
import { listLiveSupervisors } from "./state";
import { readPatrolLog } from "./log";
import { createSupervisor } from "./create";

const LOG_LIMIT = 200;

const hasSession = async (session: string) => (await tmux(["has-session", "-t", `=${session}`])).ok;

export async function handle(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/supervisor" && req.method === "GET") {
    const supervisors = await listLiveSupervisors(hasSession);
    return Response.json({ supervisors });
  }

  if (url.pathname === "/api/supervisor/log" && req.method === "GET") {
    const cwd = url.searchParams.get("cwd");
    if (!cwd) return Response.json({ error: "cwd" }, { status: 400 });
    const entries = await readPatrolLog(cwd, LOG_LIMIT);
    return Response.json({ entries });
  }

  if (url.pathname === "/api/supervisor/create" && req.method === "POST") {
    let body: { cwd?: unknown; autoConfirmPermission?: unknown };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "cwd" }, { status: 400 });
    }
    if (typeof body.cwd !== "string" || !body.cwd.trim()) {
      return Response.json({ error: "cwd" }, { status: 400 });
    }

    const result = await createSupervisor({
      cwd: body.cwd,
      autoConfirmPermission: body.autoConfirmPermission === true,
      port: url.port || (url.protocol === "https:" ? "443" : "80"),
    });

    if (!result.ok) {
      const status = result.reason === "exists" ? 409 : 422;
      return Response.json({ error: result.reason }, { status });
    }
    return Response.json({ session: result.session }, { status: 201 });
  }

  return null;
}
```

Now register the plugin in both isomorphic tables:

```js
// plugins/registry.js — modify
import gallery from "./gallery/plugin.js";
import notifications from "./notifications/plugin.js";
import jira from "./jira/plugin.js";
import supervisor from "./supervisor/plugin.js";

/** @type {import("./types").Plugin[]} */
export const PLUGINS = [gallery, notifications, jira, supervisor];
```

```ts
// plugins/handlers.ts — modify: add the import near the other `handle as X` imports
import { handle as supervisor } from "./supervisor/server";
```

```ts
// plugins/handlers.ts — modify: add an entry to SERVERS
export const SERVERS: Record<string, PluginServer> = {
  gallery: { handle: gallery },
  notifications: { handle: notifications },
  supervisor: { handle: supervisor },
  jira: { /* ...unchanged... */ },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test plugins/supervisor/server.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the existing plugin-sync test to confirm nothing else broke**

Run: `bun test plugins/registry.test.ts src/plugin-routing.test.ts`
Expected: PASS — `registry.test.ts`'s existing "every manifest has a server entry" assertion now also covers `supervisor`.

- [ ] **Step 6: Commit**

```bash
git add plugins/supervisor/plugin.js plugins/supervisor/server.ts plugins/supervisor/server.test.ts plugins/registry.js plugins/handlers.ts
git commit -m "监察者：插件路由 + 接入内核两张表"
```

---

### Task 6: Front-end page

**Files:**
- Create: `plugins/supervisor/public/supervisor.js`
- Test: `plugins/supervisor/public-render.test.ts`

**Interfaces:**
- Consumes: `initLang`, `tr` from `../../i18n-apply.js`; `renderHeader` from `../../nav.js`; `url` from `../../root.js` — same three imports every other plugin page uses (see `plugins/notifications/public/notifications.js`).
- Consumes `GET /api/supervisor`, `GET /api/supervisor/log?cwd=`, `POST /api/supervisor/create` from Task 5.
- This file is **not** `@ts-check`'d, per the existing rule for plugin pages (import specifiers are written for the served URL, two segments deep, not the on-disk path three segments deep).

- [ ] **Step 1: Write the failing render test**

Follows the `src/new-page.test.ts` pattern (happy-dom, per the "a browser module that renders must have a test that renders it" rule) but drives the module directly with a fetch stub, since this page has no framework to mount:

```ts
// plugins/supervisor/public-render.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeEach(() => {
  GlobalRegistrator.register();
  document.body.innerHTML = `
    <header id="header"></header>
    <main id="list"></main>
  `;
});
afterEach(async () => {
  await GlobalRegistrator.unregister();
});

test("空列表时渲染 empty 状态", async () => {
  (globalThis as any).fetch = async (input: string) => {
    if (String(input).includes("/api/supervisor/log")) {
      return new Response(JSON.stringify({ entries: [] }));
    }
    return new Response(JSON.stringify({ supervisors: [] }));
  };

  const mod = await import(`./public/supervisor.js?empty=${Math.random()}`);
  await mod.load();

  expect(document.getElementById("list")!.textContent).toContain("");
  expect(document.querySelectorAll(".empty").length).toBeGreaterThan(0);
});

test("有监察者时，每个卡片显示 cwd、会话名和自动确认状态", async () => {
  (globalThis as any).fetch = async (input: string) => {
    if (String(input).includes("/api/supervisor/log")) {
      return new Response(
        JSON.stringify({
          entries: [
            {
              ts: "2026-09-08T10:00:00Z",
              checked: [{ session: "web-1-a", turn: "waiting", note: "问了一个问题" }],
              actions: [{ session: "web-1-a", type: "answered", detail: "回答了" }],
            },
          ],
        }),
      );
    }
    return new Response(
      JSON.stringify({
        supervisors: [
          { cwd: "/tmp/proj", session: "supervisor-proj", startedAt: 1000, autoConfirmPermission: true },
        ],
      }),
    );
  };

  const mod = await import(`./public/supervisor.js?full=${Math.random()}`);
  await mod.load();

  const text = document.getElementById("list")!.textContent ?? "";
  expect(text).toContain("/tmp/proj");
  expect(text).toContain("supervisor-proj");
  expect(text).toContain("web-1-a");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test plugins/supervisor/public-render.test.ts`
Expected: FAIL — `Cannot find module './public/supervisor.js'`

- [ ] **Step 3: Implement**

```js
// plugins/supervisor/public/supervisor.js
// Not @ts-check'd: import specifiers here are written for the URL this file
// is served at (/p/supervisor/supervisor.js, two segments deep), not the
// on-disk path (plugins/supervisor/public/supervisor.js, three deep) — same
// exemption as notifications.js and gallery.js.

import { initLang, tr } from "../../i18n-apply.js";
import { renderHeader } from "../../nav.js";
import { url } from "../../root.js";

const listEl = document.getElementById("list");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function actionLabel(type) {
  if (type === "answered") return tr("supervisor.actionAnswered");
  if (type === "notified") return tr("supervisor.actionNotified");
  return tr("supervisor.actionNoop");
}

function logRow(entry) {
  const row = el("div", "row");
  row.append(el("span", "time", entry.ts));
  const summary = entry.actions.length
    ? entry.actions.map((a) => `${a.session}: ${actionLabel(a.type)} — ${a.detail}`).join("；")
    : entry.checked.map((c) => `${c.session}: ${c.turn ?? "?"}`).join("；");
  row.append(el("span", "preview", summary));
  return row;
}

async function supervisorCard(sup) {
  const card = el("div", "card");
  const main = el("div", "card-main");
  main.append(el("span", "name", sup.cwd));
  main.append(el("span", "time", sup.session));
  main.append(el("span", "preview", tr(sup.autoConfirmPermission ? "supervisor.autoConfirmOn" : "supervisor.autoConfirmOff")));
  card.append(main);

  let entries = [];
  try {
    ({ entries } = await (await fetch(url(`api/supervisor/log?cwd=${encodeURIComponent(sup.cwd)}`))).json());
  } catch {
    entries = [];
  }

  if (!entries.length) {
    card.append(el("p", "empty", tr("supervisor.logEmpty")));
  } else {
    const log = el("div", "log");
    for (const entry of entries.slice().reverse()) log.append(logRow(entry));
    card.append(log);
  }

  return card;
}

function createForm() {
  const form = el("form", "supervisor-create");
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = tr("supervisor.cwdPlaceholder");
  input.required = true;

  const label = el("label");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  label.append(checkbox, document.createTextNode(tr("supervisor.autoConfirmLabel")));

  const submit = el("button", "btn primary", tr("supervisor.createButton"));
  submit.type = "submit";

  const error = el("p", "empty");
  error.hidden = true;

  form.append(input, label, submit, error);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.hidden = true;
    try {
      const res = await fetch(url("api/supervisor/create"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: input.value, autoConfirmPermission: checkbox.checked }),
      });
      if (!res.ok) {
        const { error: reason } = await res.json();
        error.textContent = tr(`supervisor.createFailed_${reason}`) || tr("supervisor.createFailed_failed");
        error.hidden = false;
        return;
      }
      input.value = "";
      checkbox.checked = false;
      await load();
    } catch {
      error.textContent = tr("supervisor.createFailed_failed");
      error.hidden = false;
    }
  });

  return form;
}

export async function load() {
  let supervisors;
  try {
    ({ supervisors } = await (await fetch(url("api/supervisor"))).json());
  } catch {
    listEl.replaceChildren(createForm(), el("p", "empty", tr("supervisor.loadFailed")));
    return;
  }

  const nodes = [createForm()];
  if (!supervisors.length) {
    nodes.push(el("p", "empty", tr("supervisor.empty")));
  } else {
    const cards = await Promise.all(supervisors.map(supervisorCard));
    nodes.push(...cards);
  }
  listEl.replaceChildren(...nodes);
}

initLang().then(() => {
  renderHeader("supervisor");
  load();
});

export {};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test plugins/supervisor/public-render.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Confirm the file still bundles for the browser**

Run: `bun test src/public-parses.test.ts`
Expected: PASS — this test already globs every file under `plugins/*/public/`, so `supervisor.js` needs no separate registration; it just must not error when `Bun.build` resolves its imports.

- [ ] **Step 6: Commit**

```bash
git add plugins/supervisor/public/supervisor.js plugins/supervisor/public-render.test.ts
git commit -m "监察者：展示面板（创建表单 + 巡检记录时间线）"
```

---

### Task 7: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`
Expected: PASS. If `plugins/supervisor/public/supervisor.js` is picked up by `tsc` and fails, confirm `tsconfig.json`'s existing exclusion for plugin `public/` files (`checkJs: false` scope) already covers it the same way `plugins/notifications/public/notifications.js` is covered — no tsconfig change should be needed since the new file sits in the same excluded shape.

- [ ] **Step 2: Full suite**

Run: `bun test`
Expected: PASS, including the pre-existing `plugins/registry.test.ts` (now also validating `supervisor` is in both tables) and `src/i18n.test.ts` (now also scanning `supervisor.*` keys — every `tr("supervisor....")`/`t("supervisor....")` call added in Tasks 5–6 must have a matching entry in **both** `zh` and `en` in `plugins/supervisor/plugin.js`; the dynamic `supervisor.createFailed_${reason}` lookup in Task 6 is a template-literal key, which `i18n.test.ts`'s scanner cannot see as a static reference — cross-check by hand that `createFailed_baddir` / `createFailed_exists` / `createFailed_failed` are the exact three keys defined in `plugin.js` and the exact three `CreateSupervisorResult["reason"]` values from Task 4, since nothing else enforces that match).

- [ ] **Step 3: Manually verify the create flow against a real server**

This step exercises the one thing no unit test covers end-to-end: a real tmux session actually receiving the primed prompt. Per CLAUDE.md, do this from a worktree, and clean up the session it creates afterward (`tmux kill-session -t "=<the created name>"`), never touching any other session on the machine.

```bash
bun run src/index.ts &  # note the port it prints
curl -s -X POST http://127.0.0.1:<port>/api/supervisor/create \
  -H 'Content-Type: application/json' \
  -d '{"cwd":"'"$(pwd)"'","autoConfirmPermission":false}'
# expect: {"session":"supervisor-<dirname>"}
tmux capture-pane -p -t "=supervisor-<dirname>:"
# expect: the rendered prompt visible as the session's first input, and Claude
# Code having started responding to it
tmux kill-session -t "=supervisor-<dirname>"
```

Expected: the created session's pane shows the prompt text (cwd, session name, log path, port all substituted, no `{{...}}` left) and Claude Code has begun acting on it.

- [ ] **Step 4: No commit for this task** — it is verification only; if any step surfaces a bug, fix it as a normal amendment to the task where the bug was introduced (new commit, per this repo's "never amend" rule) and re-run this task's steps.
