# Jira 工单插件 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机上看到分给自己的 Jira 单，点一个就能开会话；开完之后会话列表每行都标出它属于哪个单。

**Architecture:** 一个内置插件 `plugins/jira/`，走已有的插件接缝（清单 `plugin.js` + 服务端 `server.ts` + 自己的 `public/`）。它自己调内核公开的 `POST /api/sessions` 建会话，绑定关系存在插件自己的状态目录里。接缝新增一种**只读标注**能力：内核构建会话列表时向插件要一小段展示数据，300ms 硬超时、出错即忽略。

**Tech Stack:** Bun（无构建步骤）、TypeScript 只做 `tsc --noEmit`、`public/` 与 `plugins/*/public/` 是浏览器直接加载的纯 ES 模块、`bun test`、happy-dom 做 DOM 渲染测试。

**Spec:** `docs/superpowers/specs/2026-08-30-jira-plugin-design.md`

## Global Constraints

- **仓库是公开的，历史被清洗过一次。** 源码、夹具、文档、默认值里**绝不能**出现真实的 Jira 域名、公司名、项目前缀、工单号、邮箱。夹具一律 `EXAMPLE-1`、`https://example.atlassian.net`、`dev@example.com`。
- **一次真实的 Jira 请求都不许发。** 所有 Jira HTTP 走一个可注入的 fetcher，测试注入假的。
- **只跑配置里的 JQL，绝不接受浏览器传来的 JQL。** 否则这个无认证服务就成了任人查询的 Jira 代理。这是安全边界。
- **没有任何接口回显 token。** `GET /api/jira/config` 只返回 `{ configured, url, email }`。token 也从不进日志。
- **不透传 Jira 的原始错误体**，那里面带账号信息。错误归类后再吐。
- **插件依赖内核，内核不认识任何具体插件。** `src/` 下不许 import `plugins/<某个插件>/`；`src/server.ts` import `plugins/handlers.ts` 是接缝面向内核的接口，不算违反。
- **`plugins/registry.js` 绝不能 import 任何 `.ts`**（浏览器要加载它）。加插件是**两处各一行**：`registry.js` 和 `handlers.ts`。
- **源码里不写死绝对 URL 路径**（会弄断反代子路径部署）。共享模块与插件页面走 `public/root.js` 的 `url()`。
- **插件页面不加 `// @ts-check`**：它们的 import specifier 按被服务的 URL 写（`/p/<id>/`，两层深），不是磁盘路径（三层深），tsc 跟不过去。跟随 `plugins/gallery/public/gallery.js` 的先例与注释。
- **状态路径在函数里惰性读 env**，不在模块加载时捕获。插件状态目录走 `pluginStateDir("jira")` → `TMUX_NEXT_JIRA_DIR`，默认 `~/.tmux-next/jira/`。
- **每个 tmux 调用走 `tmux(argv)`（`src/tmux/run.ts`），永不用 `Bun.$`。**
- **UI 文案一律进字典**，不内联。插件自己的文案放在 `plugins/jira/plugin.js` 的 `i18n`，两种语言键集必须一致。
- **提交信息用中文**，格式同现有 `git log`（`feat:` / `fix:` / `refactor:` / `docs:`）。**不带任何助手署名**——没有 `Co-Authored-By:`、没有 `Claude-Session:`、没有 `🤖 Generated with`。
- **`bun` 不在默认 PATH 上**：每条命令前加 `export PATH="$HOME/.bun/bin:$PATH"`。
- **永不运行 `tmux kill-server`，永不 kill 任何 tmux 会话。** 这台机器上的 tmux server 装着用户的真实工作。
- **永不使用 `git stash`**：stash 栈跨 worktree 共享，裸 stash/pop 会吞掉别的会话的工作。要暂存就用临时 WIP 提交。
- **不许写 `~/.tmux-next/` 下的任何东西**（那是用户真实状态），也不许读 `~/.claude/credentials.md`。测试一律用 env 覆盖到临时目录。
- **已知失败基线**：`bun run test` 有且只有两条失败——`src/server.test.ts` "closing the websocket leaves no orphan web session" 与 `src/reconnect.test.ts` "repeated reconnects leave no orphan web sessions"。用户自己的 tmux-next 服务器在跑，这两条断言数的是共享 tmux server 上所有 `web-` 会话。出现第三条就是回归。

---

## 文件结构

```
plugins/jira/
  plugin.js          清单：id、图标、标题键、两本字典
  server.ts          handle(req, url) + annotate(sessions)
  config.ts          读写 config.json（含 0600）
  client.ts          Jira HTTP，可注入 fetcher，错误归类
  bindings.ts        绑定的读写与解析
  sessions.ts        向 tmux 问 session_id ↔ session_name
  public/index.html
  public/jira.js
  *.test.ts          与被测代码同目录
```

内核侧改动：`plugins/types.ts`（加 `Annotation`）、`plugins/handlers.ts`（加 `ANNOTATORS` 与 `collectAnnotations`）、`src/server.ts`（`/api/sessions` GET 合并标注）、`public/list.js`（泛型渲染标注）。

---

### Task 1: Jira 配置与客户端

**Files:**
- Create: `plugins/jira/config.ts`
- Create: `plugins/jira/config.test.ts`
- Create: `plugins/jira/client.ts`
- Create: `plugins/jira/client.test.ts`
- Create: `plugins/jira/fixtures.test.ts`

**Interfaces:**
- Consumes: `pluginStateDir(id: string): string`（`plugins/state.ts`，已存在）
- Produces: `readJiraConfig(): Promise<JiraConfig | null>`、`writeJiraConfig(c: JiraConfig): Promise<void>`、`JiraConfig = { url: string; email: string; token: string; jql: string }`、`DEFAULT_JQL`
- Produces: `fetchIssues(config: JiraConfig, fetcher?: typeof fetch): Promise<IssuesResult>`、`Issue = { key: string; summary: string; status: string; statusCategory: string; updated: number }`、`IssuesResult = { ok: true; issues: Issue[] } | { ok: false; reason: "unconfigured" | "auth" | "query" | "unreachable" }`

- [ ] **Step 1: 写失败的配置测试**

创建 `plugins/jira/config.test.ts`：

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJiraConfig, writeJiraConfig, DEFAULT_JQL } from "./config";

/**
 * 凭据落盘的那一份。存的是能读用户 Jira 的东西，所以这里检的不只是"存得进读得出"，
 * 还有权限位——一个 0644 的 token 文件，跟没存加密没两样。
 */

let root: string;
let saved: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jira-cfg-"));
  saved = process.env.TMUX_NEXT_JIRA_DIR;
  process.env.TMUX_NEXT_JIRA_DIR = root;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.TMUX_NEXT_JIRA_DIR;
  else process.env.TMUX_NEXT_JIRA_DIR = saved;
  await rm(root, { recursive: true, force: true });
});

test("没有配置文件时读出 null，而不是抛", async () => {
  // 绝大多数装机是没配过的，这不值得让一个页面加载失败。
  expect(await readJiraConfig()).toBeNull();
});

test("坏 JSON 也读成 null", async () => {
  await writeFile(join(root, "config.json"), "{ not json");
  expect(await readJiraConfig()).toBeNull();
});

test("缺任一必填项就读成 null", async () => {
  for (const partial of [
    { email: "dev@example.com", token: "t" },
    { url: "https://example.atlassian.net", token: "t" },
    { url: "https://example.atlassian.net", email: "dev@example.com" },
    { url: "  ", email: "dev@example.com", token: "t" },
  ]) {
    await writeFile(join(root, "config.json"), JSON.stringify(partial));
    expect({ partial, cfg: await readJiraConfig() }).toEqual({ partial, cfg: null });
  }
});

test("写进去读得回来，JQL 缺省时补默认值", async () => {
  await writeJiraConfig({
    url: "https://example.atlassian.net",
    email: "dev@example.com",
    token: "secret-token",
    jql: "",
  });
  const cfg = await readJiraConfig();
  expect(cfg?.url).toBe("https://example.atlassian.net");
  expect(cfg?.email).toBe("dev@example.com");
  expect(cfg?.jql).toBe(DEFAULT_JQL);
});

test("配置文件只有属主可读写", async () => {
  await writeJiraConfig({
    url: "https://example.atlassian.net",
    email: "dev@example.com",
    token: "secret-token",
    jql: "",
  });
  const s = await stat(join(root, "config.json"));
  // 0600。同机器上的别的用户不该能读到这个 token。
  expect(s.mode & 0o777).toBe(0o600);
});

test("末尾斜杠被吃掉，好让 URL 拼接不出双斜杠", async () => {
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({ url: "https://example.atlassian.net/", email: "dev@example.com", token: "t" }),
  );
  expect((await readJiraConfig())?.url).toBe("https://example.atlassian.net");
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test plugins/jira/config.test.ts
```

预期：FAIL，`Cannot find module './config'`。

- [ ] **Step 3: 写配置模块**

创建 `plugins/jira/config.ts`：

```ts
import { join } from "node:path";
import { mkdir, chmod, writeFile } from "node:fs/promises";
import { pluginStateDir } from "../state";

/**
 * Jira 凭据，以及只有它。
 *
 * 刻意不读 ~/.claude/credentials.md：那是 Claude Code 的约定文件，解析自由格式
 * Markdown 取凭据格式一飘就坏；更要紧的是它是一份**总账**，让这个无认证的服务
 * 去读它，等于把暴露面从 Jira 一家扩大到里面所有服务。首次配置把三项搬过来即可，
 * 之后两者互不相干。
 *
 * 模式跟 src/asr.ts 一样：没有文件就是"没配过"，不是错误。
 */

export type JiraConfig = { url: string; email: string; token: string; jql: string };

/** 分给我的、还没做完的，最近更新的在前。 */
export const DEFAULT_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

export function jiraConfigPath(): string {
  return join(pluginStateDir("jira"), "config.json");
}

/**
 * 存着的凭据，或者 null。
 *
 * 全函数：文件不在（最常见）、JSON 坏了、少了必填项，都读成"没配过"。没有一种
 * 值得让页面加载失败。
 */
export async function readJiraConfig(): Promise<JiraConfig | null> {
  try {
    const data = (await Bun.file(jiraConfigPath()).json()) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const url = str(data?.url).replace(/\/+$/, ""); // 末尾斜杠会拼出 //rest/api
    const email = str(data?.email);
    const token = str(data?.token);
    if (!url || !email || !token) return null;
    return { url, email, token, jql: str(data?.jql) || DEFAULT_JQL };
  } catch {
    return null;
  }
}

/** 写入并收紧权限。0600 在写内容之前设，中间没有一刻是宽的。 */
export async function writeJiraConfig(config: JiraConfig): Promise<void> {
  const path = jiraConfigPath();
  await mkdir(pluginStateDir("jira"), { recursive: true });
  await writeFile(path, JSON.stringify({ ...config, jql: config.jql || DEFAULT_JQL }, null, 2), {
    mode: 0o600,
  });
  // writeFile 的 mode 只在新建时生效；已存在的文件要显式收。
  await chmod(path, 0o600);
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test plugins/jira/config.test.ts
```

预期：6 个测试全 PASS。

- [ ] **Step 5: 写失败的客户端测试**

创建 `plugins/jira/client.test.ts`：

```ts
import { test, expect } from "bun:test";
import { fetchIssues } from "./client";
import type { JiraConfig } from "./config";

/**
 * Jira 客户端。一次真实请求都不发——fetcher 是注进来的。
 *
 * 这里最要紧的两条不是"能解析成功响应"，而是：401 不能被当成"没有单"，以及
 * Jira 的原始错误体不能被原样吐给浏览器（里面带账号信息）。
 */

const CONFIG: JiraConfig = {
  url: "https://example.atlassian.net",
  email: "dev@example.com",
  token: "secret-token",
  jql: "assignee = currentUser()",
};

function fakeFetch(status: number, body: unknown, capture?: (req: Request) => void) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    capture?.(new Request(input as string, init));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

const OK_BODY = {
  issues: [
    {
      key: "EXAMPLE-1",
      fields: {
        summary: "登录页在窄屏下换行",
        updated: "2026-08-30T10:00:00.000+0000",
        status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      },
    },
  ],
};

test("成功时把响应裁成渲染要用的形状", async () => {
  const res = await fetchIssues(CONFIG, fakeFetch(200, OK_BODY));
  expect(res).toEqual({
    ok: true,
    issues: [
      {
        key: "EXAMPLE-1",
        summary: "登录页在窄屏下换行",
        status: "In Progress",
        statusCategory: "indeterminate",
        updated: Date.parse("2026-08-30T10:00:00.000+0000"),
      },
    ],
  });
});

test("认证走 Basic，JQL 来自配置", async () => {
  let seen: Request | undefined;
  await fetchIssues(CONFIG, fakeFetch(200, OK_BODY, (r) => (seen = r)));
  expect(seen?.url).toStartWith("https://example.atlassian.net/rest/api/3/search");
  expect(seen?.headers.get("authorization")).toBe(
    "Basic " + btoa("dev@example.com:secret-token"),
  );
  expect(decodeURIComponent(seen?.url ?? "")).toContain("assignee = currentUser()");
});

test("401 和 403 报凭据无效，不是空列表", async () => {
  // 把认证失败显示成"你没有单"，会让人以为 Jira 上真的没单了。
  for (const status of [401, 403]) {
    const res = await fetchIssues(CONFIG, fakeFetch(status, { errorMessages: ["x"] }));
    expect({ status, res }).toEqual({ status, res: { ok: false, reason: "auth" } });
  }
});

test("其余 4xx 报查询有误", async () => {
  const res = await fetchIssues(CONFIG, fakeFetch(400, { errorMessages: ["bad jql"] }));
  expect(res).toEqual({ ok: false, reason: "query" });
});

test("5xx 与网络故障报连不上", async () => {
  expect(await fetchIssues(CONFIG, fakeFetch(503, "gateway"))).toEqual({
    ok: false,
    reason: "unreachable",
  });
  const throwing = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  expect(await fetchIssues(CONFIG, throwing)).toEqual({ ok: false, reason: "unreachable" });
});

test("畸形 JSON 不炸，报连不上", async () => {
  expect(await fetchIssues(CONFIG, fakeFetch(200, "{ not json"))).toEqual({
    ok: false,
    reason: "unreachable",
  });
});

test("缺字段的 issue 被跳过，而不是渲染出一行空白", async () => {
  const res = await fetchIssues(
    CONFIG,
    fakeFetch(200, { issues: [{ fields: { summary: "无 key" } }, OK_BODY.issues[0]] }),
  );
  expect(res.ok && res.issues.map((i) => i.key)).toEqual(["EXAMPLE-1"]);
});

test("失败结果里不含 Jira 的原始错误体", async () => {
  // 那里面会带账号信息，不能原样进浏览器。
  const res = await fetchIssues(
    CONFIG,
    fakeFetch(400, { errorMessages: ["account dev@example.com lacks permission"] }),
  );
  expect(JSON.stringify(res)).not.toContain("lacks permission");
  expect(JSON.stringify(res)).not.toContain("@example.com");
});
```

- [ ] **Step 6: 跑测试确认失败**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test plugins/jira/client.test.ts
```

预期：FAIL，`Cannot find module './client'`。

- [ ] **Step 7: 写客户端**

创建 `plugins/jira/client.ts`：

```ts
import type { JiraConfig } from "./config";

/**
 * Jira Cloud 的搜索接口，裁到渲染要用的那几个字段。
 *
 * fetcher 是参数而不是直接用全局 fetch，好让整套测试一次真实请求都不发——这个
 * 仓库的测试跑得很勤，对着别人的 Jira 打是不可接受的。
 *
 * 失败一律归类再返回。Jira 的错误体里带账号信息，原样透传给浏览器就是把它送出
 * 门；而对调用方来说，"凭据不对"和"查询写错了"是两种完全不同的补救动作，比一段
 * 原始英文有用得多。
 */

export type Issue = {
  key: string;
  summary: string;
  status: string;
  statusCategory: string;
  updated: number;
};

export type IssuesResult =
  | { ok: true; issues: Issue[] }
  | { ok: false; reason: "unconfigured" | "auth" | "query" | "unreachable" };

/** Jira 挂了不能把页面吊死。 */
const TIMEOUT_MS = 8000;

const FIELDS = "summary,status,updated";

export async function fetchIssues(
  config: JiraConfig,
  fetcher: typeof fetch = fetch,
): Promise<IssuesResult> {
  // JQL 只来自配置，永不来自请求：否则这个无认证服务就是个任人查询的 Jira 代理。
  const query = new URLSearchParams({ jql: config.jql, fields: FIELDS, maxResults: "50" });
  const auth = "Basic " + btoa(`${config.email}:${config.token}`);

  let res: Response;
  try {
    res = await fetcher(`${config.url}/rest/api/3/search?${query}`, {
      headers: { authorization: auth, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // 超时、DNS、连接被拒——对用户都是同一件事：现在拿不到。
    return { ok: false, reason: "unreachable" };
  }

  if (res.status === 401 || res.status === 403) return { ok: false, reason: "auth" };
  if (res.status >= 500) return { ok: false, reason: "unreachable" };
  if (!res.ok) return { ok: false, reason: "query" };

  let data: { issues?: unknown };
  try {
    data = (await res.json()) as { issues?: unknown };
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  const rows = Array.isArray(data?.issues) ? data.issues : [];
  const issues: Issue[] = [];
  for (const row of rows) {
    const r = row as { key?: unknown; fields?: Record<string, any> };
    // key 缺了就没法绑定也没法跳转，渲染出来只会是一行空白。
    if (typeof r?.key !== "string" || !r.key) continue;
    const f = r.fields ?? {};
    issues.push({
      key: r.key,
      summary: typeof f.summary === "string" ? f.summary : "",
      status: typeof f.status?.name === "string" ? f.status.name : "",
      statusCategory:
        typeof f.status?.statusCategory?.key === "string" ? f.status.statusCategory.key : "",
      updated: Date.parse(typeof f.updated === "string" ? f.updated : "") || 0,
    });
  }
  return { ok: true, issues };
}
```

- [ ] **Step 8: 跑测试确认通过**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test plugins/jira/client.test.ts
```

预期：8 个测试全 PASS。

- [ ] **Step 9: 加夹具卫生测试**

创建 `plugins/jira/fixtures.test.ts`：

```ts
import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

/**
 * 这个仓库是公开的，历史被清洗过一次——工单号、公司名、主机名、真实路径都被从
 * 全历史里拿掉过。一个对着真实 Jira 写的夹具会把它们又带回来。
 *
 * 规则是**正向**的：出现的域名只允许 example.*。写黑名单等于把要防的那些词写进
 * 公开仓库，正好犯了要防的事。
 */
const dir = new URL("./", import.meta.url).pathname;

const files = readdirSync(dir).filter((f) => /\.(ts|js|html)$/.test(f));

test("插件目录里有文件可查", () => {
  expect(files.length).toBeGreaterThan(0);
});

test.each(files)("%s 里出现的域名只有 example.*", (file) => {
  const source = readFileSync(dir + file, "utf8");
  const hosts = [...source.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]!);
  const foreign = hosts.filter(
    (h) => !/(^|\.)example\.(com|net|org)$/.test(h) && !/(^|\.)example\.atlassian\.net$/.test(h),
  );
  expect({ file, foreign }).toEqual({ file, foreign: [] });
});

test.each(files)("%s 里没有邮箱地址，除非是 example 域", (file) => {
  const source = readFileSync(dir + file, "utf8");
  const mails = [...source.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)].map(
    (m) => m[1]!,
  );
  expect({ file, mails: mails.filter((d) => !/(^|\.)example\.(com|net|org)$/.test(d)) })
    .toEqual({ file, mails: [] });
});
```

- [ ] **Step 10: 跑全量并提交**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run test
```

预期：只有已知的两条环境性失败。

```bash
git add plugins/jira/config.ts plugins/jira/config.test.ts \
        plugins/jira/client.ts plugins/jira/client.test.ts plugins/jira/fixtures.test.ts
git commit -m "feat: Jira 配置与客户端，凭据 0600、错误归类、fetcher 可注入"
```

---

### Task 2: 绑定存储与会话 id

**Files:**
- Create: `plugins/jira/sessions.ts`
- Create: `plugins/jira/bindings.ts`
- Create: `plugins/jira/bindings.test.ts`

**Interfaces:**
- Consumes: `pluginStateDir`（`plugins/state.ts`）、`tmux(argv: string[])`（`src/tmux/run.ts`，返回 `{ ok: boolean; stdout: string }`）
- Produces: `Binding = { key: string; sessionId: string; boundAt: number }`
- Produces: `readBindings(): Promise<Record<string, Binding>>`、`bindSession(session: string, key: string, sessionId: string): Promise<void>`、`unbindSession(session: string): Promise<void>`、`resolveBindings(live: LiveSession[]): Promise<ResolvedBinding[]>`
- Produces: `LiveSession = { id: string; name: string }`、`liveSessions(): Promise<LiveSession[]>`
- Produces: `ResolvedBinding = { session: string; key: string; live: boolean }`

- [ ] **Step 1: 写失败的测试**

创建 `plugins/jira/bindings.test.ts`：

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBindings, bindSession, unbindSession, resolveBindings } from "./bindings";

/**
 * 绑定按**会话**作键，因为一个单可以有多个会话——这是整个设计的轴心，反过来存
 * （工单 → 会话数组）每次会话改名或消亡都要去数组里翻。
 *
 * 名字和会话 id 都存，是为了改名：#{session_id} 跨改名不变、跨 tmux server 重启
 * 会重排；名字反过来。两个都存，各覆盖一半，就不必给插件接缝再开一个"会话改名
 * 事件"的口子。
 */

let root: string;
let saved: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jira-bind-"));
  saved = process.env.TMUX_NEXT_JIRA_DIR;
  process.env.TMUX_NEXT_JIRA_DIR = root;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.TMUX_NEXT_JIRA_DIR;
  else process.env.TMUX_NEXT_JIRA_DIR = saved;
  await rm(root, { recursive: true, force: true });
});

test("没有文件时读出空表", async () => {
  expect(await readBindings()).toEqual({});
});

test("坏 JSON 读成空表，不抛", async () => {
  await writeFile(join(root, "bindings.json"), "{ not json");
  expect(await readBindings()).toEqual({});
});

test("绑定写得进读得回", async () => {
  await bindSession("修登录页", "EXAMPLE-1", "$7");
  const all = await readBindings();
  expect(all["修登录页"]?.key).toBe("EXAMPLE-1");
  expect(all["修登录页"]?.sessionId).toBe("$7");
  expect(typeof all["修登录页"]?.boundAt).toBe("number");
});

test("一个单可以挂多个会话", async () => {
  // 设计的轴心。会话名唯一而工单不唯一，所以这必须成立。
  await bindSession("改代码", "EXAMPLE-1", "$7");
  await bindSession("跑测试", "EXAMPLE-1", "$8");
  const all = await readBindings();
  expect(Object.keys(all).sort()).toEqual(["改代码", "跑测试"]);
  expect([all["改代码"]?.key, all["跑测试"]?.key]).toEqual(["EXAMPLE-1", "EXAMPLE-1"]);
});

test("解绑只拿掉那一个", async () => {
  await bindSession("改代码", "EXAMPLE-1", "$7");
  await bindSession("跑测试", "EXAMPLE-1", "$8");
  await unbindSession("改代码");
  expect(Object.keys(await readBindings())).toEqual(["跑测试"]);
});

test("会话改名后按 id 认回来，并把名字改正", async () => {
  await bindSession("旧名字", "EXAMPLE-1", "$7");
  const resolved = await resolveBindings([{ id: "$7", name: "新名字" }]);
  expect(resolved).toEqual([{ session: "新名字", key: "EXAMPLE-1", live: true }]);
  // 认回来之后要把记录迁过去，否则每次都要重认一遍。
  expect(Object.keys(await readBindings())).toEqual(["新名字"]);
});

test("tmux 重启后 id 变了，按名字认回来", async () => {
  await bindSession("修登录页", "EXAMPLE-1", "$7");
  const resolved = await resolveBindings([{ id: "$3", name: "修登录页" }]);
  expect(resolved).toEqual([{ session: "修登录页", key: "EXAMPLE-1", live: true }]);
});

test("会话没了的绑定留着，标成不在跑", async () => {
  // 这个仓库有会话恢复机制，指向已死会话的绑定恰好是"这个单之前开过，要不要恢复"。
  // 自动删会把那个入口一起删掉。
  await bindSession("修登录页", "EXAMPLE-1", "$7");
  const resolved = await resolveBindings([]);
  expect(resolved).toEqual([{ session: "修登录页", key: "EXAMPLE-1", live: false }]);
  expect(Object.keys(await readBindings())).toEqual(["修登录页"]);
});

test("并发写不会丢记录", async () => {
  await Promise.all([
    bindSession("a", "EXAMPLE-1", "$1"),
    bindSession("b", "EXAMPLE-2", "$2"),
    bindSession("c", "EXAMPLE-3", "$3"),
  ]);
  expect(Object.keys(await readBindings()).sort()).toEqual(["a", "b", "c"]);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test plugins/jira/bindings.test.ts
```

预期：FAIL，`Cannot find module './bindings'`。

- [ ] **Step 3: 写会话查询**

创建 `plugins/jira/sessions.ts`：

```ts
import { tmux } from "../../src/tmux/run";

/**
 * 活着的会话，连同它们的 tmux 内部 id。
 *
 * 内核的会话列表不查 #{session_id}（src/tmux/session-list.ts 的格式串里没有），
 * 所以这里自己问一次。走内核的 tmux(argv) 是插件依赖内核，方向正确——**不要**
 * 为此往内核的列表里加字段，那是内核为一个插件的需要长出概念。
 *
 * 分隔符用 | 与内核一致；session_id 形如 $7，不含分隔符，所以放在前面，把可能
 * 含 | 的名字留给贪婪的尾部。
 */

export type LiveSession = { id: string; name: string };

export async function liveSessions(): Promise<LiveSession[]> {
  const listed = await tmux(["list-sessions", "-F", "#{session_id}|#{session_name}"]);
  if (!listed.ok) return [];
  return listed.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((row) => {
      const cut = row.indexOf("|");
      return { id: row.slice(0, cut), name: row.slice(cut + 1) };
    })
    .filter((s) => s.id && s.name);
}
```

- [ ] **Step 4: 写绑定存储**

创建 `plugins/jira/bindings.ts`：

```ts
import { join } from "node:path";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { pluginStateDir } from "../state";
import type { LiveSession } from "./sessions";

/**
 * 工单与会话的绑定。
 *
 * 按会话作键，因为一个单可以有多个会话——会话名唯一，工单不唯一。反过来存每次
 * 会话改名或消亡都要去数组里翻。
 *
 * 名字与 id 都存：#{session_id} 跨改名不变、跨 tmux server 重启会重排；名字反
 * 过来。先按 id 认、认不上按名字认，两者各覆盖一半，于是插件接缝不必长出一个
 * "会话改名事件"。
 */

export type Binding = { key: string; sessionId: string; boundAt: number };
export type ResolvedBinding = { session: string; key: string; live: boolean };

function bindingsPath(): string {
  return join(pluginStateDir("jira"), "bindings.json");
}

/** 全函数：没有文件、坏 JSON、形状不对，都读成空表。 */
export async function readBindings(): Promise<Record<string, Binding>> {
  try {
    const data = (await Bun.file(bindingsPath()).json()) as Record<string, unknown>;
    const out: Record<string, Binding> = {};
    for (const [session, value] of Object.entries(data ?? {})) {
      const v = value as Record<string, unknown>;
      if (typeof v?.key !== "string" || !v.key) continue;
      out[session] = {
        key: v.key,
        sessionId: typeof v.sessionId === "string" ? v.sessionId : "",
        boundAt: typeof v.boundAt === "number" ? v.boundAt : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 写整张表：先写临时文件再 rename。
 *
 * rename 在同一文件系统内是原子的，所以并发的两次写不会把文件截成半截；后写的
 * 赢，而每次写的都是刚读回来的全表，所以丢的最多是一次并发里的一条，不是整张表。
 */
async function writeBindings(all: Record<string, Binding>): Promise<void> {
  const dir = pluginStateDir("jira");
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.bindings.${process.pid}.${Math.random().toString(36).slice(2)}`);
  await writeFile(tmp, JSON.stringify(all, null, 2));
  await rename(tmp, bindingsPath());
}

export async function bindSession(session: string, key: string, sessionId: string): Promise<void> {
  const all = await readBindings();
  all[session] = { key, sessionId, boundAt: Math.floor(Date.now() / 1000) };
  await writeBindings(all);
}

export async function unbindSession(session: string): Promise<void> {
  const all = await readBindings();
  delete all[session];
  await writeBindings(all);
}

/**
 * 绑定对上现在活着的会话。
 *
 * 认回顺序是 id 优先、名字兜底。按 id 认回来的会话若已改名，记录跟着迁到新名字
 * 下——否则每次都要重认一遍，而一次写就能让它安顿。
 *
 * 会话没了的绑定**不删**：这个仓库有会话恢复机制，一条指向已死会话的绑定恰好是
 * "这个单之前开过，要不要恢复"。自动删会把那个入口一起删掉。
 */
export async function resolveBindings(live: LiveSession[]): Promise<ResolvedBinding[]> {
  const all = await readBindings();
  const byId = new Map(live.filter((s) => s.id).map((s) => [s.id, s]));
  const names = new Set(live.map((s) => s.name));

  const out: ResolvedBinding[] = [];
  const renames: Array<[string, string]> = [];

  for (const [session, binding] of Object.entries(all)) {
    const byIdHit = binding.sessionId ? byId.get(binding.sessionId) : undefined;
    if (byIdHit) {
      if (byIdHit.name !== session) renames.push([session, byIdHit.name]);
      out.push({ session: byIdHit.name, key: binding.key, live: true });
      continue;
    }
    out.push({ session, key: binding.key, live: names.has(session) });
  }

  if (renames.length) {
    const next = await readBindings();
    for (const [from, to] of renames) {
      const moved = next[from];
      if (!moved) continue;
      delete next[from];
      next[to] = moved;
    }
    await writeBindings(next);
  }

  return out;
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test plugins/jira/bindings.test.ts
```

预期：9 个测试全 PASS。

- [ ] **Step 6: 跑全量并提交**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run test
```

```bash
git add plugins/jira/sessions.ts plugins/jira/bindings.ts plugins/jira/bindings.test.ts
git commit -m "feat: 工单与会话的绑定，按会话作键、名字与 id 双认"
```

---

### Task 3: 接缝新增只读标注能力（内核侧）

这是给插件接缝开的第一个新口子。当初按 YAGNI 砍掉"跨页面挂钩"是因为没有消费者；现在有了，而且不开就解决不了"会话列表乱"。**口子的边界写死：只读、只回展示数据、硬超时、出错即忽略。**

**Files:**
- Modify: `plugins/types.ts`
- Modify: `plugins/handlers.ts`
- Modify: `src/server.ts`（`/api/sessions` GET）
- Create: `src/plugin-annotate.test.ts`

**Interfaces:**
- Consumes: `enabledPlugins()`（`plugins/handlers.ts`，已存在）
- Produces: `Annotation = { text: string; detail?: string; tone?: "ok" | "warn" | "dim" }`
- Produces: `PluginAnnotator = (sessions: string[]) => Promise<Record<string, Annotation>>`
- Produces: `collectAnnotations(sessions: string[], annotators?: Record<string, PluginAnnotator>): Promise<Record<string, Record<string, Annotation>>>`（外层键是插件 id）

- [ ] **Step 1: 写失败的测试**

创建 `src/plugin-annotate.test.ts`：

```ts
import { test, expect } from "bun:test";
import { collectAnnotations, ANNOTATE_TIMEOUT_MS } from "../plugins/handlers";
import type { PluginAnnotator } from "../plugins/types";

/**
 * 会话列表是内核的页面，插件只能往上贴一小段只读的展示数据。
 *
 * 这里检的不是"标注能贴上"，而是**贴不上的时候列表照常出**：一个抛异常的插件、
 * 一个永远不返回的插件，都不许把内核页面拖下水。这是开这个口子唯一的安全阀。
 */

const SESSIONS = ["修登录页", "跑测试"];

test("正常的插件把标注贴上，按插件 id 分组", async () => {
  const good: PluginAnnotator = async (sessions) =>
    Object.fromEntries(sessions.map((s) => [s, { text: "EXAMPLE-1" }]));
  expect(await collectAnnotations(SESSIONS, { jira: good })).toEqual({
    jira: { 修登录页: { text: "EXAMPLE-1" }, 跑测试: { text: "EXAMPLE-1" } },
  });
});

test("抛异常的插件被忽略，别的插件照常", async () => {
  const boom: PluginAnnotator = async () => {
    throw new Error("插件炸了");
  };
  const good: PluginAnnotator = async () => ({ 修登录页: { text: "OK" } });
  const out = await collectAnnotations(SESSIONS, { bad: boom, good });
  expect(out.bad).toBeUndefined();
  expect(out.good).toEqual({ 修登录页: { text: "OK" } });
});

test("超时的插件被放弃，不拖住列表", async () => {
  const slow: PluginAnnotator = () => new Promise(() => {});
  const started = Date.now();
  const out = await collectAnnotations(SESSIONS, { slow });
  expect(out.slow).toBeUndefined();
  // 上限留一倍余量：断言的是"确实被截断了"，不是精确耗时。
  expect(Date.now() - started).toBeLessThan(ANNOTATE_TIMEOUT_MS * 2);
});

test("返回非对象的插件被忽略", async () => {
  const junk = (async () => "不是对象") as unknown as PluginAnnotator;
  expect(await collectAnnotations(SESSIONS, { junk })).toEqual({});
});

test("标注文本超长会被截断，不许撑破列表", async () => {
  const chatty: PluginAnnotator = async () => ({ 修登录页: { text: "x".repeat(500) } });
  const out = await collectAnnotations(SESSIONS, { chatty });
  expect(out.chatty?.["修登录页"]?.text.length).toBeLessThanOrEqual(120);
});

test("没有插件时是空对象，不是 undefined", async () => {
  expect(await collectAnnotations(SESSIONS, {})).toEqual({});
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test src/plugin-annotate.test.ts
```

预期：FAIL，`collectAnnotations` 不存在。

- [ ] **Step 3: 加类型**

`plugins/types.ts` 末尾追加：

```ts
/**
 * 插件贴在会话列表某一行上的一小段只读展示数据。
 *
 * 只读、只展示：插件不能改列表行为、不能加动作、不能排序。这条边界是这个口子
 * 得以存在的前提——当初砍掉"跨页面挂钩"是因为没有消费者，现在有了，但能力面
 * 仍然按需要开，不按能想到的开。
 */
export type Annotation = { text: string; detail?: string; tone?: "ok" | "warn" | "dim" };

/**
 * 插件可选导出的标注函数。拿到的是会话名，返回会话名到标注的映射；不认识的会话
 * 不必出现在返回值里。
 */
export type PluginAnnotator = (sessions: string[]) => Promise<Record<string, Annotation>>;
```

- [ ] **Step 4: 在 handlers.ts 里收集标注**

`plugins/handlers.ts`：import 处加 `Annotation, PluginAnnotator` 类型，并在文件末尾追加：

```ts
/** 插件的标注函数表。没有导出 annotate 的插件不出现在这里。 */
export const ANNOTATORS: Record<string, PluginAnnotator> = {};

/** 一个插件最多能占用列表构建的多少时间。 */
export const ANNOTATE_TIMEOUT_MS = 300;

/** 一条标注文本的上限，够放一个单号加一句标题，不够撑破一行。 */
const MAX_TEXT = 120;

function trim(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * 向每个有标注函数的插件要一次标注。
 *
 * 失败语义只有一种：**拿不到就当没有**。插件抛了、超时了、返回了不是对象的东西，
 * 都只是这个插件这一轮没有标注，会话列表照常渲染。内核的页面不能因为一个插件而
 * 出不来——这是开这个口子的唯一安全阀，也是它可以被接受的原因。
 *
 * annotators 是参数而不是直接用 ANNOTATORS，好让内核侧的测试能塞进一个会抛、一个
 * 会卡住的假插件——注册表是编译期写死的，没有这个参数就没法测这条安全阀。
 */
export async function collectAnnotations(
  sessions: string[],
  annotators: Record<string, PluginAnnotator> = ANNOTATORS,
): Promise<Record<string, Record<string, Annotation>>> {
  const enabled = new Set(enabledPlugins().map((p) => p.id));
  const entries = Object.entries(annotators).filter(
    ([id]) => enabled.size === 0 || enabled.has(id) || !PLUGINS.some((p) => p.id === id),
  );

  const results = await Promise.all(
    entries.map(async ([id, annotate]) => {
      try {
        const timeout = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), ANNOTATE_TIMEOUT_MS),
        );
        const got = await Promise.race([annotate(sessions), timeout]);
        if (!got || typeof got !== "object" || Array.isArray(got)) return null;
        const clean: Record<string, Annotation> = {};
        for (const [session, raw] of Object.entries(got)) {
          const a = raw as Record<string, unknown>;
          const text = trim(a?.text, MAX_TEXT);
          if (!text) continue;
          const detail = trim(a?.detail, MAX_TEXT);
          const tone = a?.tone === "ok" || a?.tone === "warn" || a?.tone === "dim" ? a.tone : undefined;
          clean[session] = { text, ...(detail ? { detail } : {}), ...(tone ? { tone } : {}) };
        }
        return [id, clean] as const;
      } catch {
        return null;
      }
    }),
  );

  return Object.fromEntries(results.filter(Boolean) as Array<readonly [string, Record<string, Annotation>]>);
}
```

**注意**：上面用到 `PLUGINS`，`handlers.ts` 顶部已经 import 了它。测试里传进来的假插件 id（`good` / `slow`）不在 `PLUGINS` 里，所以那个 filter 的第三个分支放它们过；真实插件则按启用状态过滤。

- [ ] **Step 5: 跑测试确认通过**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test src/plugin-annotate.test.ts
```

预期：6 个测试全 PASS。

- [ ] **Step 6: 会话列表带上标注**

`src/server.ts`，把 `/api/sessions` 的 GET 分支改成：

```ts
      if (url.pathname === "/api/sessions" && req.method === "GET") {
        const sessions = await listSessions();
        // 插件贴的只读标注。拿不到就没有，列表照常出——失败语义只有这一种。
        const annotations = await collectAnnotations(sessions.map((s) => s.name));
        return Response.json({ sessions, annotations });
      }
```

并在 import 处把 `collectAnnotations` 加进 `../plugins/handlers` 那一行。

**这会改变响应形状**（从数组变成 `{ sessions, annotations }`），`public/list.js` 在 Task 6 跟上。同一任务内两处一起改会让本任务的评审面变大，所以这里先只改服务端，并在下一步用测试钉住新形状。

- [ ] **Step 7: 钉住新响应形状**

`src/server.test.ts` 末尾追加：

```ts
test("会话列表带上插件标注这一格，即使没有插件标注任何东西", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { sessions: unknown; annotations: unknown };
  expect(Array.isArray(body.sessions)).toBe(true);
  // 形状永远在，前端就不必到处判 undefined。
  expect(typeof body.annotations).toBe("object");
  expect(body.annotations).not.toBeNull();
});
```

`src/server.test.ts` 里已有的会话列表断言若假设响应是数组，改成读 `body.sessions`——**只改取值路径，不改断言内容**。

- [ ] **Step 8: 跑全量并提交**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run test
```

`public/list.js` 此时还在读旧形状，页面会暂时列不出会话——下一个任务修。这是本计划里唯一一处跨任务的中间态，接受它是为了让两个评审面各自清楚。

```bash
git add plugins/types.ts plugins/handlers.ts src/server.ts src/plugin-annotate.test.ts src/server.test.ts
git commit -m "feat: 插件可以给会话行贴只读标注，超时或出错即忽略"
```

---

### Task 4: list.js 泛型渲染标注

**Files:**
- Modify: `public/list.js`
- Modify: `public/style.css`
- Create: `src/list-annotations.test.ts`

**Interfaces:**
- Consumes: `GET /api/sessions` 现在返回 `{ sessions, annotations }`（Task 3）

- [ ] **Step 1: 写失败的测试**

创建 `src/list-annotations.test.ts`，仿 `src/list-page.test.ts` 的 happy-dom 路子（**先读那个文件**，照抄它的 mount/teardown 结构，包括它如何还原被替换的全局量）：

```ts
import { test, expect, afterEach } from "bun:test";
import { Window } from "happy-dom";

/**
 * 会话列表渲染插件贴上来的标注。
 *
 * 两件事必须成立：list.js **不认识 "jira" 这个词**（认识了，接缝就白划了），
 * 以及标注文本永远走 textContent —— 插件不能往内核的列表里塞标记。
 */

const saved = { fetch: globalThis.fetch };
afterEach(() => {
  // 覆盖全局却不还原，曾经一次弄红了别的文件里 38 个测试——Bun 一个进程跑全部。
  globalThis.fetch = saved.fetch;
});

// mount(sessions, annotations) 的具体实现照抄 src/list-page.test.ts 里的写法：
// 建一个 happy-dom Window、装上 document/window、把 fetch 换成返回下面这个 body 的
// 假的，然后 import public/list.js，等它渲染完再断言。
// 结束时按那个文件的方式把 window/document/fetch 都还原。

test("有标注的行显示标注文本", async () => {
  const doc = await mount(
    [session({ name: "修登录页" })],
    { jira: { 修登录页: { text: "EXAMPLE-1", detail: "登录页在窄屏下换行" } } },
  );
  const row = doc.querySelector(".session");
  expect(row?.textContent).toContain("EXAMPLE-1");
});

test("没有标注的行照常渲染", async () => {
  const doc = await mount([session({ name: "随便一个会话" })], {});
  expect(doc.querySelectorAll(".session").length).toBe(1);
});

test("annotations 整个缺失也不炸", async () => {
  // 插件全被禁用、或者服务端旧版本，都会走到这里。
  const doc = await mount([session({ name: "随便一个会话" })], undefined);
  expect(doc.querySelectorAll(".session").length).toBe(1);
});

test("标注里的标记被当成文字，不被解释", async () => {
  const doc = await mount(
    [session({ name: "修登录页" })],
    { jira: { 修登录页: { text: "<img src=x onerror=alert(1)>" } } },
  );
  expect(doc.querySelector(".session")?.innerHTML).not.toContain("<img");
  expect(doc.querySelector(".session")?.textContent).toContain("<img");
});

test("list.js 的源码里不出现任何具体插件的 id", async () => {
  // 内核不认识具体插件——这是接缝的方向，值得由测试守着而不是靠自觉。
  const source = await Bun.file(new URL("../public/list.js", import.meta.url).pathname).text();
  expect(source).not.toContain("jira");
  expect(source).not.toContain("gallery");
});
```

**注意**：`session()` 工厂照抄 `src/list-page.test.ts` 里那个（它构造一整条 `SessionSummary`），不要重写一份。

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test src/list-annotations.test.ts
```

预期：FAIL——`list.js` 还在读旧的数组形状，也没有渲染标注。

- [ ] **Step 3: 改 list.js**

先读 `public/list.js` 里取数据那一段与渲染一行那一段。做两处改动：

1. 取数据：`const { sessions, annotations } = await res.json()`，并对旧形状留一手——`Array.isArray(body) ? { sessions: body, annotations: {} } : body`，`annotations` 缺失时当 `{}`。
2. 渲染一行时，把所有插件在这个会话上的标注拼出来。**按插件 id 遍历，不写死任何 id**：

```js
/**
 * 插件贴在这一行上的标注。
 *
 * 遍历插件 id，不认识其中任何一个——认识了，接缝就白划了：内核只知道"有插件想
 * 在这行上说句话"，不知道说的是工单还是别的什么。
 *
 * 一律 textContent：标注来自插件，插件不该能往内核的列表里塞标记。
 */
function renderAnnotations(row, name, annotations) {
  const notes = [];
  for (const bySession of Object.values(annotations ?? {})) {
    const note = bySession?.[name];
    if (note?.text) notes.push(note);
  }
  if (!notes.length) return;
  const wrap = el("div", "session-notes");
  for (const note of notes) {
    const chip = el("span", `note note-${note.tone ?? "dim"}`);
    chip.textContent = note.text;
    if (note.detail) chip.title = note.detail;
    wrap.append(chip);
  }
  row.append(wrap);
}
```

在构建每一行的地方调用它。`el()` 是 `list.js` 里已有的助手——**先确认它的签名**再用。

- [ ] **Step 4: 加样式**

`public/style.css` 里，紧挨会话行的样式之后加：

```css
/* 插件贴在会话行上的标注。颜色全部取自主题变量，这个文件不该出现颜色字面量。 */
.session-notes { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.note {
  font-size: 12px;
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--card);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.note-ok { color: var(--idle); }
.note-warn { color: var(--term-red); }
.note-dim { color: var(--dim); }
```

- [ ] **Step 5: 跑测试确认通过**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test src/list-annotations.test.ts src/list-page.test.ts
```

预期：全 PASS。`list-page.test.ts` 也必须绿——它是这个页面原有的渲染测试，红了说明取数据那处改动碰坏了别的。

- [ ] **Step 6: 跑全量并提交**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run test
```

```bash
git add public/list.js public/style.css src/list-annotations.test.ts
git commit -m "feat: 会话列表渲染插件标注，内核不认识任何具体插件"
```

---

### Task 5: jira 插件的清单与服务端

**Files:**
- Create: `plugins/jira/plugin.js`
- Create: `plugins/jira/server.ts`
- Modify: `plugins/registry.js`
- Modify: `plugins/handlers.ts`
- Modify: `src/plugin-routing.test.ts`

**Interfaces:**
- Consumes: `readJiraConfig`、`DEFAULT_JQL`（Task 1）；`fetchIssues`、`Issue`、`IssuesResult`（Task 1）；`readBindings`、`bindSession`、`unbindSession`、`resolveBindings`（Task 2）；`liveSessions`（Task 2）；`Annotation`、`PluginAnnotator`（Task 3）
- Produces: `handle`（`PluginHandler`）与 `annotate`（`PluginAnnotator`），以及注册表里的第三条

- [ ] **Step 1: 写清单**

创建 `plugins/jira/plugin.js`。图标用一个"标签/工单"的形状，格式与其他清单一致（24×24 viewBox 里的 path 串）：

```js
// @ts-check
/**
 * Jira 工单插件的清单。纯数据——服务端在 plugins/jira/server.ts。
 *
 * 浏览器会 import 这个文件（i18n.js 合并字典、nav.js 画 tab），所以这里不能引
 * 任何 .ts。
 */

/** @type {import("../types").Plugin} */
export default {
  id: "jira",
  titleKey: "jira.title",
  icon:
    '<path d="M4 7a2 2 0 0 1 2-2h6l8 8-7 7-8-8V7z"/>' +
    '<circle cx="8.5" cy="9.5" r="1.5"/>',
  i18n: {
    zh: {
      "jira.title": "工单",
      "jira.count": "{n} 个",
      "jira.loading": "加载中…",
      "jira.empty": "没有分给你的单",
      "jira.unconfigured": "还没配置 Jira",
      "jira.unconfiguredHint": "把 URL、邮箱、API token 写进 ~/.tmux-next/jira/config.json（权限 0600）",
      "jira.authFailed": "凭据无效，请检查邮箱与 API token",
      "jira.queryFailed": "查询有误，请检查 config.json 里的 jql",
      "jira.unreachable": "连不上 Jira",
      "jira.refresh": "刷新",
      "jira.newSession": "再开一个会话",
      "jira.firstSession": "开一个会话",
      "jira.sessions": "{n} 个会话",
      "jira.noSessions": "还没有会话",
      "jira.dead": "已停止，可恢复",
      "jira.unbind": "解除绑定",
      "jira.open": "进入",
      "jira.createFailed": "创建失败",
      "jira.nameTaken": "名字已被占用，换一个",
    },
    en: {
      "jira.title": "Issues",
      "jira.count": "{n}",
      "jira.loading": "Loading…",
      "jira.empty": "No issues assigned to you",
      "jira.unconfigured": "Jira is not configured",
      "jira.unconfiguredHint": "Put the URL, e-mail and API token in ~/.tmux-next/jira/config.json (mode 0600)",
      "jira.authFailed": "Invalid credentials — check the e-mail and API token",
      "jira.queryFailed": "Bad query — check `jql` in config.json",
      "jira.unreachable": "Cannot reach Jira",
      "jira.refresh": "Refresh",
      "jira.newSession": "New session",
      "jira.firstSession": "Start a session",
      "jira.sessions": "{n} sessions",
      "jira.noSessions": "No sessions yet",
      "jira.dead": "Stopped — restorable",
      "jira.unbind": "Unbind",
      "jira.open": "Open",
      "jira.createFailed": "Could not create",
      "jira.nameTaken": "That name is taken — pick another",
    },
  },
};
```

- [ ] **Step 2: 写失败的路由测试**

`src/plugin-routing.test.ts` 末尾追加（该文件已经有一个跑起来的 server 和 `base()`）：

```ts
test("jira 插件挂在自己的前缀下，未配置时如实说未配置", async () => {
  const ids = (await (await fetch(`${base()}/api/plugins`)).json()) as string[];
  expect(ids).toContain("jira");

  // 这个测试进程没有 config.json（TMUX_NEXT_JIRA_DIR 指向临时目录），
  // 所以这里检的是"没配置"这条路径，而不是去打真实的 Jira。
  const cfg = await (await fetch(`${base()}/api/jira/config`)).json();
  expect(cfg).toEqual({ configured: false });

  const issues = await fetch(`${base()}/api/jira/issues`);
  expect(issues.status).toBe(200);
  expect(await issues.json()).toEqual({ ok: false, reason: "unconfigured" });
});

test("配置接口从不回显 token", async () => {
  const text = await (await fetch(`${base()}/api/jira/config`)).text();
  expect(text).not.toContain("token");
});

test("插件不认识的子路径落到 404", async () => {
  expect((await fetch(`${base()}/api/jira/nonesuch`)).status).toBe(404);
});
```

并在该文件顶部、其他 env 覆盖旁边加上：

```ts
process.env.TMUX_NEXT_JIRA_DIR = join(
  tmpdir(),
  `jira-test-${Math.random().toString(36).slice(2, 10)}`,
);
```

- [ ] **Step 3: 跑测试确认失败**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test src/plugin-routing.test.ts
```

预期：新加的三个 FAIL（`jira` 不在插件列表里）。

- [ ] **Step 4: 写服务端**

创建 `plugins/jira/server.ts`：

```ts
import { readJiraConfig } from "./config";
import { fetchIssues, type Issue, type IssuesResult } from "./client";
import { liveSessions } from "./sessions";
import { readBindings, bindSession, unbindSession, resolveBindings } from "./bindings";
import type { Annotation } from "../types";

/**
 * 工单插件的服务端。
 *
 * 浏览器永不直连 Jira：token 会漏，CORS 也不通。所有对外请求都从这里出去，而
 * **JQL 只来自 config.json**——接受浏览器传来的 JQL，就等于把这个无认证的服务
 * 变成一个任人查询的 Jira 代理。
 */

/** 拉一次要几秒，而列表页会被反复打开；60 秒足够挡住连点，又不至于让人觉得刷不动。 */
const CACHE_MS = 60_000;

let cache: { at: number; result: IssuesResult } | null = null;

async function issues(refresh: boolean): Promise<IssuesResult> {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache.result;
  const config = await readJiraConfig();
  if (!config) return { ok: false, reason: "unconfigured" };
  const result = await fetchIssues(config);
  // 只缓存成功：一次网络抖动不该让人盯着错误看满一分钟。
  if (result.ok) cache = { at: Date.now(), result };
  return result;
}

/** 测试用：把缓存清掉。 */
export function clearIssuesCache(): void {
  cache = null;
}

export async function handle(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/jira/config" && req.method === "GET") {
    const config = await readJiraConfig();
    // token 从不出门。url 和 email 出门是为了页面能显示"连的是哪个实例"。
    return Response.json(
      config ? { configured: true, url: config.url, email: config.email } : { configured: false },
    );
  }

  if (url.pathname === "/api/jira/issues" && req.method === "GET") {
    return Response.json(await issues(url.searchParams.get("refresh") === "1"));
  }

  if (url.pathname === "/api/jira/bindings" && req.method === "GET") {
    return Response.json({ bindings: await resolveBindings(await liveSessions()) });
  }

  if (url.pathname === "/api/jira/bindings" && req.method === "POST") {
    let body: { session?: unknown; key?: unknown };
    try {
      body = await req.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }
    if (typeof body.session !== "string" || !body.session) {
      return new Response("bad session", { status: 400 });
    }
    if (typeof body.key !== "string" || !/^[A-Z][A-Z0-9]*-\d+$/.test(body.key)) {
      // 单号形状收窄：它会进文件名以外的地方展示，也会拼进 Jira 的 URL。
      return new Response("bad key", { status: 400 });
    }
    const live = await liveSessions();
    const found = live.find((s) => s.name === body.session);
    await bindSession(body.session, body.key, found?.id ?? "");
    return Response.json({ ok: true });
  }

  if (url.pathname === "/api/jira/bindings" && req.method === "DELETE") {
    const session = url.searchParams.get("session") ?? "";
    if (!session) return new Response("bad session", { status: 400 });
    await unbindSession(session);
    return Response.json({ ok: true });
  }

  return null;
}

/**
 * 会话列表上的标注：这个会话属于哪个单。
 *
 * 只读绑定文件，**不打 Jira**：这个函数在内核构建列表的路径上，有 300ms 的硬
 * 超时，一次网络往返根本来不及；而且列表页每次打开都会调它，拿它去打 Jira 等于
 * 把速率限制往枪口上撞。标题从已缓存的工单里取，取不到就只显示单号。
 */
export async function annotate(sessions: string[]): Promise<Record<string, Annotation>> {
  const bindings = await readBindings();
  const summaries = new Map<string, Issue>(
    cache?.result.ok ? cache.result.issues.map((i) => [i.key, i]) : [],
  );

  const out: Record<string, Annotation> = {};
  for (const session of sessions) {
    const binding = bindings[session];
    if (!binding) continue;
    const issue = summaries.get(binding.key);
    out[session] = {
      text: binding.key,
      ...(issue?.summary ? { detail: issue.summary } : {}),
      tone: issue?.statusCategory === "done" ? "dim" : "ok",
    };
  }
  return out;
}
```

- [ ] **Step 5: 挂进两张表**

`plugins/registry.js`：

```js
import gallery from "./gallery/plugin.js";
import notifications from "./notifications/plugin.js";
import jira from "./jira/plugin.js";

/** @type {import("./types").Plugin[]} */
export const PLUGINS = [gallery, notifications, jira];
```

`plugins/handlers.ts`：加 import 与两处表项——

```ts
import { handle as jira, annotate as jiraAnnotate } from "./jira/server";

export const HANDLERS: Record<string, PluginHandler> = { gallery, notifications, jira };

export const ANNOTATORS: Record<string, PluginAnnotator> = { jira: jiraAnnotate };
```

（Task 3 里 `ANNOTATORS` 是空对象，这里填上第一个真实的。）

- [ ] **Step 6: 跑测试确认通过**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test src/plugin-routing.test.ts plugins/registry.test.ts
```

预期：全 PASS。`registry.test.ts` 会顺带校验新清单的 id 合法、两本字典键集一致、以及 registry.js 的 import 图里仍然没有 `.ts`。

- [ ] **Step 7: 跑全量并提交**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run test
```

```bash
git add plugins/jira/plugin.js plugins/jira/server.ts plugins/registry.js plugins/handlers.ts src/plugin-routing.test.ts
git commit -m "feat: jira 插件的清单与服务端，工单只读代理加绑定接口"
```

---

### Task 6: 插件页面

**Files:**
- Create: `plugins/jira/public/index.html`
- Create: `plugins/jira/public/jira.js`

**Interfaces:**
- Consumes: `url()`（`public/root.js`）、`initLang` / `tr`（`public/i18n-apply.js`）、`renderHeader`（`public/nav.js`）、`filterEntries` / `shortPath`（`public/dir-filter.js`）
- Consumes: `GET /api/jira/config`、`GET /api/jira/issues`、`GET|POST|DELETE /api/jira/bindings`、`POST /api/sessions`、`GET /api/directories`

- [ ] **Step 1: 写页面骨架**

创建 `plugins/jira/public/index.html`，**照抄 `plugins/gallery/public/index.html` 的结构**（同样的 meta、manifest 的 `crossorigin="use-credentials"` 注释、`../../` 前缀的资源链接），只改 title 的 i18n 键、`<main>` 的 id 与脚本名：

```html
  <title data-i18n="jira.title">工单</title>
  …
<body class="list-page">
  <header id="header"></header>
  <main id="issues"><p class="empty" data-i18n="jira.loading">加载中…</p></main>
  <script type="module" src="jira.js"></script>
</body>
```

- [ ] **Step 2: 写页面脚本**

创建 `plugins/jira/public/jira.js`。**不加 `// @ts-check`**，并照抄 `plugins/gallery/public/gallery.js` 顶部那段说明为什么不加的注释（改成这个文件的路径）。

结构：

```js
import { initLang, tr } from "../../i18n-apply.js";
import { renderHeader } from "../../nav.js";
import { url } from "../../root.js";
import { filterEntries, shortPath } from "../../dir-filter.js";
```

要实现的行为，逐条：

1. `await initLang()`、`await renderHeader("jira")`，然后拉 `url("api/jira/config")`。`configured` 为假就渲染 `jira.unconfigured` + `jira.unconfiguredHint`，**到此为止**，不再拉工单。
2. 并行拉 `url("api/jira/issues")` 与 `url("api/jira/bindings")`。
3. `issues` 返回 `{ ok: false, reason }` 时，按 `reason` 映射到 `jira.authFailed` / `jira.queryFailed` / `jira.unreachable` / `jira.unconfigured` 四条文案之一。**不要**把 reason 直接显示出来。
4. 渲染：每个工单一组，显示 `key`、`summary`、`status`。组内列出 `bindings` 里 `key` 匹配的会话；`live` 为假的标 `jira.dead`。每个会话是一个链到 `url("terminal.html?target=" + encodeURIComponent(session))` 的行，旁边一个 `jira.unbind` 按钮（`DELETE api/jira/bindings?session=…`）。
5. 每组底部一个按钮：有会话时文案 `jira.newSession`，没有时 `jira.firstSession`。点它打开一个建会话的浮层。
6. 浮层里：目录选择（拉 `url("api/directories")`，用 `filterEntries` 过滤、`shortPath` 显示——**这两个是已经被测过的纯函数，不要自己写一份**）、会话名输入框（预填工单号，撞名再由服务端拒绝）、agent 选择（拉 `url("api/agents")` 如果存在；先读 `public/new.js` 确认它拉的是哪个接口，照同一个来）。
7. 提交时 `POST url("api/sessions")`，body `{ dir, name, agent, skipPermissions }`。成功返回 `{ name, created }`；随即 `POST url("api/jira/bindings")` 带 `{ session: name, key }`；然后跳到 `url("terminal.html?target=" + encodeURIComponent(name))`。
8. 失败：服务端返回 `{ error }`，`reserved` / `invalid` 映射到 `jira.nameTaken`，其余到 `jira.createFailed`。
9. 顶栏计数元素 `#count` 写工单数（`jira.count`）——`renderHeader` 会为当前页创建这个元素，照 `gallery.js` 的用法。

**已知会有一部分 UI 与 `public/new.js` 重复**（目录选择与 agent 选择）。这是 spec 里明确接受的代价：另一条路要给插件接缝再开一个"建后钩子"，一个功能里连开两个口子更坏。若将来第三个插件也要"建完之后做点什么"，那时再把建后钩子做成正式能力。

- [ ] **Step 3: 跑扫描型测试**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test src/public-parses.test.ts src/i18n.test.ts plugins/jira/fixtures.test.ts
```

`public-parses.test.ts` 会把新页面纳入 `Bun.build`（它 glob `plugins/*/public/`），`i18n.test.ts` 会校验所有 `jira.*` 键都被用到且两本字典一致。**一个都不许红**：`i18n.test.ts` 报 dead key，就是页面上少用了一条文案，去补用而不是删键。

- [ ] **Step 4: 手动看一眼**

```bash
export PATH="$HOME/.bun/bin:$PATH"
TMUX_NEXT_JIRA_DIR=$(mktemp -d) bun run src/index.ts --port 7999
```

浏览器开 `http://127.0.0.1:7999/p/jira/`：应当显示"还没配置 Jira"和那句提示，且**没有**任何网络请求打向 Jira。顶栏三个 tab 变四个。看完 Ctrl-C，杀掉的只能是你自己起的这个进程。

- [ ] **Step 5: 跑全量并提交**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run test
```

```bash
git add plugins/jira/public/index.html plugins/jira/public/jira.js
git commit -m "feat: 工单页——按单分组、组内挂会话、从单开会话"
```

---

### Task 7: 安全说明与文档

**Files:**
- Modify: `SECURITY.md`
- Modify: `CLAUDE.md`
- Modify: `README.md`、`README.zh-CN.md`

- [ ] **Step 1: SECURITY.md**

在"It has no authentication"那节之后，新增一节，用该文件已有的直白语气：

```markdown
## It can now hold a Jira credential

With the Jira plugin configured, `~/.tmux-next/jira/config.json` holds an API
token for your Jira instance. The file is `0600` and no endpoint ever returns
the token — but that is not the boundary that matters. **Anyone who can reach
this service can read your Jira through it**, as you, without ever seeing the
token.

So the warning above changes in kind, not just degree: an exposed port was
already a shell, and is now a shell plus your issue tracker.

The plugin only ever runs the JQL from `config.json`. It does not accept a
query from the browser, and it must not be changed to — that would turn the
service into an open query proxy against your instance.

Turn the whole thing off with `TMUX_NEXT_DISABLE_PLUGINS=jira`; the tab, the
API and the pages disappear together.
```

- [ ] **Step 2: CLAUDE.md**

在插件那一节之后加一段（英文，与该文件其余部分一致），讲清两件事：

- 插件可以给会话行贴**只读**标注（`annotate`），内核有 300ms 硬超时并吞掉异常——一个插件不能让内核的列表页出不来。`src/plugin-annotate.test.ts` 用一个会抛、一个会卡住的假插件守这条。`collectAnnotations` 收一个可选的 annotators 参数正是为了能这样测：注册表是编译期写死的，没有这个参数就没法注入假插件。
- Jira 插件的绑定为什么同时存会话名和 `#{session_id}`：id 跨改名不变、跨 tmux server 重启会重排，名字反过来；两个都存，就不必给接缝再开一个"会话改名事件"的口子。会话 id 由插件自己向 tmux 要，**不要**为此往内核的会话列表里加字段。

- [ ] **Step 3: 两份 README**

先找现状：

```bash
grep -n "gallery\|notifications\|制品\|通知\|plugin\|插件" README.md README.zh-CN.md
```

如果两份 README 有列举功能或插件的地方，各加一行 Jira 工单插件，**两份必须同步**（`README.zh-CN.md` 是 `README.md` 的镜像）。如果都没有这样的地方，就什么都不改，并在报告里说明——不要凭空造一段文档。

- [ ] **Step 4: 跑全量并提交**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run test
```

```bash
git add SECURITY.md CLAUDE.md README.md README.zh-CN.md
git commit -m "docs: 记下工单插件、标注能力，以及它带来的暴露面变化"
```

---

## 完工核对

- [ ] `bun run test` 只有已知的两条环境性失败
- [ ] `grep -rn "from \"\.\./plugins/jira" src/` 为空——内核不认识这个插件
- [ ] `grep -n "jira\|gallery" public/list.js` 为空——列表页不认识任何具体插件
- [ ] `TMUX_NEXT_DISABLE_PLUGINS=jira` 起服务：tab 没了，`/p/jira/` 与 `/api/jira/issues` 双双 404，会话列表照常出且没有工单标注
- [ ] 未配置 Jira 时，整个应用不向外发任何请求
- [ ] `plugins/jira/` 下不存在真实域名、公司名、工单号、邮箱（`plugins/jira/fixtures.test.ts` 守着）
- [ ] `~/.tmux-next/` 下没有被测试写过任何东西
