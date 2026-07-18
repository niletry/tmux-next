# 手机友好的 tmux Web 客户端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在手机浏览器里查看和操作本机已存在的 tmux session（主要负载是 Claude Code），提供 session 列表页与单 pane 全屏终端页。

**Architecture:** 后端用 Bun + TypeScript，通过 `tmux -C attach`（control mode）与 tmux server 通信，解析其文本协议得到按 pane 分发的输出流与结构化事件。每个终端连接创建一个 grouped session 作为可销毁的 attach 点。前端两个页面：纯 HTML 的 session 列表页（含 `capture-pane` 画面预览），与 xterm.js 单 pane 终端页。应用只监听 loopback，鉴权由现有 Caddy 承担。

**Tech Stack:** Bun 1.3.6（运行时 + 测试 + 打包）、TypeScript、xterm.js 5.5 + WebGL addon、tmux 3.7b。前端不使用框架，原生 DOM。

## Global Constraints

- **运行时：** Bun 1.3.6（`bun test` 作测试框架，`Bun.serve` 作 HTTP/WS 服务）。Node v22.16.0 也在机器上，但统一用 Bun。
- **tmux 版本：** 3.7b。所有 tmux 命令须在此版本验证。
- **监听地址：** 只监听 `127.0.0.1`，**不得**监听 `0.0.0.0` 或 `::`。鉴权由 Caddy 负责，应用内不实现任何鉴权。
- **终端宽度：** 固定 80 列。设置尺寸**只能**用 `refresh-client -C 80,<rows>`，**禁止**使用 `resize-window` 或 `window-size manual`——后者会钉死尺寸，破坏「回到桌面自动恢复」的自愈行为。
- **grouped session 命名：** 一律 `web-<uuid>`。清理逻辑依赖此前缀。
- **capture-pane 取可见画面：** 列表页预览**禁止**使用 `-S` 参数。已实测 `-S` 会抓入陈旧的滚动历史产生噪音。
- **语言：** 代码标识符与注释用英文；面向用户的界面文案用中文。
- **不引入前端框架**（无 React/Vue/Svelte）。

---

### Task 1: control mode 协议解析器

`control-client` 的核心状态机。tmux control mode 在一条流里交错发送两类东西：命令的输出块（`%begin` … `%end`/`%error`）和异步通知（`%output`、`%window-add` 等）。man page 保证「A notification will never occur inside an output block」，解析器依赖这一点。

本任务只做**纯解析**：字节流进，类型化事件出。不碰子进程、不碰网络，因此可以喂录制好的字节流做单测。

**Files:**
- Create: `src/tmux/control-parser.ts`
- Test: `src/tmux/control-parser.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  ```ts
  export type ControlEvent =
    | { type: "block"; commandNumber: number; ok: boolean; lines: string[] }
    | { type: "output"; paneId: string; data: Uint8Array }
    | { type: "notification"; name: string; args: string[] }

  export class ControlParser {
    push(chunk: Uint8Array): ControlEvent[]
  }
  export function unescapeOctal(s: string): Uint8Array
  ```

- [ ] **Step 1: 写失败的测试**

创建 `src/tmux/control-parser.test.ts`：

```ts
import { expect, test } from "bun:test";
import { ControlParser, unescapeOctal } from "./control-parser";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder().decode(u);

test("unescapeOctal decodes octal escapes and passes printable bytes through", () => {
  expect(dec(unescapeOctal("hello"))).toBe("hello");
  expect(dec(unescapeOctal("\\033[38;5;12m"))).toBe("[38;5;12m");
  expect(dec(unescapeOctal("a\\015\\012b"))).toBe("a\r\nb");
});

test("unescapeOctal treats a backslash not followed by octal as a literal", () => {
  expect(dec(unescapeOctal("a\\\\b"))).toBe("a\\\\b");
  expect(dec(unescapeOctal("C:\\path"))).toBe("C:\\path");
});

test("parses an output block into a single block event", () => {
  const p = new ControlParser();
  const events = p.push(enc(
    "%begin 1363006971 2 1\n" +
    "0: ksh* (1 panes) [80x24]\n" +
    "%end 1363006971 2 1\n"
  ));
  expect(events).toEqual([
    { type: "block", commandNumber: 2, ok: true, lines: ["0: ksh* (1 panes) [80x24]"] },
  ]);
});

test("marks a block ending in %error as not ok", () => {
  const p = new ControlParser();
  const events = p.push(enc(
    "%begin 1 7 1\n" + "no such session\n" + "%error 1 7 1\n"
  ));
  expect(events).toEqual([
    { type: "block", commandNumber: 7, ok: false, lines: ["no such session"] },
  ]);
});

test("parses %output into pane id and unescaped bytes", () => {
  const p = new ControlParser();
  const events = p.push(enc("%output %3 hi\\033[0m\n"));
  expect(events.length).toBe(1);
  const e = events[0];
  expect(e.type).toBe("output");
  if (e.type !== "output") throw new Error("wrong type");
  expect(e.paneId).toBe("%3");
  expect(dec(e.data)).toBe("hi[0m");
});

test("parses other notifications generically", () => {
  const p = new ControlParser();
  const events = p.push(enc("%window-add @14\n%sessions-changed\n"));
  expect(events).toEqual([
    { type: "notification", name: "window-add", args: ["@14"] },
    { type: "notification", name: "sessions-changed", args: [] },
  ]);
});

test("reassembles events split across chunk boundaries", () => {
  const p = new ControlParser();
  expect(p.push(enc("%outp"))).toEqual([]);
  expect(p.push(enc("ut %1 ab"))).toEqual([]);
  const events = p.push(enc("c\n"));
  expect(events.length).toBe(1);
  if (events[0].type !== "output") throw new Error("wrong type");
  expect(dec(events[0].data)).toBe("abc");
});

test("does not treat a %-prefixed line inside a block as a notification", () => {
  const p = new ControlParser();
  const events = p.push(enc(
    "%begin 1 3 1\n" + "%output is documented\n" + "%end 1 3 1\n"
  ));
  expect(events).toEqual([
    { type: "block", commandNumber: 3, ok: true, lines: ["%output is documented"] },
  ]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/tmux/control-parser.test.ts`
Expected: FAIL — `Cannot find module './control-parser'`

- [ ] **Step 3: 实现解析器**

创建 `src/tmux/control-parser.ts`：

```ts
export type ControlEvent =
  | { type: "block"; commandNumber: number; ok: boolean; lines: string[] }
  | { type: "output"; paneId: string; data: Uint8Array }
  | { type: "notification"; name: string; args: string[] };

const OCTAL = /[0-7]/;

/**
 * tmux escapes non-printable bytes and backslash as octal \xxx in %output.
 * A backslash not followed by three octal digits is a literal backslash.
 */
export function unescapeOctal(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (
      s[i] === "\\" &&
      OCTAL.test(s[i + 1] ?? "") && OCTAL.test(s[i + 2] ?? "") && OCTAL.test(s[i + 3] ?? "")
    ) {
      out.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      // Non-ASCII characters arrive as UTF-8 already; re-encode them.
      const code = s.codePointAt(i)!;
      if (code < 0x80) {
        out.push(code);
      } else {
        const bytes = new TextEncoder().encode(String.fromCodePoint(code));
        for (const b of bytes) out.push(b);
        if (code > 0xffff) i++;
      }
    }
  }
  return new Uint8Array(out);
}

/**
 * Splits a tmux control mode stream into typed events.
 *
 * Relies on the documented guarantee that a notification never occurs inside
 * an output block, so a simple in-block flag is sufficient.
 */
export class ControlParser {
  #buf = "";
  #inBlock = false;
  #blockNumber = 0;
  #blockLines: string[] = [];

  push(chunk: Uint8Array): ControlEvent[] {
    // "binary" keeps one char per byte so octal unescaping stays byte-exact.
    this.#buf += Buffer.from(chunk).toString("binary");
    const events: ControlEvent[] = [];

    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) !== -1) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      const event = this.#line(line);
      if (event) events.push(event);
    }
    return events;
  }

  #line(line: string): ControlEvent | null {
    if (this.#inBlock) {
      if (line.startsWith("%end ") || line.startsWith("%error ")) {
        this.#inBlock = false;
        return {
          type: "block",
          commandNumber: this.#blockNumber,
          ok: line.startsWith("%end "),
          lines: this.#blockLines,
        };
      }
      this.#blockLines.push(line);
      return null;
    }

    if (line.startsWith("%begin ")) {
      this.#inBlock = true;
      this.#blockNumber = Number(line.split(" ")[2]);
      this.#blockLines = [];
      return null;
    }

    if (line.startsWith("%output ")) {
      const sp = line.indexOf(" ", 8);
      return {
        type: "output",
        paneId: line.slice(8, sp),
        data: unescapeOctal(line.slice(sp + 1)),
      };
    }

    if (line.startsWith("%")) {
      const parts = line.slice(1).split(" ");
      return { type: "notification", name: parts[0], args: parts.slice(1) };
    }

    return null;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/tmux/control-parser.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: 提交**

```bash
git add src/tmux/control-parser.ts src/tmux/control-parser.test.ts
git commit -m "feat: add tmux control mode protocol parser"
```

---

### Task 2: control mode 客户端进程封装

把解析器接到真实的 `tmux -C attach` 子进程上，提供「发命令、等这条命令的输出块」的请求-响应语义（control mode 按命令编号顺序返回，所以用队列即可）。

**Files:**
- Create: `src/tmux/control-client.ts`
- Test: `src/tmux/control-client.test.ts`

**Interfaces:**
- Consumes: `ControlParser`, `ControlEvent` from `src/tmux/control-parser.ts`
- Produces:
  ```ts
  export class ControlClient {
    static attach(target: string): Promise<ControlClient>
    command(cmd: string): Promise<string[]>   // rejects on %error
    onOutput(paneId: string, fn: (data: Uint8Array) => void): () => void
    onNotification(fn: (name: string, args: string[]) => void): () => void
    close(): void
  }
  ```

- [ ] **Step 1: 写失败的测试**

这些测试**跑真的 tmux**，用一次性 session，因此结束时必须清理。

创建 `src/tmux/control-client.test.ts`：

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { ControlClient } from "./control-client";

const SESSION = "cc-test-" + Math.random().toString(36).slice(2, 8);

beforeAll(async () => {
  await Bun.$`tmux new-session -d -s ${SESSION} -x 80 -y 24`.quiet();
});

afterAll(async () => {
  await Bun.$`tmux kill-session -t ${SESSION}`.quiet().nothrow();
});

test("runs a command and returns its output lines", async () => {
  const client = await ControlClient.attach(SESSION);
  const lines = await client.command(`display-message -p -t ${SESSION} '#{session_name}'`);
  expect(lines).toEqual([SESSION]);
  client.close();
});

test("rejects when tmux reports an error", async () => {
  const client = await ControlClient.attach(SESSION);
  await expect(client.command("display-message -p -t no-such-session-xyz '#{session_name}'"))
    .rejects.toThrow();
  client.close();
});

test("keeps command results in order under concurrency", async () => {
  const client = await ControlClient.attach(SESSION);
  const [a, b, c] = await Promise.all([
    client.command("display-message -p 'one'"),
    client.command("display-message -p 'two'"),
    client.command("display-message -p 'three'"),
  ]);
  expect([a[0], b[0], c[0]]).toEqual(["one", "two", "three"]);
  client.close();
});

test("delivers pane output to the registered listener", async () => {
  const client = await ControlClient.attach(SESSION);
  const paneId = (await client.command(`display-message -p -t ${SESSION} '#{pane_id}'`))[0];

  let seen = "";
  const stop = client.onOutput(paneId, (d) => { seen += new TextDecoder().decode(d); });

  await client.command(`send-keys -t ${paneId} 'echo MARKER_9f3a' Enter`);
  await Bun.sleep(600);

  expect(seen).toContain("MARKER_9f3a");
  stop();
  client.close();
});

test("attach rejects for a session that does not exist", async () => {
  await expect(ControlClient.attach("no-such-session-xyz")).rejects.toThrow();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/tmux/control-client.test.ts`
Expected: FAIL — `Cannot find module './control-client'`

- [ ] **Step 3: 实现客户端**

创建 `src/tmux/control-client.ts`：

```ts
import { ControlParser } from "./control-parser";

type Pending = { resolve: (lines: string[]) => void; reject: (e: Error) => void };

export class ControlClient {
  #proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  #parser = new ControlParser();
  // tmux returns command blocks in the order the commands were sent.
  #pending: Pending[] = [];
  #outputListeners = new Map<string, Set<(data: Uint8Array) => void>>();
  #notificationListeners = new Set<(name: string, args: string[]) => void>();
  #closed = false;

  private constructor(proc: Bun.Subprocess<"pipe", "pipe", "pipe">) {
    this.#proc = proc;
  }

  static async attach(target: string): Promise<ControlClient> {
    const proc = Bun.spawn(["tmux", "-C", "attach", "-t", target], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const client = new ControlClient(proc);
    client.#pump();

    // A failed attach makes tmux exit almost immediately; give it a moment.
    const exited = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(300).then(() => false),
    ]);
    if (exited) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`tmux attach failed for ${target}: ${err.trim()}`);
    }
    return client;
  }

  async #pump() {
    for await (const chunk of this.#proc.stdout as ReadableStream<Uint8Array>) {
      for (const event of this.#parser.push(chunk)) {
        if (event.type === "block") {
          const p = this.#pending.shift();
          if (!p) continue;
          if (event.ok) p.resolve(event.lines);
          else p.reject(new Error(event.lines.join("\n") || "tmux command failed"));
        } else if (event.type === "output") {
          const set = this.#outputListeners.get(event.paneId);
          if (set) for (const fn of set) fn(event.data);
        } else {
          for (const fn of this.#notificationListeners) fn(event.name, event.args);
        }
      }
    }
    this.#failAllPending(new Error("tmux control client closed"));
  }

  #failAllPending(e: Error) {
    const pending = this.#pending;
    this.#pending = [];
    for (const p of pending) p.reject(e);
  }

  command(cmd: string): Promise<string[]> {
    if (this.#closed) return Promise.reject(new Error("client is closed"));
    return new Promise((resolve, reject) => {
      this.#pending.push({ resolve, reject });
      this.#proc.stdin.write(cmd + "\n");
      this.#proc.stdin.flush();
    });
  }

  onOutput(paneId: string, fn: (data: Uint8Array) => void): () => void {
    let set = this.#outputListeners.get(paneId);
    if (!set) { set = new Set(); this.#outputListeners.set(paneId, set); }
    set.add(fn);
    return () => { set!.delete(fn); };
  }

  onNotification(fn: (name: string, args: string[]) => void): () => void {
    this.#notificationListeners.add(fn);
    return () => { this.#notificationListeners.delete(fn); };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#proc.kill();
    this.#failAllPending(new Error("tmux control client closed"));
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/tmux/control-client.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: 确认没有遗留测试 session**

Run: `tmux ls -F '#{session_name}' | grep '^cc-test-' || echo "no leftovers"`
Expected: `no leftovers`

- [ ] **Step 6: 提交**

```bash
git add src/tmux/control-client.ts src/tmux/control-client.test.ts
git commit -m "feat: add tmux control mode client with request/response semantics"
```

---

### Task 3: session 列表与画面预览

列表页的数据来源。规则已在设计阶段用真实 session 实测确定：只抓可见画面、滤掉 chrome、取最后 4 行、`❯` 行单独作为「待发送」。

**Files:**
- Create: `src/tmux/session-list.ts`
- Test: `src/tmux/session-list.test.ts`

**Interfaces:**
- Consumes: 无（直接跑 `tmux` 命令，不经 control mode——列表页不需要长连接）
- Produces:
  ```ts
  export type SessionSummary = {
    name: string
    windowWidth: number
    windowHeight: number
    lastActivityEpoch: number
    attached: boolean
    preview: string[]      // 最多 4 行
    pendingInput: string | null   // ❯ 行的内容，无则 null
    idle: boolean          // agent 已停下在等人
  }
  export function extractPreview(screen: string): { preview: string[]; pendingInput: string | null; idle: boolean }
  export function listSessions(): Promise<SessionSummary[]>
  ```

- [ ] **Step 1: 写失败的测试**

`extractPreview` 是纯函数，用真实 session 抓来的样本做输入。

创建 `src/tmux/session-list.test.ts`：

```ts
import { expect, test } from "bun:test";
import { extractPreview, listSessions } from "./session-list";

// 取自真实 Claude Code session 的可见画面
const CLAUDE_SCREEN = [
  "  - 看一下 PR 的 CI 状态 / 有没有评论",
  "  要哪个说一声。",
  "",
  "✻ Cogitated for 1m 21s",
  "",
  "──────────────────────────────────────────────────────────────",
  "❯ rebase 到最新 master 并检查冲突",
  "──────────────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent",
].join("\n");

test("drops box drawing, blank lines and known chrome", () => {
  const { preview } = extractPreview(CLAUDE_SCREEN);
  expect(preview).toEqual([
    "  - 看一下 PR 的 CI 状态 / 有没有评论",
    "  要哪个说一声。",
    "✻ Cogitated for 1m 21s",
  ]);
  expect(preview.some((l) => l.includes("bypass permissions"))).toBe(false);
  expect(preview.some((l) => /^[─\s]+$/.test(l))).toBe(false);
});

test("pulls the prompt line out as pending input", () => {
  const { pendingInput } = extractPreview(CLAUDE_SCREEN);
  expect(pendingInput).toBe("rebase 到最新 master 并检查冲突");
});

test("reports an empty prompt as no pending input", () => {
  const screen = ["✻ Brewed for 3m 55s", "❯ ", "──────────"].join("\n");
  expect(extractPreview(screen).pendingInput).toBe(null);
});

test("detects idle from the completion marker", () => {
  expect(extractPreview(CLAUDE_SCREEN).idle).toBe(true);
  expect(extractPreview("still working...\n").idle).toBe(false);
});

test("keeps at most four preview lines, taking the last ones", () => {
  const screen = ["l1", "l2", "l3", "l4", "l5", "l6"].join("\n");
  expect(extractPreview(screen).preview).toEqual(["l3", "l4", "l5", "l6"]);
});

test("survives a screen with nothing but chrome", () => {
  const screen = ["──────────", "", "  ⏵⏵ bypass permissions on"].join("\n");
  const r = extractPreview(screen);
  expect(r.preview).toEqual([]);
  expect(r.pendingInput).toBe(null);
});

test("lists the real sessions on this machine", async () => {
  const sessions = await listSessions();
  expect(sessions.length).toBeGreaterThan(0);
  for (const s of sessions) {
    expect(s.name).toBeTruthy();
    expect(s.windowWidth).toBeGreaterThan(0);
    expect(s.preview.length).toBeLessThanOrEqual(4);
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/tmux/session-list.test.ts`
Expected: FAIL — `Cannot find module './session-list'`

- [ ] **Step 3: 实现**

创建 `src/tmux/session-list.ts`：

```ts
export type SessionSummary = {
  name: string;
  windowWidth: number;
  windowHeight: number;
  lastActivityEpoch: number;
  attached: boolean;
  preview: string[];
  pendingInput: string | null;
  idle: boolean;
};

const PREVIEW_LINES = 4;

// Box drawing only, or known Claude Code chrome that carries no information.
const CHROME = [
  /^[\s─│╭╮╰╯━┃┏┓┗┛|]*$/,
  /bypass permissions/,
  /enter to collapse/,
  /new task\? \/clear/,
  /^\s*\/rc\s*$/,
  /\? for shortcuts/,
];

// Claude Code prints this once a turn finishes, e.g. "✻ Cogitated for 1m 21s".
const IDLE_MARKER = /^\s*[✻✽✢·*]\s+\w+ for \d/;

export function extractPreview(screen: string): {
  preview: string[];
  pendingInput: string | null;
  idle: boolean;
} {
  const lines = screen.split("\n");
  let pendingInput: string | null = null;
  const kept: string[] = [];

  for (const line of lines) {
    const prompt = line.match(/^\s*❯\s?(.*)$/);
    if (prompt) {
      const text = prompt[1].trim();
      pendingInput = text.length > 0 ? text : null;
      continue;
    }
    if (CHROME.some((re) => re.test(line))) continue;
    kept.push(line.replace(/\s+$/, ""));
  }

  return {
    preview: kept.slice(-PREVIEW_LINES),
    pendingInput,
    idle: kept.some((l) => IDLE_MARKER.test(l)),
  };
}

export async function listSessions(): Promise<SessionSummary[]> {
  const fmt = "#{session_name}\t#{window_width}\t#{window_height}\t#{session_activity}\t#{session_attached}";
  const out = await Bun.$`tmux list-sessions -F ${fmt}`.quiet().nothrow();
  if (out.exitCode !== 0) return [];

  const rows = out.stdout.toString().trim().split("\n").filter(Boolean);
  const summaries = await Promise.all(rows.map(async (row) => {
    const [name, w, h, activity, attached] = row.split("\t");
    // Visible screen only: -S pulls in stale wrapped scrollback (verified).
    const cap = await Bun.$`tmux capture-pane -p -t ${name}`.quiet().nothrow();
    const screen = cap.exitCode === 0 ? cap.stdout.toString() : "";
    return {
      name,
      windowWidth: Number(w),
      windowHeight: Number(h),
      lastActivityEpoch: Number(activity),
      attached: attached === "1",
      ...extractPreview(screen),
    };
  }));

  // Sessions the user is waiting on first, then most recently active.
  return summaries.sort((a, b) =>
    Number(b.idle) - Number(a.idle) || b.lastActivityEpoch - a.lastActivityEpoch);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/tmux/session-list.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: 提交**

```bash
git add src/tmux/session-list.ts src/tmux/session-list.test.ts
git commit -m "feat: add session listing with screen preview extraction"
```

---

### Task 4: grouped session 生命周期管理

每个终端连接创建一个 `web-<uuid>` grouped session 作为可销毁的 attach 点，断开时销毁，并周期性清理孤儿（进程被 `kill -9` 时主动清理不会执行）。

**Files:**
- Create: `src/tmux/session-manager.ts`
- Test: `src/tmux/session-manager.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  ```ts
  export const WEB_SESSION_PREFIX = "web-"
  export function createWebSession(target: string): Promise<string>  // 返回新 session 名
  export function destroyWebSession(name: string): Promise<void>
  export function reapOrphanWebSessions(): Promise<string[]>         // 返回被清理的名字
  ```

- [ ] **Step 1: 写失败的测试**

创建 `src/tmux/session-manager.test.ts`：

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  WEB_SESSION_PREFIX, createWebSession, destroyWebSession, reapOrphanWebSessions,
} from "./session-manager";

const BASE = "sm-test-" + Math.random().toString(36).slice(2, 8);

const exists = async (name: string) =>
  (await Bun.$`tmux has-session -t ${name}`.quiet().nothrow()).exitCode === 0;

beforeAll(async () => {
  await Bun.$`tmux new-session -d -s ${BASE} -x 120 -y 40`.quiet();
});

afterAll(async () => {
  await Bun.$`tmux kill-session -t ${BASE}`.quiet().nothrow();
  for (const n of await reapOrphanWebSessions()) void n;
});

test("creates a grouped session sharing the target's windows", async () => {
  const name = await createWebSession(BASE);
  expect(name.startsWith(WEB_SESSION_PREFIX)).toBe(true);
  expect(await exists(name)).toBe(true);

  const idOf = async (t: string) =>
    (await Bun.$`tmux display-message -p -t ${t} '#{window_id}'`.quiet()).stdout.toString().trim();
  expect(await idOf(name)).toBe(await idOf(BASE));

  await destroyWebSession(name);
});

test("sets aggressive-resize so unshared windows keep their own size", async () => {
  const name = await createWebSession(BASE);
  const opt = (await Bun.$`tmux show-options -t ${name} aggressive-resize`.quiet()).stdout.toString();
  expect(opt).toContain("on");
  await destroyWebSession(name);
});

test("does not change the target window size on creation", async () => {
  const sizeOf = async (t: string) =>
    (await Bun.$`tmux display-message -p -t ${t} '#{window_width}x#{window_height}'`.quiet())
      .stdout.toString().trim();
  const before = await sizeOf(BASE);
  const name = await createWebSession(BASE);
  expect(await sizeOf(BASE)).toBe(before);
  await destroyWebSession(name);
});

test("destroy removes the session", async () => {
  const name = await createWebSession(BASE);
  await destroyWebSession(name);
  expect(await exists(name)).toBe(false);
});

test("reap removes unattached web sessions and leaves other sessions alone", async () => {
  const name = await createWebSession(BASE);
  const reaped = await reapOrphanWebSessions();
  expect(reaped).toContain(name);
  expect(await exists(name)).toBe(false);
  expect(await exists(BASE)).toBe(true);
});

test("createWebSession rejects for a target that does not exist", async () => {
  await expect(createWebSession("no-such-session-xyz")).rejects.toThrow();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/tmux/session-manager.test.ts`
Expected: FAIL — `Cannot find module './session-manager'`

- [ ] **Step 3: 实现**

创建 `src/tmux/session-manager.ts`：

```ts
export const WEB_SESSION_PREFIX = "web-";

export async function createWebSession(target: string): Promise<string> {
  const name = WEB_SESSION_PREFIX + crypto.randomUUID().slice(0, 8);

  // -t makes this a grouped session: it shares the target's window list but
  // keeps its own current window.
  const created = await Bun.$`tmux new-session -d -t ${target} -s ${name}`.quiet().nothrow();
  if (created.exitCode !== 0) {
    throw new Error(`cannot create web session for ${target}: ${created.stderr.toString().trim()}`);
  }

  // Only matters when phone and desktop view different windows; harmless otherwise.
  await Bun.$`tmux set-option -t ${name} aggressive-resize on`.quiet().nothrow();
  return name;
}

export async function destroyWebSession(name: string): Promise<void> {
  if (!name.startsWith(WEB_SESSION_PREFIX)) {
    throw new Error(`refusing to destroy non-web session: ${name}`);
  }
  await Bun.$`tmux kill-session -t ${name}`.quiet().nothrow();
}

/**
 * Kills web sessions with no client attached. Needed because the explicit
 * destroy on disconnect never runs when the server is SIGKILLed.
 */
export async function reapOrphanWebSessions(): Promise<string[]> {
  const out = await Bun.$`tmux list-sessions -F '#{session_name}\t#{session_attached}'`
    .quiet().nothrow();
  if (out.exitCode !== 0) return [];

  const reaped: string[] = [];
  for (const row of out.stdout.toString().trim().split("\n").filter(Boolean)) {
    const [name, attached] = row.split("\t");
    if (name.startsWith(WEB_SESSION_PREFIX) && attached === "0") {
      await destroyWebSession(name);
      reaped.push(name);
    }
  }
  return reaped;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/tmux/session-manager.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: 确认没有遗留 session**

Run: `tmux ls -F '#{session_name}' | grep -E '^(sm-test-|web-)' || echo "no leftovers"`
Expected: `no leftovers`

- [ ] **Step 6: 提交**

```bash
git add src/tmux/session-manager.ts src/tmux/session-manager.test.ts
git commit -m "feat: add grouped web session lifecycle with orphan reaping"
```

---

### Task 5: pane 会话编排（连接、播种、合帧、输入）

把前四个组件串成一个「终端会话」：建 grouped session → attach → 锁 80 列 → capture-pane 播种 → 转发实时输出。这里实现设计里的同步点：丢弃 capture 命令 `%begin` 之前缓冲的 `%output`。

**Files:**
- Create: `src/tmux/pane-session.ts`
- Test: `src/tmux/pane-session.test.ts`

**Interfaces:**
- Consumes: `ControlClient`, `createWebSession`, `destroyWebSession`
- Produces:
  ```ts
  export type PaneSessionOptions = { target: string; rows: number; onData: (chunk: Uint8Array) => void }
  export class PaneSession {
    static open(opts: PaneSessionOptions): Promise<PaneSession>
    sendKeys(bytes: Uint8Array): Promise<void>
    resize(rows: number): Promise<void>
    close(): Promise<void>
  }
  export const TERMINAL_COLUMNS = 80
  ```

- [ ] **Step 1: 写失败的测试**

创建 `src/tmux/pane-session.test.ts`：

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { PaneSession, TERMINAL_COLUMNS } from "./pane-session";

const BASE = "ps-test-" + Math.random().toString(36).slice(2, 8);
const dec = new TextDecoder();

beforeAll(async () => {
  await Bun.$`tmux new-session -d -s ${BASE} -x 100 -y 30`.quiet();
  // Put a known marker on screen so the seed has something to find.
  await Bun.$`tmux send-keys -t ${BASE} 'echo SEED_MARKER_7b2c' Enter`.quiet();
  await Bun.sleep(500);
});

afterAll(async () => {
  await Bun.$`tmux kill-session -t ${BASE}`.quiet().nothrow();
});

test("seeds the current screen on open", async () => {
  let seen = "";
  const s = await PaneSession.open({ target: BASE, rows: 24, onData: (c) => { seen += dec.decode(c); } });
  await Bun.sleep(400);
  expect(seen).toContain("SEED_MARKER_7b2c");
  await s.close();
});

test("locks the window to 80 columns while connected", async () => {
  const s = await PaneSession.open({ target: BASE, rows: 24, onData: () => {} });
  await Bun.sleep(300);
  const size = (await Bun.$`tmux display-message -p -t ${BASE} '#{window_width}'`.quiet())
    .stdout.toString().trim();
  expect(Number(size)).toBe(TERMINAL_COLUMNS);
  await s.close();
});

test("forwards live output after the seed", async () => {
  let seen = "";
  const s = await PaneSession.open({ target: BASE, rows: 24, onData: (c) => { seen += dec.decode(c); } });
  await Bun.sleep(400);
  seen = "";
  await Bun.$`tmux send-keys -t ${BASE} 'echo LIVE_MARKER_4d9e' Enter`.quiet();
  await Bun.sleep(600);
  expect(seen).toContain("LIVE_MARKER_4d9e");
  await s.close();
});

test("sendKeys delivers raw bytes to the pane", async () => {
  let seen = "";
  const s = await PaneSession.open({ target: BASE, rows: 24, onData: (c) => { seen += dec.decode(c); } });
  await Bun.sleep(400);
  seen = "";
  await s.sendKeys(new TextEncoder().encode("echo TYPED_5a1f\r"));
  await Bun.sleep(600);
  expect(seen).toContain("TYPED_5a1f");
  await s.close();
});

test("close destroys the grouped session it created", async () => {
  const before = (await Bun.$`tmux ls -F '#{session_name}'`.quiet()).stdout.toString();
  const s = await PaneSession.open({ target: BASE, rows: 24, onData: () => {} });
  await s.close();
  await Bun.sleep(200);
  const after = (await Bun.$`tmux ls -F '#{session_name}'`.quiet()).stdout.toString();
  expect(after.split("\n").filter((l) => l.startsWith("web-")).length)
    .toBe(before.split("\n").filter((l) => l.startsWith("web-")).length);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/tmux/pane-session.test.ts`
Expected: FAIL — `Cannot find module './pane-session'`

- [ ] **Step 3: 实现**

创建 `src/tmux/pane-session.ts`：

```ts
import { ControlClient } from "./control-client";
import { createWebSession, destroyWebSession } from "./session-manager";

export const TERMINAL_COLUMNS = 80;
const FRAME_MS = 16;

export type PaneSessionOptions = {
  target: string;
  rows: number;
  onData: (chunk: Uint8Array) => void;
};

export class PaneSession {
  #client: ControlClient;
  #webSession: string;
  #paneId: string;
  #onData: (chunk: Uint8Array) => void;
  #frame: Uint8Array[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  private constructor(
    client: ControlClient, webSession: string, paneId: string,
    onData: (chunk: Uint8Array) => void,
  ) {
    this.#client = client;
    this.#webSession = webSession;
    this.#paneId = paneId;
    this.#onData = onData;
  }

  static async open(opts: PaneSessionOptions): Promise<PaneSession> {
    const webSession = await createWebSession(opts.target);
    let client: ControlClient;
    try {
      client = await ControlClient.attach(webSession);
    } catch (e) {
      await destroyWebSession(webSession);
      throw e;
    }

    await client.command(`refresh-client -C ${TERMINAL_COLUMNS},${opts.rows}`);
    const paneId = (await client.command(`display-message -p -t ${webSession} '#{pane_id}'`))[0];

    const session = new PaneSession(client, webSession, paneId, opts.onData);

    // Everything before the capture command's block is already reflected in
    // the captured screen, so buffer and drop it; apply only what comes after.
    let seeded = false;
    const buffered: Uint8Array[] = [];
    client.onOutput(paneId, (data) => {
      if (!seeded) buffered.push(data);
      else session.#enqueue(data);
    });

    const screen = await client.command(`capture-pane -p -e -J -t ${paneId}`);
    const cursor = (await client.command(
      `display-message -p -t ${paneId} '#{cursor_y};#{cursor_x}'`))[0];

    buffered.length = 0;
    seeded = true;

    const [cy, cx] = cursor.split(";").map(Number);
    const seed = "[2J[H" + screen.join("\r\n") +
      `[${cy + 1};${cx + 1}H`;
    opts.onData(new TextEncoder().encode(seed));

    return session;
  }

  #enqueue(data: Uint8Array) {
    this.#frame.push(data);
    if (this.#timer) return;
    // Claude Code can emit dozens of %output per repaint; coalesce them.
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const total = this.#frame.reduce((n, c) => n + c.length, 0);
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of this.#frame) { merged.set(c, off); off += c.length; }
      this.#frame = [];
      if (!this.#closed) this.#onData(merged);
    }, FRAME_MS);
  }

  async sendKeys(bytes: Uint8Array): Promise<void> {
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
    await this.#client.command(`send-keys -t ${this.#paneId} -H ${hex}`);
  }

  async resize(rows: number): Promise<void> {
    await this.#client.command(`refresh-client -C ${TERMINAL_COLUMNS},${rows}`);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#client.close();
    await destroyWebSession(this.#webSession);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/tmux/pane-session.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: 运行全部测试确认没有互相干扰**

Run: `bun test`
Expected: PASS — 30 tests across 5 files

- [ ] **Step 6: 提交**

```bash
git add src/tmux/pane-session.ts src/tmux/pane-session.test.ts
git commit -m "feat: add pane session with seeded reconnect and frame coalescing"
```

---

### Task 6: HTTP + WebSocket 服务

把后端能力暴露给浏览器。只监听 loopback。

**Files:**
- Create: `src/server.ts`
- Test: `src/server.test.ts`

**Interfaces:**
- Consumes: `listSessions`, `PaneSession`, `reapOrphanWebSessions`
- Produces:
  ```ts
  export function startServer(port: number): { stop(): void; port: number }
  ```
  WebSocket 协议（客户端 → 服务端，JSON 文本帧）：
  ```ts
  { t: "open", target: string, rows: number }
  { t: "keys", hex: string }
  { t: "resize", rows: number }
  ```
  服务端 → 客户端：二进制帧即终端数据；JSON 文本帧 `{ t: "error", message: string }`。

- [ ] **Step 1: 写失败的测试**

创建 `src/server.test.ts`：

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer } from "./server";

const BASE = "srv-test-" + Math.random().toString(36).slice(2, 8);
let server: { stop(): void; port: number };

beforeAll(async () => {
  await Bun.$`tmux new-session -d -s ${BASE} -x 100 -y 30`.quiet();
  server = startServer(0);
});

afterAll(async () => {
  server.stop();
  await Bun.$`tmux kill-session -t ${BASE}`.quiet().nothrow();
});

test("serves the session list as JSON", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body)).toBe(true);
  expect(body.some((s: { name: string }) => s.name === BASE)).toBe(true);
});

test("serves the list page HTML at the root", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
});

test("streams terminal data over the websocket after open", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const chunks: string[] = [];
  const dec = new TextDecoder();

  await new Promise<void>((r) => { ws.onopen = () => r(); });
  ws.binaryType = "arraybuffer";
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) chunks.push(dec.decode(new Uint8Array(e.data)));
  };
  ws.send(JSON.stringify({ t: "open", target: BASE, rows: 24 }));
  await Bun.sleep(1200);

  expect(chunks.join("").length).toBeGreaterThan(0);
  ws.close();
  await Bun.sleep(300);
});

test("reports an error for a session that does not exist", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  await new Promise<void>((r) => { ws.onopen = () => r(); });

  const message = await new Promise<string>((resolve) => {
    ws.onmessage = (e) => { if (typeof e.data === "string") resolve(e.data); };
    ws.send(JSON.stringify({ t: "open", target: "no-such-session-xyz", rows: 24 }));
  });
  expect(JSON.parse(message).t).toBe("error");
  ws.close();
});

test("closing the websocket leaves no orphan web session", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  await new Promise<void>((r) => { ws.onopen = () => r(); });
  ws.send(JSON.stringify({ t: "open", target: BASE, rows: 24 }));
  await Bun.sleep(800);
  ws.close();
  await Bun.sleep(800);

  const out = (await Bun.$`tmux ls -F '#{session_name}'`.quiet()).stdout.toString();
  expect(out.split("\n").filter((l) => l.startsWith("web-"))).toEqual([]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/server.test.ts`
Expected: FAIL — `Cannot find module './server'`

- [ ] **Step 3: 实现**

创建 `src/server.ts`：

```ts
import { PaneSession } from "./tmux/pane-session";
import { listSessions } from "./tmux/session-list";
import { reapOrphanWebSessions } from "./tmux/session-manager";

type WsData = { session: PaneSession | null };

const PUBLIC = new URL("../public/", import.meta.url).pathname;

export function startServer(port: number) {
  const server = Bun.serve<WsData, {}>({
    // Loopback only; Caddy terminates TLS and handles auth.
    hostname: "127.0.0.1",
    port,
    idleTimeout: 120,

    async fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        if (srv.upgrade(req, { data: { session: null } })) return undefined as never;
        return new Response("expected websocket", { status: 400 });
      }

      if (url.pathname === "/api/sessions") {
        return Response.json(await listSessions());
      }

      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const asset = Bun.file(PUBLIC + file);
      if (await asset.exists()) return new Response(asset);
      return new Response("not found", { status: 404 });
    },

    websocket: {
      async message(ws, raw) {
        let msg: { t: string; target?: string; rows?: number; hex?: string };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }

        if (msg.t === "open") {
          await ws.data.session?.close();
          ws.data.session = null;
          try {
            ws.data.session = await PaneSession.open({
              target: msg.target!,
              rows: msg.rows ?? 24,
              onData: (chunk) => ws.send(chunk),
            });
          } catch (e) {
            ws.send(JSON.stringify({ t: "error", message: String(e) }));
          }
        } else if (msg.t === "keys" && ws.data.session) {
          const bytes = Uint8Array.from(
            msg.hex!.split(" ").filter(Boolean).map((h) => parseInt(h, 16)));
          await ws.data.session.sendKeys(bytes);
        } else if (msg.t === "resize" && ws.data.session) {
          await ws.data.session.resize(msg.rows ?? 24);
        }
      },

      async close(ws) {
        await ws.data.session?.close();
        ws.data.session = null;
      },
    },
  });

  // Explicit close() never runs if we are SIGKILLed, so sweep periodically.
  const reaper = setInterval(() => { void reapOrphanWebSessions(); }, 60_000);

  return {
    port: server.port,
    stop() {
      clearInterval(reaper);
      server.stop(true);
    },
  };
}
```

创建占位的 `public/index.html`（Task 7 会替换其内容，但服务测试需要它存在）：

```html
<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>tmux</title></head>
<body><p>loading</p></body></html>
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/server.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: 提交**

```bash
git add src/server.ts src/server.test.ts public/index.html
git commit -m "feat: add loopback http and websocket server"
```

---

### Task 7: session 列表页

纯 HTML/CSS/原生 JS。手机优先，无框架。

**Files:**
- Create: `public/index.html`（替换 Task 6 的占位内容）
- Create: `public/list.js`
- Create: `public/style.css`

**Interfaces:**
- Consumes: `GET /api/sessions` → `SessionSummary[]`
- Produces: 点击一行跳转到 `/terminal.html?target=<name>`

- [ ] **Step 1: 写样式**

创建 `public/style.css`：

```css
:root {
  --bg: #14161a; --card: #1d2026; --fg: #e6e8ec;
  --dim: #8b919c; --accent: #7aa2f7; --idle: #9ece6a;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.5 -apple-system, system-ui, sans-serif;
  padding: env(safe-area-inset-top) env(safe-area-inset-right)
           env(safe-area-inset-bottom) env(safe-area-inset-left);
}
header { padding: 16px; font-size: 20px; font-weight: 600; }
.card {
  display: block; background: var(--card); border-radius: 12px;
  margin: 0 12px 12px; padding: 14px; text-decoration: none; color: inherit;
}
.row { display: flex; align-items: center; gap: 8px; }
.name { font-weight: 600; font-size: 16px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--idle); }
.time { margin-left: auto; color: var(--dim); font-size: 13px; }
.preview {
  margin: 8px 0 0; white-space: pre-wrap; overflow-wrap: anywhere;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--dim);
}
.pending {
  margin-top: 8px; padding: 6px 8px; border-radius: 6px;
  background: #2a2f3a; color: var(--accent);
  font: 12px/1.4 ui-monospace, Menlo, monospace;
  overflow-wrap: anywhere;
}
.pending b { color: var(--dim); font-weight: 400; margin-left: 6px; }
.empty { padding: 24px; color: var(--dim); text-align: center; }
```

- [ ] **Step 2: 写列表页 HTML**

替换 `public/index.html`：

```html
<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>tmux</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header>tmux 会话</header>
  <main id="list"><p class="empty">加载中…</p></main>
  <script type="module" src="/list.js"></script>
</body>
</html>
```

- [ ] **Step 3: 写列表页逻辑**

创建 `public/list.js`：

```js
const list = document.getElementById("list");

function relativeTime(epochSeconds) {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (secs < 60) return "刚刚";
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟前`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} 小时前`;
  return `${Math.floor(secs / 86400)} 天前`;
}

function card(s) {
  const a = document.createElement("a");
  a.className = "card";
  a.href = `/terminal.html?target=${encodeURIComponent(s.name)}`;

  const row = document.createElement("div");
  row.className = "row";
  if (s.idle) {
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.title = "等待你的回复";
    row.append(dot);
  }
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = s.name;
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = relativeTime(s.lastActivityEpoch);
  row.append(name, time);
  a.append(row);

  if (s.preview.length) {
    const pre = document.createElement("p");
    pre.className = "preview";
    pre.textContent = s.preview.join("\n");
    a.append(pre);
  }
  if (s.pendingInput) {
    const pending = document.createElement("div");
    pending.className = "pending";
    pending.textContent = "❯ " + s.pendingInput;
    const tag = document.createElement("b");
    tag.textContent = "待发送";
    pending.append(tag);
    a.append(pending);
  }
  return a;
}

async function render() {
  try {
    const sessions = await (await fetch("/api/sessions")).json();
    list.replaceChildren(...(sessions.length
      ? sessions.map(card)
      : [Object.assign(document.createElement("p"),
          { className: "empty", textContent: "没有 tmux 会话" })]));
  } catch {
    list.replaceChildren(Object.assign(document.createElement("p"),
      { className: "empty", textContent: "无法连接到服务" }));
  }
}

render();
setInterval(render, 5000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") render();
});
```

- [ ] **Step 4: 人工验证列表页**

Run: `bun run src/index.ts --port 7682 &` 然后 `curl -s http://127.0.0.1:7682/api/sessions | head -c 400`

（若 `src/index.ts` 尚不存在，先创建它：

```ts
import { startServer } from "./server";
const portArg = process.argv.indexOf("--port");
const port = portArg !== -1 ? Number(process.argv[portArg + 1]) : 7682;
const server = startServer(port);
console.log(`listening on http://127.0.0.1:${server.port}`);
```
）

Expected: 返回 JSON 数组，含真实 session 名与 preview 字段。

在桌面浏览器打开 `http://127.0.0.1:7682/`，应看到卡片列表，每张卡显示 session 名、相对时间、预览行；空闲的显示绿点；有未发送输入的显示「待发送」条。

- [ ] **Step 5: 提交**

```bash
git add public/index.html public/list.js public/style.css src/index.ts
git commit -m "feat: add mobile session list page with previews"
```

---

### Task 8: 终端页

xterm.js 单 pane 全屏视图，含 80 列字号自适应、键盘工具条、软键盘处理与自动重连。

**Files:**
- Create: `public/terminal.html`
- Create: `public/terminal.js`
- Modify: `public/style.css`（追加终端页样式）
- Modify: `package.json`（加 xterm 依赖）

**Interfaces:**
- Consumes: `/ws` WebSocket 协议（Task 6 定义）
- Produces: 无（终点）

- [ ] **Step 1: 安装 xterm**

Run:
```bash
bun add @xterm/xterm@5.5.0 @xterm/addon-webgl@0.18.0
```
Expected: 两个包写入 `package.json` 的 dependencies。

- [ ] **Step 2: 追加终端页样式**

追加到 `public/style.css`：

```css
.term-page { display: flex; flex-direction: column; height: 100dvh; overflow: hidden; }
.term-bar {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; background: var(--card); font-size: 14px;
}
.term-bar a { color: var(--accent); text-decoration: none; }
.term-bar .status { margin-left: auto; color: var(--dim); font-size: 12px; }
#term { flex: 1; min-height: 0; overflow: hidden; }
.keys {
  display: flex; gap: 6px; padding: 8px;
  overflow-x: auto; background: var(--card);
  padding-bottom: calc(8px + env(safe-area-inset-bottom));
}
.keys button {
  flex: 0 0 auto; min-width: 44px; height: 40px; padding: 0 10px;
  border: 0; border-radius: 8px; background: #2a2f3a; color: var(--fg);
  font: 13px/1 ui-monospace, Menlo, monospace;
}
.keys button.sticky-on { background: var(--accent); color: #14161a; }
#hidden-input {
  position: absolute; opacity: 0; pointer-events: none;
  width: 1px; height: 1px; left: -9999px;
}
```

- [ ] **Step 3: 写终端页 HTML**

创建 `public/terminal.html`：

```html
<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
  <title>tmux</title>
  <link rel="stylesheet" href="/node_modules/@xterm/xterm/css/xterm.css">
  <link rel="stylesheet" href="/style.css">
</head>
<body class="term-page">
  <div class="term-bar">
    <a href="/">‹ 会话</a>
    <span id="title"></span>
    <span class="status" id="status">连接中…</span>
  </div>
  <div id="term"></div>
  <input id="hidden-input" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false">
  <div class="keys">
    <button data-hex="1b">Esc</button>
    <button data-hex="09">Tab</button>
    <button data-hex="1b 5b 5a">⇧Tab</button>
    <button id="ctrl">Ctrl</button>
    <button data-hex="1b 5b 41">↑</button>
    <button data-hex="1b 5b 42">↓</button>
    <button data-hex="1b 5b 44">←</button>
    <button data-hex="1b 5b 43">→</button>
    <button data-hex="03">^C</button>
    <button data-hex="0d">⏎</button>
  </div>
  <script type="module" src="/terminal.js"></script>
</body>
</html>
```

- [ ] **Step 4: 写终端页逻辑**

创建 `public/terminal.js`：

```js
import { Terminal } from "/node_modules/@xterm/xterm/lib/xterm.mjs";
import { WebglAddon } from "/node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs";

const COLUMNS = 80;
const target = new URLSearchParams(location.search).get("target");
const statusEl = document.getElementById("status");
const hiddenInput = document.getElementById("hidden-input");
document.getElementById("title").textContent = target ?? "";

const term = new Terminal({
  cols: COLUMNS, rows: 24, scrollback: 5000,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  theme: { background: "#14161a", foreground: "#e6e8ec" },
});
term.open(document.getElementById("term"));
try { term.loadAddon(new WebglAddon()); } catch { /* fall back to canvas */ }

/**
 * The window is locked to 80 columns, so the font size is whatever makes
 * 80 columns fit the viewport. Rows follow from the remaining height.
 */
function fit() {
  const host = document.getElementById("term");
  const width = host.clientWidth;
  // xterm's character cell is ~0.6 of the font size for monospace faces.
  const fontSize = Math.max(6, Math.floor(width / COLUMNS / 0.6));
  term.options.fontSize = fontSize;

  const cellHeight = fontSize * 1.2;
  const rows = Math.max(8, Math.floor(host.clientHeight / cellHeight));
  term.resize(COLUMNS, rows);
  return rows;
}

let ws = null;
let reconnectDelay = 500;

function connect() {
  statusEl.textContent = "连接中…";
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    statusEl.textContent = "已连接";
    reconnectDelay = 500;
    ws.send(JSON.stringify({ t: "open", target, rows: fit() }));
  };
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      term.write(new Uint8Array(e.data));
    } else {
      const msg = JSON.parse(e.data);
      if (msg.t === "error") statusEl.textContent = "错误: " + msg.message;
    }
  };
  ws.onclose = () => {
    statusEl.textContent = "已断开，重连中…";
    // The screen is rebuilt from capture-pane on reconnect, so nothing is lost.
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
  };
}

function sendBytes(bytes) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
  ws.send(JSON.stringify({ t: "keys", hex }));
}

const encoder = new TextEncoder();
term.onData((data) => sendBytes(encoder.encode(data)));

// Tapping the terminal raises the soft keyboard via a hidden input.
document.getElementById("term").addEventListener("touchend", () => hiddenInput.focus());
hiddenInput.addEventListener("input", () => {
  if (hiddenInput.value) {
    sendBytes(encoder.encode(hiddenInput.value));
    hiddenInput.value = "";
  }
});

// Ctrl is a sticky modifier: tap it, then tap a letter.
let ctrlArmed = false;
const ctrlBtn = document.getElementById("ctrl");
ctrlBtn.addEventListener("click", () => {
  ctrlArmed = !ctrlArmed;
  ctrlBtn.classList.toggle("sticky-on", ctrlArmed);
});
term.attachCustomKeyEventHandler((e) => {
  if (!ctrlArmed || e.type !== "keydown" || e.key.length !== 1) return true;
  const code = e.key.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) {
    sendBytes(new Uint8Array([code - 64]));
    ctrlArmed = false;
    ctrlBtn.classList.remove("sticky-on");
    return false;
  }
  return true;
});

for (const btn of document.querySelectorAll(".keys button[data-hex]")) {
  btn.addEventListener("click", () => {
    sendBytes(Uint8Array.from(btn.dataset.hex.split(" ").map((h) => parseInt(h, 16))));
    hiddenInput.focus();
  });
}

function resizeAndNotify() {
  const rows = fit();
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "resize", rows }));
}

// iOS raises the soft keyboard by shrinking the visual viewport, not the layout
// viewport, so window.resize alone is not enough.
window.visualViewport?.addEventListener("resize", resizeAndNotify);
window.addEventListener("orientationchange", () => setTimeout(resizeAndNotify, 300));
window.addEventListener("resize", resizeAndNotify);

fit();
connect();
```

- [ ] **Step 5: 让服务能提供 node_modules 里的 xterm 资源**

修改 `src/server.ts` 的 `fetch`，在 `PUBLIC` 查找失败前加入 node_modules 分支：

```ts
      if (url.pathname.startsWith("/node_modules/")) {
        const mod = Bun.file(
          new URL("../" + url.pathname.slice(1), import.meta.url).pathname);
        if (await mod.exists()) return new Response(mod);
      }
```

- [ ] **Step 6: 人工验证终端页**

Run: `bun run src/index.ts --port 7682`

桌面浏览器打开 `http://127.0.0.1:7682/`，点任意 session。确认：
1. 终端出现并显示该 session 的当前画面（不是空白）
2. 输入 `echo hi` 回车有回显
3. 该 session 的 window 宽度变为 80：`tmux display-message -p -t <name> '#{window_width}'`
4. 关闭标签页后无残留：`tmux ls -F '#{session_name}' | grep '^web-' || echo clean`
5. 用 DevTools 的手机模拟视图打开，工具条按钮可点、Esc 与方向键生效

- [ ] **Step 7: 提交**

```bash
git add public/terminal.html public/terminal.js public/style.css src/server.ts package.json bun.lock
git commit -m "feat: add mobile terminal page with key toolbar and auto-reconnect"
```

---

### Task 9: 接入 Caddy 并做真机验证

把服务挂到现有的 Caddy 上，用手机实测设计里剩下的两个未验证项：重连恢复、80 列字号可读性。

**Files:**
- Create: `docs/deploy.md`
- Modify: `/opt/homebrew/etc/Caddyfile`（需用户确认后再改）

- [ ] **Step 1: 确认端口不冲突**

Run: `lsof -nP -iTCP:7682 -sTCP:LISTEN || echo "7682 free"`
Expected: `7682 free`（ttyd 占用的是 7681，不要动它）

- [ ] **Step 2: 起服务**

Run: `bun run src/index.ts --port 7682`
Expected: `listening on http://127.0.0.1:7682`

- [ ] **Step 3: 加 Caddy 路由**

在 `/opt/homebrew/etc/Caddyfile` 的站点块内、现有 `handle` 之前插入。沿用与 ttyd 相同的 cookie 方案，因为浏览器不会在 WebSocket 握手时发 Basic Auth：

```
	# 新的 tmux web 客户端
	@tmuxws path /tmux/ws
	handle @tmuxws {
		@notmuxcookie not header Cookie *ttyd_auth=COOKIE_TOKEN_REDACTED*
		respond @notmuxcookie 403
		uri strip_prefix /tmux
		reverse_proxy 127.0.0.1:7682
	}

	handle_path /tmux/* {
		basic_auth {
			lcm BCRYPT_HASH_REDACTED
		}
		header +Set-Cookie "ttyd_auth=COOKIE_TOKEN_REDACTED; Path=/; Secure; HttpOnly; SameSite=Strict"
		reverse_proxy 127.0.0.1:7682
	}
```

因为服务挂在 `/tmux/` 前缀下，前端的绝对路径需要相对化。修改 `public/list.js` 的 fetch 与 `public/terminal.js` 的 WebSocket URL：

```js
// list.js
const sessions = await (await fetch("api/sessions")).json();
a.href = `terminal.html?target=${encodeURIComponent(s.name)}`;
```

```js
// terminal.js
const base = location.pathname.replace(/[^/]*$/, "");
ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${base}ws`);
```

`terminal.html` 里的 `<a href="/">‹ 会话</a>` 改为 `<a href="./">‹ 会话</a>`，两个 `<link>` 与 `<script>` 的 `/` 前缀去掉。

- [ ] **Step 4: 重载 Caddy**

Run: `caddy reload --config /opt/homebrew/etc/Caddyfile`
Expected: 无报错输出。

- [ ] **Step 5: 真机验证**

在手机浏览器打开 `https://example.internal:8443/tmux/`，逐项确认：

1. **列表页**：能看到全部 session，预览文字可读、能区分出是哪个 session
2. **80 列可读性**：进入一个 session，竖屏下字号是否可接受；横屏是否明显变好
3. **重连恢复**：进入终端后锁屏 30 秒再解锁，确认状态栏从「已断开，重连中…」恢复为「已连接」，且画面完整无花屏
4. **切网络重连**：关掉 WiFi 走蜂窝，确认同样能恢复
5. **工具条**：对着一个 Claude Code session 按 Esc 能中断、⇧Tab 能切模式
6. **无残留**：全部关闭后 `tmux ls -F '#{session_name}' | grep '^web-' || echo clean` 输出 `clean`

- [ ] **Step 6: 记录部署方式**

创建 `docs/deploy.md`，写明：启动命令、端口、Caddy 片段、以及「若要开机自启，用 `brew services` 或 launchd」的说明。内容须与实际使用的端口和路径一致。

- [ ] **Step 7: 提交**

```bash
git add docs/deploy.md public/list.js public/terminal.js public/terminal.html
git commit -m "feat: serve under /tmux prefix and document deployment"
```

---

## Self-Review

**Spec coverage：**

| 规格要求 | 对应任务 |
|---|---|
| control mode 解析 | Task 1 |
| 请求-响应语义、子进程管理 | Task 2 |
| 列表页数据 + 预览取法（禁 `-S`、滤 chrome、`❯` 分离、idle 检测） | Task 3 |
| grouped session `web-<uuid>`、`aggressive-resize`、孤儿清理 | Task 4 |
| `refresh-client -C` 锁 80 列（禁 `resize-window`） | Task 5 |
| capture-pane 播种 + `%begin` 同步点 | Task 5 |
| 16ms 合帧 | Task 5 |
| `send-keys -H` hex 输入 | Task 5 |
| 只监听 loopback、不做鉴权 | Task 6 |
| 列表页 UI（预览、待发送、状态点） | Task 7 |
| 终端页、工具条、字号自适应、`visualViewport` | Task 8 |
| 无缓冲重连（每次都重新播种） | Task 8（客户端重连）+ Task 5（服务端播种） |
| Caddy 接入、真机验证三项 | Task 9 |

**未纳入本计划的规格内容：** 手势（滑动翻 scrollback、mouse tracking 让位）在规格「移动端交互」中提及，本计划未实现。理由：工具条已保证可用性，手势属增强项，且需真机反复调试。列为后续迭代，不阻塞首个可用版本。`refresh-client -A` 流控同理——已实测吞吐余量充足（病态负载下 5.4% CPU），先不引入。

**类型一致性检查：** `SessionSummary` 的字段（`name`/`lastActivityEpoch`/`preview`/`pendingInput`/`idle`）在 Task 3 定义，Task 7 的 `card()` 使用同名字段。`PaneSession.open` 的 `{ target, rows, onData }` 在 Task 5 定义，Task 6 按此调用。WebSocket 消息 `{t:"open"|"keys"|"resize"}` 在 Task 6 定义，Task 8 按此发送。`TERMINAL_COLUMNS`(=80) 与前端 `COLUMNS`(=80) 是两处独立常量，分处前后端，可接受。
