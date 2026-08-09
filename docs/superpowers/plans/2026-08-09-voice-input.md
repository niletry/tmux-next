# 语音输入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在终端页加一个语音输入面板：录音 → 服务端代理转发火山引擎 ASR → 文本进可编辑框复核 → 插入终端（不带回车）。

**Architecture:** 服务端新增 `src/asr.ts`（读 `~/.tmux-next/asr.json`，转发 `openspeech.bytedance.com`）与 `GET/POST /api/asr` 两个端点。前端拆成两层：`public/voice-recorder.js` 是无 DOM 的录音状态机（`// @ts-check`，可 headless 测），`public/voice-panel.js` 是面板 DOM（用 happy-dom 挂载测）。面板占用系统键盘的位置，与 `⌨` 互斥。

**Tech Stack:** Bun（运行时 + 测试）、TypeScript、原生 DOM + ES modules、MediaRecorder、happy-dom。零新增运行时依赖。

设计文档：`docs/superpowers/specs/2026-08-09-voice-input-design.md`

## Global Constraints

- **零新增运行时依赖。** 不装 SDK，用 `fetch` 手写请求。
- **必须服务端代理，不能浏览器直连。** 单 key 只能走 `X-Api-Key` 请求头，而该头不在火山的 CORS 白名单里（白名单只有 `X-Api-App-Key`/`X-Api-Access-Key`）。已实测。
- **音频不落盘。** 服务端内存里过一道就丢，任何任务都不得写入磁盘或日志。
- **密钥不进仓库。** 不得把任何真实 key 写进代码、测试、fixture、注释或提交信息。测试一律用假 key。
- **测试不打真实火山接口。** 要花钱、要网络、要私密凭据进 CI。出站请求一律用注入的假 `fetch`。
- **状态路径可被环境变量覆盖：** `TMUX_NEXT_ASR_PATH`，在函数内惰性求值（不在模块加载时捕获），否则测试会碰用户的 `~/.tmux-next/`。
- **界面文案只能来自 `public/i18n.js`**，中英两份必须同时增加同一批键；`src/i18n.test.ts` 会强制检查。不得在 JS/HTML 里内联文案。
- **`style.css` 里不得出现颜色字面量**，只能用既有的 `--term-*` / `--bg` / `--fg` / `--accent` / `--dim` / `--card` 变量。
- **工具栏按钮用 `pointerdown` 而非 `click`。** `public/terminal.js:906` 有一个覆盖 `.keys` 的 `pointerdown` 处理器会 `preventDefault()` 以保护终端焦点，那会吞掉后续的 click 事件。既有的 `#kbd`、`#ctrl` 都是这么写的。
- **提交信息不带任何助手署名**（无 `Co-Authored-By`、无 `Claude-Session`、无 🤖 footer）。
- **每步跑 `bun run typecheck` 和 `bun test`**（后者不含 typecheck）。

---

### Task 1: `src/asr.ts` — 配置文件的读与写

照 `src/theme.ts` 的模子写：惰性求值的路径、可被环境变量覆盖、读失败一律降级而不抛。

配置多存一个 `resourceId` 字段，是因为火山换模型时只改资源 ID；留这个字段让换模型不必改代码。缺省时补默认值。

**Files:**
- Create: `src/asr.ts`
- Create: `src/asr.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `DEFAULT_RESOURCE_ID: string`（值 `"volc.bigasr.auc_turbo"`）
  - `type AsrConfig = { key: string; resourceId: string }`
  - `asrPath(): string`
  - `readAsrConfig(): Promise<AsrConfig | null>`
  - `writeAsrConfig(key: unknown): Promise<boolean>`

- [ ] **Step 1: 写失败的测试**

创建 `src/asr.test.ts`：

```ts
import { test, expect, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, statSync } from "node:fs";
import { asrPath, readAsrConfig, writeAsrConfig, DEFAULT_RESOURCE_ID } from "./asr";

// A throwaway path per run, so the suite never reads or writes the real
// ~/.tmux-next/asr.json — which on a developer's machine holds a live key.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "asr-test-"));
  process.env.TMUX_NEXT_ASR_PATH = join(dir, "asr.json");
});

test("the path follows the environment override", () => {
  expect(asrPath()).toBe(join(dir, "asr.json"));
});

test("a missing file reads as unconfigured", async () => {
  expect(await readAsrConfig()).toBeNull();
});

test("unreadable JSON reads as unconfigured rather than throwing", async () => {
  await Bun.write(asrPath(), "{not json");
  expect(await readAsrConfig()).toBeNull();
});

test("a key round-trips and gets the default resource id", async () => {
  expect(await writeAsrConfig("fake-key-0000")).toBe(true);
  expect(await readAsrConfig()).toEqual({
    key: "fake-key-0000",
    resourceId: DEFAULT_RESOURCE_ID,
  });
});

test("a resource id already in the file is preserved", async () => {
  await Bun.write(asrPath(), JSON.stringify({ key: "fake-key-0000", resourceId: "volc.bigasr.next" }));
  expect((await readAsrConfig())?.resourceId).toBe("volc.bigasr.next");
});

test("a file without a usable key reads as unconfigured", async () => {
  for (const bad of [{}, { key: "" }, { key: "   " }, { key: 42 }, { key: null }]) {
    await Bun.write(asrPath(), JSON.stringify(bad));
    expect(await readAsrConfig()).toBeNull();
  }
});

test("a non-string or blank key is refused and nothing is written", async () => {
  for (const bad of [null, undefined, 42, {}, [], "", "   "]) {
    expect(await writeAsrConfig(bad)).toBe(false);
  }
  expect(await readAsrConfig()).toBeNull();
});

test("surrounding whitespace is trimmed off a pasted key", async () => {
  expect(await writeAsrConfig("  fake-key-0000\n")).toBe(true);
  expect((await readAsrConfig())?.key).toBe("fake-key-0000");
});

// A credential, so it must not be world-readable — the rest of ~/.tmux-next is
// ordinary state, this one file is not.
test("the file is written 0600", async () => {
  await writeAsrConfig("fake-key-0000");
  expect(statSync(asrPath()).mode & 0o777).toBe(0o600);
});
```

- [ ] **Step 2: 跑测试确认它失败**

```
bun test src/asr.test.ts
```

Expected: FAIL — `Cannot find module './asr'`

- [ ] **Step 3: 写最小实现**

创建 `src/asr.ts`：

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, chmod } from "node:fs/promises";

/**
 * The Volcano Engine ASR credential, and nothing else.
 *
 * Voice input is optional: with no file here the microphone button is never
 * rendered, because a button that always fails is worse than no button.
 *
 * The resource id is stored alongside the key rather than hard-coded at the
 * call site, so that pointing the same key at a newer model is a config edit
 * rather than a release.
 */
export const DEFAULT_RESOURCE_ID = "volc.bigasr.auc_turbo";

export type AsrConfig = { key: string; resourceId: string };

export function asrPath(): string {
  return process.env.TMUX_NEXT_ASR_PATH || join(homedir(), ".tmux-next", "asr.json");
}

/**
 * The stored credential, or null.
 *
 * Total: a missing file (the common case — most installs have no key), bad
 * JSON, or a file without a usable key all mean "voice input is off". None of
 * them is worth failing a page load over.
 */
export async function readAsrConfig(): Promise<AsrConfig | null> {
  try {
    const data = (await Bun.file(asrPath()).json()) as { key?: unknown; resourceId?: unknown };
    const key = typeof data?.key === "string" ? data.key.trim() : "";
    if (!key) return null;
    const resourceId =
      typeof data?.resourceId === "string" && data.resourceId.trim()
        ? data.resourceId.trim()
        : DEFAULT_RESOURCE_ID;
    return { key, resourceId };
  } catch {
    return null;
  }
}

/** Stores a key; returns false for anything that could not be one. */
export async function writeAsrConfig(key: unknown): Promise<boolean> {
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (!trimmed) return false;
  const path = asrPath();
  // The directory exists in any real install, but a fresh machine may reach
  // this before anything else has written to ~/.tmux-next.
  await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
  await Bun.write(path, JSON.stringify({ key: trimmed, resourceId: DEFAULT_RESOURCE_ID }));
  // Unlike the rest of ~/.tmux-next, this file is a credential.
  await chmod(path, 0o600).catch(() => {});
  return true;
}
```

- [ ] **Step 4: 跑测试确认通过**

```
bun test src/asr.test.ts
bun run typecheck
```

Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/asr.ts src/asr.test.ts
git commit -m "feat: 语音识别凭据的读写"
```

---

### Task 2: `src/asr.ts` — 转发到火山

出站 `fetch` 走**注入**，与 `src/web-push.ts:215` 的 `fetchImpl: Fetch = fetch` 同一写法。这样测试能断言「会发出什么」而不需要网络，也不必覆盖全局 `fetch`（覆盖全局 `fetch` 曾让另外 38 个测试失败）。

请求体里**不带 `format` 字段**：已实测该接口嗅探容器，把 webm 标成 `ogg` 照样识别正确，填一个可能与实际不符的值只会误导后来者。

**Files:**
- Modify: `src/asr.ts`（追加，不改 Task 1 的内容）
- Modify: `src/asr.test.ts`（追加）

**Interfaces:**
- Consumes: `AsrConfig`（Task 1）
- Produces:
  - `ASR_ENDPOINT: string`
  - `type Fetch = (url: string, init: RequestInit) => Promise<Response>`
  - `type TranscribeResult = { ok: true; text: string } | { ok: false; status: number; error: string }`
  - `transcribe(audio: ArrayBuffer, config: AsrConfig, requestId: string, fetchImpl?: Fetch): Promise<TranscribeResult>`

- [ ] **Step 1: 写失败的测试**

追加到 `src/asr.test.ts`：

```ts
import { transcribe, ASR_ENDPOINT, type Fetch } from "./asr";

const CONFIG = { key: "fake-key-0000", resourceId: "volc.bigasr.auc_turbo" };

/** Records the one call it receives and answers with whatever the test wants. */
function stubFetch(reply: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl: Fetch = async (url, init) => {
    calls.push({ url, init });
    return reply;
  };
  return { impl, calls };
}

function ok(text: string) {
  return new Response(JSON.stringify({ result: { text } }), {
    headers: { "x-api-status-code": "20000000" },
  });
}

test("the upstream request carries the key, the resource id and the audio", async () => {
  const { impl, calls } = stubFetch(ok("这是一个测试"));
  const audio = new TextEncoder().encode("PRETEND-AUDIO").buffer as ArrayBuffer;

  const result = await transcribe(audio, CONFIG, "req-1", impl);
  expect(result).toEqual({ ok: true, text: "这是一个测试" });

  expect(calls).toHaveLength(1);
  const { url, init } = calls[0]!;
  expect(url).toBe(ASR_ENDPOINT);
  expect(init.method).toBe("POST");

  const headers = init.headers as Record<string, string>;
  expect(headers["X-Api-Key"]).toBe("fake-key-0000");
  expect(headers["X-Api-Resource-Id"]).toBe("volc.bigasr.auc_turbo");
  expect(headers["X-Api-Request-Id"]).toBe("req-1");

  const body = JSON.parse(String(init.body));
  expect(Buffer.from(body.audio.data, "base64").toString()).toBe("PRETEND-AUDIO");
  // The endpoint sniffs the container; a format field would only be a lie
  // waiting to be believed.
  expect(body.audio.format).toBeUndefined();
});

test("empty audio is refused without reaching the network", async () => {
  const { impl, calls } = stubFetch(ok("never"));
  const result = await transcribe(new ArrayBuffer(0), CONFIG, "req-2", impl);
  expect(result).toEqual({ ok: false, status: 400, error: "empty" });
  expect(calls).toHaveLength(0);
});

test("a bad credential is reported as such, not as a generic failure", async () => {
  const { impl } = stubFetch(
    new Response(JSON.stringify({ header: { message: "Invalid X-Api-Key" } }), {
      status: 401,
      headers: { "x-api-status-code": "45000010" },
    }),
  );
  expect(await transcribe(new Uint8Array([1, 2]).buffer as ArrayBuffer, CONFIG, "r", impl)).toEqual({
    ok: false, status: 502, error: "credential",
  });
});

test("any other upstream complaint surfaces its message", async () => {
  const { impl } = stubFetch(
    new Response("{}", { status: 400, headers: { "x-api-status-code": "45000000", "x-api-message": "error params" } }),
  );
  const result = await transcribe(new Uint8Array([1, 2]).buffer as ArrayBuffer, CONFIG, "r", impl);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBe("error params");
});

// The endpoint answers 200 with the failure in a header, so status alone is
// not enough to tell success from failure.
test("a 200 with no text is a failure, not an empty success", async () => {
  const { impl } = stubFetch(
    new Response("{}", { status: 200, headers: { "x-api-status-code": "45000000", "x-api-message": "error params" } }),
  );
  expect((await transcribe(new Uint8Array([1]).buffer as ArrayBuffer, CONFIG, "r", impl)).ok).toBe(false);
});

test("silence comes back as an empty string, which is a success", async () => {
  const { impl } = stubFetch(ok(""));
  expect(await transcribe(new Uint8Array([1]).buffer as ArrayBuffer, CONFIG, "r", impl)).toEqual({
    ok: true, text: "",
  });
});

test("a network failure is caught rather than thrown at the caller", async () => {
  const impl: Fetch = async () => { throw new Error("offline"); };
  const result = await transcribe(new Uint8Array([1]).buffer as ArrayBuffer, CONFIG, "r", impl);
  expect(result).toEqual({ ok: false, status: 502, error: "network" });
});
```

- [ ] **Step 2: 跑测试确认它失败**

```
bun test src/asr.test.ts
```

Expected: FAIL — `transcribe is not a function`

- [ ] **Step 3: 写最小实现**

追加到 `src/asr.ts`：

```ts
/**
 * The one-shot recognition endpoint: audio in, text out, no submit/query
 * polling. Measured at ~1s round trip for a couple of seconds of speech.
 */
export const ASR_ENDPOINT =
  "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";

/** Injectable so tests assert what would be sent without a network. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type TranscribeResult =
  | { ok: true; text: string }
  | { ok: false; status: number; error: string };

/** The upstream code for a credential that is not accepted. */
const BAD_CREDENTIAL = "45000010";

/**
 * Sends one recording upstream and returns what was said.
 *
 * The audio is passed through untouched: the endpoint sniffs the container, so
 * whatever MediaRecorder produced on the phone (mp4/aac on older Safari,
 * webm/opus since 18.4) is accepted as-is and no transcoding is needed.
 *
 * Failure is a return value rather than a throw, because every caller has to
 * turn it into an HTTP response anyway, and because the distinction between
 * "your key is wrong" and "the service is unhappy" is worth keeping — they have
 * completely different fixes.
 */
export async function transcribe(
  audio: ArrayBuffer,
  config: AsrConfig,
  requestId: string,
  fetchImpl: Fetch = fetch,
): Promise<TranscribeResult> {
  if (audio.byteLength === 0) return { ok: false, status: 400, error: "empty" };

  let res: Response;
  try {
    res = await fetchImpl(ASR_ENDPOINT, {
      method: "POST",
      headers: {
        "X-Api-Key": config.key,
        "X-Api-Resource-Id": config.resourceId,
        "X-Api-Request-Id": requestId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        user: { uid: "tmux-next" },
        audio: { data: Buffer.from(audio).toString("base64") },
        request: { model_name: "bigmodel" },
      }),
    });
  } catch {
    return { ok: false, status: 502, error: "network" };
  }

  const code = res.headers.get("x-api-status-code") ?? String(res.status);
  const message = res.headers.get("x-api-message") ?? "";

  // The endpoint answers 200 with the failure in a header, so the body is what
  // decides: text present means it worked, whatever the status line said.
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* a non-JSON body is just an absent result */
  }
  const text = (body as { result?: { text?: unknown } } | null)?.result?.text;
  if (typeof text === "string") return { ok: true, text };

  if (code === BAD_CREDENTIAL) return { ok: false, status: 502, error: "credential" };
  return { ok: false, status: 502, error: message || code };
}
```

- [ ] **Step 4: 跑测试确认通过**

```
bun test src/asr.test.ts
bun run typecheck
```

- [ ] **Step 5: 提交**

```bash
git add src/asr.ts src/asr.test.ts
git commit -m "feat: 把录音转发到火山识别接口"
```

---

### Task 3: `GET/POST /api/asr`

两个端点。`GET` 让前端决定要不要渲染麦克风按钮；`POST` 收音频转文本。

`/api/notify` 是回环限定的，这个**不能**——它必须由浏览器经反代调用。所以它和其余端点一样靠反代兜底，符合 `SECURITY.md` 既有的立场。

请求体设 32MB 上限。**这不是时长限制**（opus 码率下约合一小时以上，没人会那样用），是防止一个坏掉的客户端让服务端把任意大的东西读进内存。

**Files:**
- Modify: `src/server.ts`（在 `/api/theme` 分支后插入，约 373 行处）
- Modify: `src/server.test.ts`（追加）

**Interfaces:**
- Consumes: `readAsrConfig`、`transcribe`（Task 1、2）
- Produces: `GET /api/asr → { enabled: boolean }`；`POST /api/asr`（body 为原始音频字节）→ `{ text }` 或 `{ error }`

- [ ] **Step 1: 写失败的测试**

追加到 `src/server.test.ts`（沿用该文件既有的启动服务与取 base URL 的方式；下方 `base()` 指代它）：

```ts
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

test("without a key configured, voice input reports itself off", async () => {
  process.env.TMUX_NEXT_ASR_PATH = join(mkdtempSync(join(tmpdir(), "asr-srv-")), "asr.json");
  const res = await fetch(`${base()}/api/asr`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ enabled: false });
});

test("posting audio without a key configured is a 404, not a crash", async () => {
  process.env.TMUX_NEXT_ASR_PATH = join(mkdtempSync(join(tmpdir(), "asr-srv-")), "asr.json");
  const res = await fetch(`${base()}/api/asr`, {
    method: "POST",
    headers: { "content-type": "audio/webm" },
    body: new Uint8Array([1, 2, 3]),
  });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "unconfigured" });
});

test("a configured key makes the button appear", async () => {
  const dir = mkdtempSync(join(tmpdir(), "asr-srv-"));
  process.env.TMUX_NEXT_ASR_PATH = join(dir, "asr.json");
  await Bun.write(process.env.TMUX_NEXT_ASR_PATH, JSON.stringify({ key: "fake-key-0000" }));
  expect(await (await fetch(`${base()}/api/asr`)).json()).toEqual({ enabled: true });
});
```

> 这里**没有**「配好 key 再 POST」的用例，是刻意的：那会打真实火山接口，花钱、依赖网络、还要一个私密凭据进 CI。转发本身由 Task 2 的注入式假 `fetch` 覆盖。

- [ ] **Step 2: 跑测试确认它失败**

```
bun test src/server.test.ts -t "voice input"
```

Expected: FAIL — 404 落到静态文件分支，返回的不是期望的 JSON

- [ ] **Step 3: 写最小实现**

在 `src/server.ts` 顶部补 import：

```ts
import { readAsrConfig, transcribe } from "./asr";
```

在文件常量区加：

```ts
/**
 * Not a duration limit — the design deliberately has none. This only stops a
 * broken client from making the server read something unbounded into memory;
 * at opus bitrates it is well over an hour of speech.
 */
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
```

在 `/api/theme` 的 POST 分支之后插入：

```ts
      // Voice input. Off unless a key is configured, and the browser asks first
      // so a microphone button that could only fail is never drawn.
      if (url.pathname === "/api/asr" && req.method === "GET") {
        return Response.json({ enabled: (await readAsrConfig()) !== null });
      }
      if (url.pathname === "/api/asr" && req.method === "POST") {
        const config = await readAsrConfig();
        if (!config) return Response.json({ error: "unconfigured" }, { status: 404 });

        const audio = await req.arrayBuffer();
        if (audio.byteLength > MAX_AUDIO_BYTES) {
          return Response.json({ error: "toobig" }, { status: 413 });
        }
        // The recording is never written anywhere: it goes upstream and is
        // dropped. It is more sensitive than anything else this server holds,
        // and keeping it would buy nothing.
        const result = await transcribe(audio, config, crypto.randomUUID());
        if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
        return Response.json({ text: result.text });
      }
```

- [ ] **Step 4: 跑测试确认通过**

```
bun test src/server.test.ts
bun run typecheck
```

- [ ] **Step 5: 提交**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat: /api/asr 两个端点"
```

---

### Task 4: `tmux-next asr <key>` 子命令

与既有的 `bunx tmux-next hook` 同构。不做网页表单：页面本身没有鉴权，让密钥经由无鉴权的表单落盘比让用户跑一条命令糟糕得多。

**Files:**
- Modify: `src/cli.ts:28`（`CliResult` 联合）、`src/cli.ts:36`（子命令分派）、`src/cli.ts` 的 `HELP`
- Modify: `src/cli.test.ts`（追加）
- Modify: `src/index.ts:49`（在 `hook` 分派之后）

**Interfaces:**
- Consumes: `writeAsrConfig`、`asrPath`（Task 1）
- Produces: `CliResult` 新增变体 `{ kind: "asr"; key: string }`

- [ ] **Step 1: 写失败的测试**

追加到 `src/cli.test.ts`：

```ts
test("asr takes a key", () => {
  expect(parseArgs(["asr", "fake-key-0000"])).toEqual({ kind: "asr", key: "fake-key-0000" });
});

test("asr without a key is an error, not a silent no-op", () => {
  expect(parseArgs(["asr"])).toEqual({ kind: "error", message: "asr needs a key" });
});

// A key that got shell-split would otherwise be stored truncated, and the
// failure would only show up much later as "credential".
test("asr refuses extra arguments", () => {
  expect(parseArgs(["asr", "a", "b"])).toEqual({ kind: "error", message: "asr takes one key" });
});

test("asr does not swallow a following flag as its key", () => {
  expect(parseArgs(["asr", "--help"])).toEqual({ kind: "error", message: "asr needs a key" });
});
```

- [ ] **Step 2: 跑测试确认它失败**

```
bun test src/cli.test.ts -t asr
```

Expected: FAIL — 返回的是 `{ kind: "error", message: 'unknown option "asr"' }`

- [ ] **Step 3: 写最小实现**

`src/cli.ts` 的 `CliResult` 加一个变体：

```ts
export type CliResult =
  | { kind: "run"; port: number; host: string }
  | { kind: "hook" }
  | { kind: "asr"; key: string }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };
```

在 `hook` 那一行之后加：

```ts
  // Stores the speech-recognition key. Taken before the flag loop for the same
  // reason `hook` is: it is a subcommand, not an option.
  if (argv[0] === "asr") {
    const key = argv[1];
    if (key === undefined || key.startsWith("-")) {
      return { kind: "error", message: "asr needs a key" };
    }
    if (argv.length > 2) return { kind: "error", message: "asr takes one key" };
    return { kind: "asr", key };
  }
```

`HELP` 的 Usage 段加一行：

```
  tmux-next asr <key>   store the speech-recognition key (enables voice input)
```

`src/index.ts` 在 `hook` 分派之后加：

```ts
if (parsed.kind === "asr") {
  const { writeAsrConfig, asrPath } = await import("./asr");
  if (!(await writeAsrConfig(parsed.key))) {
    console.error("tmux-next: that key is empty");
    process.exit(2);
  }
  console.log(`saved to ${asrPath()}`);
  process.exit(0);
}
```

- [ ] **Step 4: 跑测试确认通过**

```
bun test src/cli.test.ts
bun run typecheck
```

- [ ] **Step 5: 提交**

```bash
git add src/cli.ts src/cli.test.ts src/index.ts
git commit -m "feat: tmux-next asr 子命令写入识别凭据"
```

---

### Task 5: `public/voice-recorder.js` — 录音状态机

无 DOM、无 `MediaRecorder` 引用，工厂函数从外面注入。这样它能在 Bun 里用一个假录音机跑完，不需要浏览器。

**Files:**
- Create: `public/voice-recorder.js`
- Create: `src/voice-recorder.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `createVoiceRecorder(deps) → { state, elapsedMs(), start(stream), stop(), cancel() }`
  - `deps.makeRecorder(stream)` 返回一个 MediaRecorder 形状的对象（有 `start()`、`stop()`、`mimeType`、`ondataavailable`、`onstop`）
  - `deps.now?()` 返回毫秒时钟，默认 `Date.now`
  - `start(stream)` 返回 `boolean`（是否真的开始了）
  - `stop()` / `cancel()` 返回 `Promise<Blob|null>`

- [ ] **Step 1: 写失败的测试**

创建 `src/voice-recorder.test.ts`：

```ts
import { test, expect } from "bun:test";
import { createVoiceRecorder } from "../public/voice-recorder.js";

/**
 * A MediaRecorder stand-in.
 *
 * The real one only exists in a browser, and the state machine is the part
 * worth testing — so the machine takes a factory and this stands in for it.
 */
class FakeRecorder {
  mimeType = "audio/webm;codecs=opus";
  started = false;
  stopped = false;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() { this.started = true; }
  stop() {
    this.stopped = true;
    this.ondataavailable?.({ data: new Blob(["0123456789"]) });
    this.onstop?.();
  }
}

function harness() {
  const made: FakeRecorder[] = [];
  let clock = 1000;
  const rec = createVoiceRecorder({
    makeRecorder: () => { const r = new FakeRecorder(); made.push(r); return r; },
    now: () => clock,
  });
  return { rec, made, tick: (ms: number) => { clock += ms; } };
}

const STREAM = {} as unknown;

test("it starts idle", () => {
  expect(harness().rec.state).toBe("idle");
});

test("starting moves it to recording and starts the recorder", () => {
  const { rec, made } = harness();
  expect(rec.start(STREAM)).toBe(true);
  expect(rec.state).toBe("recording");
  expect(made).toHaveLength(1);
  expect(made[0]!.started).toBe(true);
});

// A double tap on the record button must not leave a second recorder running
// against the same stream, which would then never be stopped.
test("starting twice does not create a second recorder", () => {
  const { rec, made } = harness();
  rec.start(STREAM);
  expect(rec.start(STREAM)).toBe(false);
  expect(made).toHaveLength(1);
});

test("stopping yields a blob carrying the recorder's own mime type", async () => {
  const { rec } = harness();
  rec.start(STREAM);
  const blob = await rec.stop();
  expect(blob).not.toBeNull();
  expect(blob!.type).toBe("audio/webm;codecs=opus");
  expect(blob!.size).toBe(10);
  expect(rec.state).toBe("idle");
});

test("cancelling stops the recorder but yields nothing", async () => {
  const { rec, made } = harness();
  rec.start(STREAM);
  expect(await rec.cancel()).toBeNull();
  expect(made[0]!.stopped).toBe(true);
  expect(rec.state).toBe("idle");
});

test("stopping when it never started yields nothing", async () => {
  expect(await harness().rec.stop()).toBeNull();
});

test("elapsed time comes from the injected clock and resets when idle", () => {
  const { rec, tick } = harness();
  expect(rec.elapsedMs()).toBe(0);
  rec.start(STREAM);
  tick(2500);
  expect(rec.elapsedMs()).toBe(2500);
});

// Tapping stop the instant after start can produce no chunks at all; sending
// an empty body upstream would just be a wasted round trip and a confusing
// error, so it is treated as nothing recorded.
test("a recording with no data yields nothing", async () => {
  const rec = createVoiceRecorder({
    makeRecorder: () => {
      const r = new FakeRecorder();
      r.stop = function () { this.onstop?.(); };
      return r;
    },
  });
  rec.start(STREAM);
  expect(await rec.stop()).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认它失败**

```
bun test src/voice-recorder.test.ts
```

Expected: FAIL — `Cannot find module '../public/voice-recorder.js'`

- [ ] **Step 3: 写最小实现**

创建 `public/voice-recorder.js`：

```js
// @ts-check
/**
 * Recording, as a state machine with nothing in it that needs a browser.
 *
 * MediaRecorder only exists in a page, and its behaviour differs across iOS
 * versions — but the part that has bugs in it is the sequencing: what a second
 * tap does, what happens when stop arrives before any data, whether a cancelled
 * take can still be sent. So the recorder arrives through a factory and all of
 * that is testable headlessly.
 */

/** @typedef {"idle"|"recording"} RecorderState */

/**
 * @typedef {Object} RecorderDeps
 * @property {(stream: any) => any} makeRecorder returns a MediaRecorder-shaped object
 * @property {() => number} [now] millisecond clock; defaults to Date.now
 */

/**
 * @param {RecorderDeps} deps
 */
export function createVoiceRecorder(deps) {
  const now = deps.now || (() => Date.now());

  /** @type {RecorderState} */
  let state = "idle";
  /** @type {any} */
  let recorder = null;
  /** @type {any[]} */
  let chunks = [];
  let startedAt = 0;
  let discarding = false;
  /** @type {((blob: any) => void) | null} */
  let settle = null;

  function finish() {
    const done = settle;
    const parts = chunks;
    const type = (recorder && recorder.mimeType) || "audio/webm";
    const drop = discarding;
    state = "idle";
    recorder = null;
    chunks = [];
    settle = null;
    discarding = false;
    if (done) done(drop || !parts.length ? null : new Blob(parts, { type }));
  }

  /** @param {boolean} drop */
  function end(drop) {
    if (state !== "recording") return Promise.resolve(null);
    discarding = drop;
    return new Promise((resolve) => {
      settle = resolve;
      recorder.stop();
    });
  }

  return {
    get state() {
      return state;
    },

    elapsedMs() {
      return state === "recording" ? now() - startedAt : 0;
    },

    /**
     * @param {any} stream
     * @returns {boolean} whether this call actually started a recording
     */
    start(stream) {
      if (state === "recording") return false;
      recorder = deps.makeRecorder(stream);
      chunks = [];
      discarding = false;
      recorder.ondataavailable = (/** @type {any} */ e) => {
        if (e && e.data && e.data.size) chunks.push(e.data);
      };
      recorder.onstop = finish;
      recorder.start();
      startedAt = now();
      state = "recording";
      return true;
    },

    /** @returns {Promise<any>} the recording, or null if there was nothing */
    stop() {
      return end(false);
    },

    /** @returns {Promise<any>} always null; the take is thrown away */
    cancel() {
      return end(true);
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```
bun test src/voice-recorder.test.ts
bun run typecheck
bun test src/public-parses.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add public/voice-recorder.js src/voice-recorder.test.ts
git commit -m "feat: 录音状态机"
```

---

### Task 6: `public/voice-panel.js` — 面板

DOM 很重，所以**不加** `// @ts-check`（与 `terminal.js`、`list.js` 一致，`tsconfig` 的 `checkJs` 是 false）。但按「会渲染的浏览器模块必须有渲染测试」那条规矩，必须用 happy-dom 挂起来断言。

麦克风、录音机、识别请求全部注入，测试因此既不碰网络也不碰媒体设备。

**Files:**
- Create: `public/voice-panel.js`
- Create: `src/voice-panel.test.ts`

**Interfaces:**
- Consumes: `createVoiceRecorder`（Task 5）
- Produces: `createVoicePanel(deps) → { element, open(), close() }`
  - `deps.getStream(): Promise<MediaStream>`
  - `deps.makeRecorder(stream)`
  - `deps.transcribe(blob): Promise<string>`
  - `deps.onInsert(text: string): void`
  - `deps.onClose(): void`
  - `deps.tr(key: string, vars?: object): string`
  - `element.dataset.mode` 取值 `"idle" | "recording" | "working" | "review" | "error"`
  - 可点控件带 `data-role`：`record`、`cancel`、`again`、`insert`、`close`

- [ ] **Step 1: 写失败的测试**

创建 `src/voice-panel.test.ts`：

```ts
import { test, expect, afterEach } from "bun:test";
import { Window } from "happy-dom";

/**
 * The voice panel, driven in a real DOM.
 *
 * Bundling proves it parses; only mounting proves it draws. Everything that
 * would need a browser — the microphone, the recorder, the network — is
 * injected, so this runs headlessly and deterministically.
 */

/**
 * Globals this file replaces, so they can be put back.
 *
 * Bun runs every test file in one process; a shim that does not clean up after
 * itself stops being a test and becomes a hazard for every other file.
 */
const PATCHED = ["window", "document", "Blob"] as const;
const saved = new Map<string, unknown>();

function mountDom() {
  const win = new Window({ url: "https://localhost/terminal.html" });
  for (const key of PATCHED) {
    if (key in globalThis) saved.set(key, (globalThis as Record<string, unknown>)[key]);
    Object.defineProperty(globalThis, key, {
      value: (win as unknown as Record<string, unknown>)[key],
      writable: true,
      configurable: true,
    });
  }
}

afterEach(() => {
  for (const key of PATCHED) {
    if (saved.has(key)) {
      Object.defineProperty(globalThis, key, {
        value: saved.get(key), writable: true, configurable: true,
      });
    } else {
      delete (globalThis as Record<string, unknown>)[key];
    }
  }
  saved.clear();
});

class FakeRecorder {
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: unknown }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {}
  stop() {
    this.ondataavailable?.({ data: new Blob(["audio"]) });
    this.onstop?.();
  }
}

const track = () => ({ stopped: false, stop() { this.stopped = true; } });

async function panelWith(over: Record<string, unknown> = {}) {
  mountDom();
  const { createVoicePanel } = await import("../public/voice-panel.js");
  const tracks = [track()];
  const calls: { transcribed: number; inserted: string[]; closed: number } = {
    transcribed: 0, inserted: [], closed: 0,
  };
  const panel = createVoicePanel({
    getStream: async () => ({ getTracks: () => tracks }),
    makeRecorder: () => new FakeRecorder(),
    transcribe: async () => { calls.transcribed++; return "把 hook 修好"; },
    onInsert: (t: string) => calls.inserted.push(t),
    onClose: () => { calls.closed++; },
    tr: (k: string) => k,
    ...over,
  });
  document.body.append(panel.element);
  await panel.open();
  return { panel, calls, tracks };
}

const role = (el: HTMLElement, name: string) =>
  el.querySelector(`[data-role="${name}"]`) as HTMLElement | null;

test("an opened panel offers the record button", async () => {
  const { panel } = await panelWith();
  expect(panel.element.dataset.mode).toBe("idle");
  expect(role(panel.element, "record")).not.toBeNull();
});

test("the one state button switches to recording, and cancel appears with it", async () => {
  const { panel } = await panelWith();
  role(panel.element, "record")!.click();
  expect(panel.element.dataset.mode).toBe("recording");
  // Same button, still there — not a second control.
  expect(panel.element.querySelectorAll('[data-role="record"]')).toHaveLength(1);
  expect(role(panel.element, "cancel")).not.toBeNull();
});

test("stopping transcribes and shows the text for review", async () => {
  const { panel, calls } = await panelWith();
  role(panel.element, "record")!.click();
  role(panel.element, "record")!.click();
  await Bun.sleep(0);
  expect(calls.transcribed).toBe(1);
  expect(panel.element.dataset.mode).toBe("review");
  const box = panel.element.querySelector("textarea") as HTMLTextAreaElement;
  expect(box.value).toBe("把 hook 修好");
});

// The whole point of the review box: what gets inserted is what the user
// approved, not what the recogniser guessed.
test("inserting sends the edited text, not the recognised text", async () => {
  const { panel, calls } = await panelWith();
  role(panel.element, "record")!.click();
  role(panel.element, "record")!.click();
  await Bun.sleep(0);
  const box = panel.element.querySelector("textarea") as HTMLTextAreaElement;
  box.value = "把 hook 修好，再跑一遍测试";
  role(panel.element, "insert")!.click();
  expect(calls.inserted).toEqual(["把 hook 修好，再跑一遍测试"]);
});

test("cancelling a recording transcribes nothing and returns to idle", async () => {
  const { panel, calls } = await panelWith();
  role(panel.element, "record")!.click();
  role(panel.element, "cancel")!.click();
  await Bun.sleep(0);
  expect(calls.transcribed).toBe(0);
  expect(panel.element.dataset.mode).toBe("idle");
});

test("a refused microphone explains itself instead of showing a dead button", async () => {
  const { panel } = await panelWith({ getStream: async () => { throw new Error("denied"); } });
  expect(panel.element.dataset.mode).toBe("error");
  expect(role(panel.element, "record")).toBeNull();
  expect(panel.element.textContent).toContain("voice.denied");
});

test("a failed transcription says so and offers another take", async () => {
  const { panel } = await panelWith({ transcribe: async () => { throw new Error("502"); } });
  role(panel.element, "record")!.click();
  role(panel.element, "record")!.click();
  await Bun.sleep(0);
  expect(panel.element.dataset.mode).toBe("error");
  expect(role(panel.element, "again")).not.toBeNull();
});

// iOS shows a system-wide recording indicator for as long as the track is
// live; leaving it on after the panel is gone would be a lie.
test("closing releases the microphone and tells the host", async () => {
  const { panel, calls, tracks } = await panelWith();
  panel.close();
  expect(tracks[0]!.stopped).toBe(true);
  expect(calls.closed).toBe(1);
  expect(panel.element.isConnected).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认它失败**

```
bun test src/voice-panel.test.ts
```

Expected: FAIL — `Cannot find module '../public/voice-panel.js'`

- [ ] **Step 3: 写最小实现**

创建 `public/voice-panel.js`：

```js
import { createVoiceRecorder } from "./voice-recorder.js";

/**
 * The voice input panel.
 *
 * It takes the soft keyboard's place rather than sitting above it: on a phone
 * there is only ever room for one of them, and the two are the same kind of
 * thing — whatever fills the bottom of the screen.
 *
 * The microphone, the recorder and the network all arrive as dependencies.
 * That is what lets src/voice-panel.test.ts mount this in happy-dom and drive
 * every state without a browser, a device or a paid API call.
 */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clock(ms) {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function createVoicePanel(deps) {
  const { getStream, makeRecorder, transcribe, onInsert, onClose, tr } = deps;

  const root = el("div", "voice-panel");
  const rec = createVoiceRecorder({ makeRecorder });

  let stream = null;
  let mode = "working";
  let text = "";
  let note = "";
  let ticker = 0;

  function stopTicker() {
    if (ticker) clearInterval(ticker);
    ticker = 0;
  }

  function render() {
    root.dataset.mode = mode;

    if (mode === "error") {
      const kids = [el("p", "voice-note", note)];
      // Only offer another take if there is still a microphone to use.
      if (stream) {
        const again = el("button", "btn", tr("voice.again"));
        again.dataset.role = "again";
        again.addEventListener("click", () => {
          mode = "idle";
          render();
        });
        kids.push(again);
      }
      root.replaceChildren(...kids);
      return;
    }

    if (mode === "working") {
      root.replaceChildren(el("p", "voice-note", tr("voice.working")));
      return;
    }

    if (mode === "review") {
      const box = el("textarea", "voice-text");
      box.value = text;
      box.setAttribute("aria-label", tr("voice.reviewLabel"));

      const again = el("button", "btn", tr("voice.again"));
      again.dataset.role = "again";
      again.addEventListener("click", () => {
        mode = "idle";
        render();
      });

      const insert = el("button", "btn primary", tr("voice.insert"));
      insert.dataset.role = "insert";
      // No Enter: the text lands at the prompt and the user sends it, the same
      // contract as an uploaded image path.
      insert.addEventListener("click", () => {
        onInsert(box.value);
        close();
      });

      const actions = el("div", "voice-actions");
      actions.append(again, insert);
      root.replaceChildren(box, actions);
      return;
    }

    // idle and recording share one button that changes state, so the finger
    // lands in the same place both times.
    const recording = mode === "recording";
    const btn = el("button", "voice-rec", recording ? "■" : "●");
    btn.dataset.role = "record";
    btn.dataset.state = mode;
    btn.setAttribute("aria-label", tr(recording ? "voice.stop" : "voice.start"));
    btn.addEventListener("click", toggle);

    const hint = el("span", "voice-hint", recording ? clock(0) : tr("voice.hint"));
    hint.dataset.role = "hint";

    const kids = [btn, hint];
    if (recording) {
      const cancel = el("button", "btn", tr("voice.cancel"));
      cancel.dataset.role = "cancel";
      cancel.addEventListener("click", async () => {
        stopTicker();
        await rec.cancel();
        mode = "idle";
        render();
      });
      kids.push(cancel);
    }
    root.replaceChildren(...kids);

    stopTicker();
    if (recording) {
      ticker = setInterval(() => {
        hint.textContent = clock(rec.elapsedMs());
      }, 1000);
    }
  }

  async function toggle() {
    if (mode === "recording") {
      stopTicker();
      const blob = await rec.stop();
      if (!blob) {
        mode = "idle";
        render();
        return;
      }
      mode = "working";
      render();
      try {
        text = await transcribe(blob);
      } catch {
        note = tr("voice.failed");
        mode = "error";
        render();
        return;
      }
      if (!text) {
        note = tr("voice.empty");
        mode = "error";
        render();
        return;
      }
      mode = "review";
      render();
      return;
    }

    if (!stream) return;
    rec.start(stream);
    mode = "recording";
    render();
  }

  /**
   * Asks for the microphone when the panel opens, not when recording starts.
   *
   * The permission prompt on first use takes as long as the user takes to
   * answer it, and the opening syllable would be lost behind it.
   */
  async function open() {
    mode = "working";
    render();
    try {
      stream = await getStream();
      mode = "idle";
    } catch {
      stream = null;
      note = tr("voice.denied");
      mode = "error";
    }
    render();
  }

  /**
   * Releases the microphone.
   *
   * iOS shows a system-wide recording indicator for as long as a track is live.
   * Tying the tracks to the panel's lifetime makes that indicator mean exactly
   * "this panel is open", which is honest.
   */
  function close() {
    stopTicker();
    rec.cancel();
    if (stream) {
      for (const t of stream.getTracks()) t.stop();
      stream = null;
    }
    root.remove();
    onClose();
  }

  return { element: root, open, close };
}
```

- [ ] **Step 4: 跑测试确认通过**

```
bun test src/voice-panel.test.ts
bun test src/public-parses.test.ts
bun run typecheck
```

- [ ] **Step 5: 提交**

```bash
git add public/voice-panel.js src/voice-panel.test.ts
git commit -m "feat: 语音输入面板"
```

---

### Task 7: 接进终端页

按钮、互斥、布局、文案。

**Files:**
- Modify: `public/terminal.html`（`.keys-more` 第一行，`#kbd` 之后）
- Modify: `public/terminal.js`（文件末尾新增一节）
- Modify: `public/style.css`
- Modify: `public/i18n.js`（zh 与 en 各加同一批键）

**Interfaces:**
- Consumes: `createVoicePanel`（Task 6）、既有的 `closeKeyboard()`（`terminal.js:457`）、`send(data)`（`terminal.js:381`）、`tr`、`resizeAndNotify()`、`termEl`
- Produces: 无（终点）

- [ ] **Step 1: 加文案键**

`public/i18n.js` 的 `zh` 字典加：

```js
  "term.voice": "语音输入",
  "voice.hint": "轻点开始说话",
  "voice.start": "开始录音",
  "voice.stop": "停止录音",
  "voice.cancel": "取消",
  "voice.again": "重录",
  "voice.insert": "插入",
  "voice.working": "处理中…",
  "voice.reviewLabel": "识别结果，可修改",
  "voice.denied": "无法使用麦克风。请在浏览器里允许麦克风权限，并确认页面是 HTTPS。",
  "voice.failed": "识别失败，请重试",
  "voice.empty": "没有听清，请重试",
```

`en` 字典加同一批键：

```js
  "term.voice": "Voice input",
  "voice.hint": "Tap to speak",
  "voice.start": "Start recording",
  "voice.stop": "Stop recording",
  "voice.cancel": "Cancel",
  "voice.again": "Record again",
  "voice.insert": "Insert",
  "voice.working": "Working…",
  "voice.reviewLabel": "Recognised text, editable",
  "voice.denied": "No microphone. Allow microphone access, and check the page is served over HTTPS.",
  "voice.failed": "Recognition failed — try again",
  "voice.empty": "Didn't catch that — try again",
```

- [ ] **Step 2: 跑 i18n 测试确认它失败**

```
bun test src/i18n.test.ts
```

Expected: FAIL — 报这些键「已定义但无处使用」。这正是该测试的用途，接下来的步骤会用上它们。

- [ ] **Step 3: 加按钮**

`public/terminal.html` 中 `#kbd` 那一行之后插入。`hidden` 是默认状态：没配 key 的人不该看见它。

```html
      <button id="mic" data-usage="voice" hidden
              data-i18n-title="term.voice" data-i18n-aria="term.voice">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="9" y="2" width="6" height="12" rx="3"/>
          <path d="M5 11a7 7 0 0 0 14 0"/>
          <path d="M12 18v3"/>
        </svg>
      </button>
```

- [ ] **Step 4: 接线**

`public/terminal.js` 末尾追加：

```js
// --- voice input ------------------------------------------------------------

/**
 * Speech to text, in the space the soft keyboard would occupy.
 *
 * The panel and the keyboard are mutually exclusive by construction: opening
 * one closes the other, because there is only room for one and having both
 * fight over the bottom of the screen is worse than either.
 */
const micBtn = document.getElementById("mic");
let voicePanel = null;

async function transcribeBlob(blob) {
  const res = await fetch("api/asr", {
    method: "POST",
    headers: { "content-type": blob.type || "application/octet-stream" },
    body: blob,
  });
  if (!res.ok) throw new Error(String(res.status));
  const { text } = await res.json();
  return text || "";
}

function forgetVoicePanel() {
  voicePanel = null;
  micBtn.classList.remove("sticky-on");
  // The panel took height from the terminal; give it back and tell tmux.
  resizeAndNotify();
}

async function openVoice() {
  if (voicePanel) return;
  closeKeyboard();
  const { createVoicePanel } = await import("./voice-panel.js");
  const panel = createVoicePanel({
    getStream: () => navigator.mediaDevices.getUserMedia({ audio: true }),
    makeRecorder: (stream) => new MediaRecorder(stream),
    transcribe: transcribeBlob,
    // No Enter — the same contract as an uploaded image path. The user adds
    // their own words and sends.
    onInsert: (text) => { if (text) send(text); },
    onClose: forgetVoicePanel,
    tr,
  });
  voicePanel = panel;
  termEl.after(panel.element);
  micBtn.classList.add("sticky-on");
  resizeAndNotify();
  panel.open();
}

micBtn.addEventListener("pointerdown", (e) => {
  // pointerdown, not click: the handler on .keys cancels the default action to
  // protect terminal focus, which would also swallow a later click.
  e.preventDefault();
  if (voicePanel) voicePanel.close();
  else openVoice();
});

// The button appears only when a key is configured. A microphone that could
// only ever fail is worse than no microphone at all.
fetch("api/asr")
  .then((r) => r.json())
  .then(({ enabled }) => {
    if (enabled && typeof MediaRecorder !== "undefined") micBtn.hidden = false;
  })
  .catch(() => {});
```

- [ ] **Step 5: 加样式**

`public/style.css` 末尾追加。**不得出现颜色字面量**——只用既有变量。

```css
/* ---- voice panel ---- */

/* Roughly a soft keyboard's height, in the place it would have taken. */
.voice-panel {
  flex: 0 0 auto;
  height: 240px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 16px;
  background: var(--card);
}

.voice-rec {
  width: 72px;
  height: 72px;
  border: 0;
  border-radius: 50%;
  background: var(--accent);
  color: var(--bg);
  font-size: 26px;
  line-height: 1;
}
.voice-rec[data-state="recording"] { background: var(--term-red, var(--accent)); }
.voice-rec:active { opacity: 0.7; }

.voice-hint { color: var(--dim); font-size: 14px; font-variant-numeric: tabular-nums; }
.voice-note { color: var(--dim); font-size: 14px; text-align: center; margin: 0; max-width: 30em; }

.voice-text {
  width: 100%;
  flex: 1 1 auto;
  resize: none;
  border: 0;
  border-radius: 8px;
  padding: 10px;
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  font-size: 16px; /* under 16px iOS zooms the page on focus */
}

.voice-actions { display: flex; gap: 10px; align-self: stretch; }
.voice-actions .btn { flex: 1 1 0; }
```

- [ ] **Step 6: 跑全套测试**

```
bun run typecheck
bun test
```

Expected: 全部 PASS，`i18n.test.ts` 不再报未使用的键

- [ ] **Step 7: 手工验证（必须在真机上做一遍）**

`public/` 是每次请求现读的，`src/` 只在启动时加载一次且 Bun 不带 `--watch` 不会重载——所以改完后端**必须重启服务**再验，不能凭时间戳推断跑的是新代码。

```bash
launchctl kickstart -k gui/$(id -u)/local.tmux-next
```

在手机上依次确认：

1. 没配 key 时，麦克风按钮不出现
2. `bunx tmux-next asr <key>` 后刷新，按钮出现
3. 点麦克风 → 系统键盘收起，面板占据它的位置，终端相应变矮
4. 点 `●` → 变 `■` 并开始计时；点 `取消` → 回到待录且没有发出识别请求
5. 说一句 → 点 `■` → 出现可编辑框；**点进框里能正常打字修改**（`restoreFocusSoon` 有 `keyboardWanted` 守卫，而 `closeKeyboard()` 已把它置 false，所以焦点不应被抢回终端——这条必须真机确认）
6. 点 `插入` → 文本进提示符且**没有自动回车**
7. 再点麦克风关闭面板 → 终端恢复高度，iOS 的录音指示器熄灭

- [ ] **Step 8: 提交**

```bash
git add public/terminal.html public/terminal.js public/style.css public/i18n.js
git commit -m "feat: 终端页的语音输入入口"
```

---

### Task 8: 文档

`README.md` 是英文，`README.zh-CN.md` 是它的镜像，行为变化时两边必须同步。

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`

**Interfaces:**
- Consumes: 前面全部
- Produces: 无

- [ ] **Step 1: 写英文段落**

在功能列表里加一条，并在配置相关的小节加：

````markdown
### Voice input (optional)

Dictating a prompt beats typing one on a phone. The system keyboard's own
dictation key cannot work here — iOS rewrites the whole text repeatedly and
xterm.js treats every rewrite as fresh keystrokes — so tmux-next records the
audio itself and sends it to Volcano Engine for recognition.

It is off until you give it a key:

```
bunx tmux-next asr <key>
```

That writes `~/.tmux-next/asr.json` with mode 0600. Without it the microphone
button never appears.

The audio goes to the server and straight upstream; it is never written to
disk. The key never leaves the machine — the browser talks only to tmux-next.
Recognition is a paid Volcano Engine service and is billed to your account.
Recording needs a secure context, so use the HTTPS reverse proxy, not plain
`http://` over the network.
````

- [ ] **Step 2: 写中文镜像**

````markdown
### 语音输入（可选）

手机上说一句比打一句快。系统输入法自带的语音键在这里用不了——iOS 会把整段文本
反复重写，而 xterm.js 把每次重写都当成新按键——所以 tmux-next 自己录音，送火山
引擎识别。

不配 key 就是关着的：

```
bunx tmux-next asr <key>
```

它写入 `~/.tmux-next/asr.json`，权限 0600。没有它，麦克风按钮不会出现。

音频经服务端直接转发，不落盘。key 不出本机——浏览器只和 tmux-next 说话。识别是
火山引擎的付费服务，按你的账号计费。录音需要安全上下文，所以要走 HTTPS 反代，
不能用局域网里的明文 `http://`。
````

- [ ] **Step 3: 跑全套测试**

```
bun run test
```

- [ ] **Step 4: 提交**

```bash
git add README.md README.zh-CN.md
git commit -m "docs: 语音输入的使用说明"
```

---

## Self-Review

**Spec coverage** — 设计文档每一节都有对应任务：

| 设计文档小节 | 任务 |
|---|---|
| 供应商与实测结论 | Task 2（请求形状、无 `format` 字段） |
| 入口与空间、与 `⌨` 互斥 | Task 7 |
| 三态、一个状态按钮、不限时长 | Task 6（无自动停止逻辑） |
| 识别结果先复核、插入不带回车 | Task 6 + Task 7 的 `onInsert` |
| 麦克风流的生命周期 | Task 6 的 `open()` / `close()` |
| 服务端两个端点、音频不落盘 | Task 3 |
| 配置文件与环境变量覆盖 | Task 1 |
| `bunx tmux-next asr <key>` | Task 4 |
| 纯逻辑拆出来测 | Task 5、6 |
| 不打真实接口 | Task 2、3 的注入式假 `fetch` |

**与设计文档的一处补充：** Task 3 的 32MB 请求体上限。设计文档说「不做时长限制」，这个上限不是时长限制（opus 码率下约合一小时以上），是防止坏掉的客户端让服务端读入无界数据。已在代码注释里写明区别。

**类型一致性** — `AsrConfig`、`Fetch`、`TranscribeResult` 在 Task 1/2 定义，Task 3 消费；`createVoiceRecorder` 在 Task 5 定义，Task 6 消费；`createVoicePanel` 在 Task 6 定义，Task 7 消费。`data-role` 取值在 Task 6 的 Interfaces 里列全，测试与实现使用同一组。

**未覆盖的风险，留给 Task 7 Step 7 的真机验证：**
- iOS 上 `MediaRecorder` 实际产出的 mimeType（18.4 起为 webm/opus，之前为 mp4/aac）——两者都已验证接口接受，但没在真机上跑过端到端
- 面板里的 textarea 与终端焦点的争夺——推理上 `keyboardWanted` 守卫已覆盖，但必须真机确认
