# 单子驱动 · 第 1 期：内核长出 Work Item 与绑定

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「单」和「会话属于哪张单」变成内核概念，落到磁盘，暴露成 API，并把 Jira 插件里那份私有绑定迁移进来——首页此期仍是会话列表，但每行知道自己属于哪张单。

**Architecture:** 两个纯文本状态文件（`items.json`、`bindings.json`）由两个内核叶子模块拥有，共用一个从 Jira 插件提炼出来的原子写 + 序列化队列模块。绑定按会话名作键、同时存 `#{session_id}`，解析时 id 优先名字兜底。Jira 插件删掉自己那份绑定实现，它原有的 `/api/jira/bindings` 三个路由改写成落在内核 store 上的兼容垫片，于是它 1025 行的页面这一期一行不用改。

**Tech Stack:** Bun（无构建步骤）、TypeScript、`bun:test`、happy-dom（前端渲染测试）、tmux 3.2+ 控制模式。零运行时依赖。

**Spec:** `docs/superpowers/specs/2026-09-01-work-item-driven-design.md`

## Global Constraints

这些是整个仓库的规矩，每个任务都隐含要求，逐条照做：

- **每一次 tmux 调用都走 `src/tmux/run.ts` 的 `tmux(argv)`，绝不用 `Bun.$`。** shell 会对插值做与环境相关的分词；launchd 下曾把 `-F` 格式里的 tab 改写成 `_`，把每个解析出来的字段都毁掉。
- **目标 tmux 一律用 `=<name>`。** 裸 target 按前缀和 glob 解析——`kill-session -t web` 会杀掉 `webmux`。
- **绝不跑 `tmux kill-server`，绝不杀不是自己建的会话。** 清理只按确切名字 `kill-session -t =<name>`，且只对本轮建过并记录下来的名字。破坏性命令之前必须先有一次「目标确实是我以为的东西」的检查，并且**读到结果之后**才执行。
- **每一条磁盘状态路径都必须可用环境变量覆盖**，且**在函数体里现读，不在模块加载时捕获**——测试要能先设 env 再调用。本期新增两条：`TMUX_NEXT_ITEMS_PATH`、`TMUX_NEXT_BINDINGS_PATH`。
- **UI 字符串一律进 `public/i18n.js`，绝不内联。** `src/i18n.test.ts` 会扫描每一处 `t("…")`、`tr("…")` 与 `data-i18n`，键缺失、键没人用、或只有一种语言有，都会红。
- **样式里不许出现颜色字面量。** 颜色只能来自 `public/themes.js` 派生的主题变量，`src/themes.test.ts` 守着这条。
- **提交信息不带任何助手署名。** 不写 `Co-Authored-By: Claude …`、不写 `Claude-Session:`、不写 `🤖 Generated with …`。仓库是公开的，这些 trailer 会变成额外贡献者，历史清洗过一次，不能再沾。正文里提到 Claude Code 没问题。
- **不引入任何新依赖**，`bun:sqlite` 也不用（见 spec 的论证）。
- 命令：`bun run typecheck`（`tsc --noEmit`）、`bun test`（全量，**不含** typecheck）、`bun run test`（两者都跑，CI 等价物）。

---

### Task 1: `src/json-store.ts` —— 原子写 + 进程内序列化队列

从 `plugins/jira/bindings.ts` 里把这两件事提炼成内核叶子模块。它们各防一件事，缺一不可：临时文件 + `rename` 在同一文件系统内原子，防的是**另一个 bun 进程读到写了一半的 JSON**；序列化队列防的是**本进程内并发的读-改-写互相丢更新**。跨进程的并发写不在队列覆盖范围内，代码注释里必须如实说明，不作相反宣称。

**Files:**
- Create: `src/json-store.ts`
- Test: `src/json-store.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `readJson<T>(path: string, fallback: T, sanitise?: (raw: unknown) => T): Promise<T>`
  - `writeJsonAtomic(path: string, value: unknown): Promise<void>`
  - `serialized<T>(fn: () => Promise<T>): Promise<T>`

- [ ] **Step 1: 写下会失败的测试**

创建 `src/json-store.test.ts`：

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, writeJsonAtomic, serialized } from "./json-store";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "json-store-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("文件不存在时读出 fallback", async () => {
  expect(await readJson(join(root, "nope.json"), { a: 1 })).toEqual({ a: 1 });
});

test("坏 JSON 读出 fallback，不抛", async () => {
  const path = join(root, "bad.json");
  await writeFile(path, "{ not json");
  expect(await readJson(path, {})).toEqual({});
});

test("写得进读得回", async () => {
  const path = join(root, "ok.json");
  await writeJsonAtomic(path, { hello: "世界" });
  expect(await readJson(path, {})).toEqual({ hello: "世界" });
});

test("写入不留临时文件", async () => {
  const path = join(root, "ok.json");
  await writeJsonAtomic(path, { a: 1 });
  const { readdir } = await import("node:fs/promises");
  expect(await readdir(root)).toEqual(["ok.json"]);
});

test("目录不存在时自己建出来", async () => {
  const path = join(root, "deep", "nested", "x.json");
  await writeJsonAtomic(path, { a: 1 });
  expect(await readJson(path, {})).toEqual({ a: 1 });
});

test("sanitise 决定读出来的形状", async () => {
  const path = join(root, "s.json");
  await writeFile(path, JSON.stringify({ keep: 1, drop: 2 }));
  const got = await readJson(path, {} as Record<string, number>, (raw) => {
    const r = raw as Record<string, unknown>;
    return typeof r?.keep === "number" ? { keep: r.keep } : {};
  });
  expect(got).toEqual({ keep: 1 });
});

// 这条是整个模块存在的理由：三个并发的读-改-写，一条都不能丢。
test("并发的读-改-写不丢更新", async () => {
  const path = join(root, "c.json");
  await writeJsonAtomic(path, {} as Record<string, number>);

  const bump = (key: string) =>
    serialized(async () => {
      const all = await readJson<Record<string, number>>(path, {});
      all[key] = 1;
      await writeJsonAtomic(path, all);
    });

  await Promise.all([bump("a"), bump("b"), bump("c")]);
  expect(await readJson(path, {})).toEqual({ a: 1, b: 1, c: 1 });
});

test("队列里一个任务抛了，后面的照跑", async () => {
  const seen: string[] = [];
  const boom = serialized(async () => {
    throw new Error("boom");
  });
  await expect(boom).rejects.toThrow("boom");
  await serialized(async () => {
    seen.push("after");
  });
  expect(seen).toEqual(["after"]);
});
```

- [ ] **Step 2: 跑一次确认它红**

Run: `bun test src/json-store.test.ts`
Expected: FAIL，报 `Cannot find module './json-store'`

- [ ] **Step 3: 写最小实现**

创建 `src/json-store.ts`：

```ts
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * 一份 JSON 状态文件的读与写。
 *
 * 两件事各防一件，缺一不可：
 *
 * - 临时文件 + rename 在同一文件系统内是原子的，防的是**另一个 bun 进程**读到
 *   写了一半的 JSON。
 * - 下面那条序列化队列防的是本进程内并发的读-改-写互相覆盖：三个写者各自先读
 *   全表再各自写全表，后写的会拿着自己那份"旧"全表盖掉前面写进去的记录。
 *
 * 队列**只在本进程内有效**。两个 bun 进程同时写同一份文件不在它的保护范围内，
 * 那时仍然只有 rename 的原子性兜底——这里不作任何相反的宣称。
 */

/** 全函数：文件不存在、JSON 坏了、形状不对，一律读成 fallback，绝不抛。 */
export async function readJson<T>(
  path: string,
  fallback: T,
  sanitise?: (raw: unknown) => T,
): Promise<T> {
  try {
    const raw = await Bun.file(path).json();
    return sanitise ? sanitise(raw) : (raw as T);
  } catch {
    return fallback;
  }
}

/** 先写同目录下的临时文件，再 rename——同一文件系统内是原子的。 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * 进程内串行化。
 *
 * 一份文件的**每一次**读-改-写都要整段进来，不能只把写包进来：在队列外面读、
 * 进队列写，中间那道缝跟没排队一样。
 *
 * 注意队列是模块级的、跨文件共享的：本仓库的状态文件都很小、写得很稀，一条队
 * 列足够，且省掉了"每份文件一条队列"的簿记。
 */
export function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `bun test src/json-store.test.ts && bun run typecheck`
Expected: 8 个测试 PASS，typecheck 无输出

- [ ] **Step 5: 提交**

```bash
git add src/json-store.ts src/json-store.test.ts
git commit -m "refactor: 原子写与序列化队列提炼成内核叶子模块"
```

---

### Task 2: `src/items.ts` —— 单的存储

**Files:**
- Create: `src/items.ts`
- Test: `src/items.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `readJson` / `writeJsonAtomic` / `serialized`
- Produces:
  - `type WorkItem = { id: string; title: string; cwd: string | null; source: { provider: string; ref: string; url?: string } | null; tags: string[]; createdAt: number; closedAt: number | null }`
  - `itemsPath(): string`
  - `readItems(): Promise<WorkItem[]>`
  - `createItem(input: { title: string; cwd?: string | null; source?: WorkItem["source"]; tags?: string[] }): Promise<WorkItem>`
  - `updateItem(id: string, patch: Partial<Pick<WorkItem, "title" | "cwd" | "tags" | "closedAt" | "source">>): Promise<WorkItem | null>`
  - `findBySource(provider: string, ref: string): Promise<WorkItem | null>`
  - `ensureItemForSource(provider: string, ref: string, title?: string): Promise<WorkItem>`

- [ ] **Step 1: 写下会失败的测试**

创建 `src/items.test.ts`：

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readItems,
  createItem,
  updateItem,
  findBySource,
  ensureItemForSource,
} from "./items";

/**
 * 单是内核概念，Jira 只是来源之一：一张单可以完全没有 source，也可以挂一个。
 * id 由内核生成、永不变——单号可以改、可以事后才补上，而 URL 与绑定必须指得住。
 */

let root: string;
let saved: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "items-"));
  saved = process.env.TMUX_NEXT_ITEMS_PATH;
  process.env.TMUX_NEXT_ITEMS_PATH = join(root, "items.json");
});

afterEach(async () => {
  if (saved === undefined) delete process.env.TMUX_NEXT_ITEMS_PATH;
  else process.env.TMUX_NEXT_ITEMS_PATH = saved;
  await rm(root, { recursive: true, force: true });
});

test("没有文件时读出空表", async () => {
  expect(await readItems()).toEqual([]);
});

test("坏 JSON 读成空表，不抛", async () => {
  await writeFile(join(root, "items.json"), "{ not json");
  expect(await readItems()).toEqual([]);
});

test("没有 title 的记录被丢掉，其余照读", async () => {
  await writeFile(
    join(root, "items.json"),
    JSON.stringify([{ id: "it-1", title: "好的" }, { id: "it-2" }, { title: "没 id" }]),
  );
  const items = await readItems();
  expect(items.map((i) => i.id)).toEqual(["it-1"]);
});

test("建单补齐默认值", async () => {
  const item = await createItem({ title: "修登录页" });
  expect(item.id).toMatch(/^it-[a-z0-9]+$/);
  expect(item.title).toBe("修登录页");
  expect(item.cwd).toBeNull();
  expect(item.source).toBeNull();
  expect(item.tags).toEqual([]);
  expect(item.closedAt).toBeNull();
  expect(typeof item.createdAt).toBe("number");
});

test("建出来的单读得回来", async () => {
  const a = await createItem({ title: "甲" });
  const b = await createItem({ title: "乙", cwd: "/tmp/x" });
  const items = await readItems();
  expect(items.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
  expect(items.find((i) => i.id === b.id)?.cwd).toBe("/tmp/x");
});

test("两张单的 id 不相同", async () => {
  const a = await createItem({ title: "甲" });
  const b = await createItem({ title: "甲" });
  expect(a.id).not.toBe(b.id);
});

test("改标题改得动，id 与 createdAt 不动", async () => {
  const a = await createItem({ title: "旧" });
  const next = await updateItem(a.id, { title: "新" });
  expect(next?.title).toBe("新");
  expect(next?.id).toBe(a.id);
  expect(next?.createdAt).toBe(a.createdAt);
});

test("改不存在的单返回 null", async () => {
  expect(await updateItem("it-nope", { title: "x" })).toBeNull();
});

// 归档不是删除：单从默认视图消失，但它的绑定记录还在。
test("归档写上 closedAt，单仍然读得到", async () => {
  const a = await createItem({ title: "甲" });
  await updateItem(a.id, { closedAt: 1787000000 });
  const items = await readItems();
  expect(items.find((i) => i.id === a.id)?.closedAt).toBe(1787000000);
});

test("按来源找得到，找不到给 null", async () => {
  await createItem({ title: "无源" });
  const withSource = await createItem({
    title: "有源",
    source: { provider: "jira", ref: "EXAMPLE-1" },
  });
  expect((await findBySource("jira", "EXAMPLE-1"))?.id).toBe(withSource.id);
  expect(await findBySource("jira", "EXAMPLE-2")).toBeNull();
  expect(await findBySource("github", "EXAMPLE-1")).toBeNull();
});

test("ensureItemForSource 第二次不再建新的", async () => {
  const first = await ensureItemForSource("jira", "EXAMPLE-1", "EXAMPLE-1");
  const second = await ensureItemForSource("jira", "EXAMPLE-1", "别的标题");
  expect(second.id).toBe(first.id);
  expect((await readItems()).length).toBe(1);
});

test("并发建三张单，一张都不丢", async () => {
  await Promise.all([
    createItem({ title: "甲" }),
    createItem({ title: "乙" }),
    createItem({ title: "丙" }),
  ]);
  expect((await readItems()).length).toBe(3);
});
```

- [ ] **Step 2: 跑一次确认它红**

Run: `bun test src/items.test.ts`
Expected: FAIL，报 `Cannot find module './items'`

- [ ] **Step 3: 写最小实现**

创建 `src/items.ts`：

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { readJson, writeJsonAtomic, serialized } from "./json-store";

/**
 * 一张单：工作的单位。会话是它底下的手段。
 *
 * 内核概念，不是某个插件的：Jira 只是 source 的一种取值。source 为 null 的本地
 * 单跟挂了工单的单是同一种东西，首页上也是同一种行。
 *
 * id 由内核生成、永不变。不复用单号：单号可以改、可以在认领之后才补上，而 URL
 * 与绑定必须指得住。
 *
 * 状态、Epic 这些**一个都不存**——它们是每次现算的 facet。存下来就要同步，而
 * "内核存自己的单 + 外部引用"这个模型之所以成立，正是因为远端那部分是叠上去的。
 * 只有本地的 tags 是存的。
 */

export type ItemSource = { provider: string; ref: string; url?: string };

export type WorkItem = {
  id: string;
  title: string;
  cwd: string | null;
  source: ItemSource | null;
  tags: string[];
  createdAt: number;
  /** 归档，不是删除：单从默认视图消失，它的会话与绑定记录都还在。 */
  closedAt: number | null;
};

/** 路径在函数里现读，不在模块加载时捕获——测试要能先设 env 再调用。 */
export function itemsPath(): string {
  return process.env.TMUX_NEXT_ITEMS_PATH || join(homedir(), ".tmux-next", "items.json");
}

function sanitiseSource(raw: unknown): ItemSource | null {
  const s = raw as Record<string, unknown>;
  if (typeof s?.provider !== "string" || !s.provider) return null;
  if (typeof s?.ref !== "string" || !s.ref) return null;
  return {
    provider: s.provider,
    ref: s.ref,
    ...(typeof s.url === "string" && s.url ? { url: s.url } : {}),
  };
}

/** 全函数：坏文件、坏记录一律读成空/丢掉，绝不抛。 */
export async function readItems(): Promise<WorkItem[]> {
  return readJson<WorkItem[]>(itemsPath(), [], (raw) => {
    if (!Array.isArray(raw)) return [];
    const out: WorkItem[] = [];
    for (const value of raw) {
      const v = value as Record<string, unknown>;
      if (typeof v?.id !== "string" || !v.id) continue;
      if (typeof v?.title !== "string" || !v.title) continue;
      out.push({
        id: v.id,
        title: v.title,
        cwd: typeof v.cwd === "string" ? v.cwd : null,
        source: sanitiseSource(v.source),
        tags: Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === "string") : [],
        createdAt: typeof v.createdAt === "number" ? v.createdAt : 0,
        closedAt: typeof v.closedAt === "number" ? v.closedAt : null,
      });
    }
    return out;
  });
}

/** `it-` + 时间 + 随机：时间让它大致有序，随机让同一秒内建的两张不撞。 */
function newId(): string {
  return `it-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function createItem(input: {
  title: string;
  cwd?: string | null;
  source?: ItemSource | null;
  tags?: string[];
}): Promise<WorkItem> {
  const item: WorkItem = {
    id: newId(),
    title: input.title,
    cwd: input.cwd ?? null,
    source: input.source ?? null,
    tags: input.tags ?? [],
    createdAt: Math.floor(Date.now() / 1000),
    closedAt: null,
  };
  // 整段读-改-写都在队列里，不只是写：在队列外面读、进队列写，中间那道缝跟没
  // 排队一样。
  await serialized(async () => {
    const all = await readItems();
    all.push(item);
    await writeJsonAtomic(itemsPath(), all);
  });
  return item;
}

export async function updateItem(
  id: string,
  patch: Partial<Pick<WorkItem, "title" | "cwd" | "tags" | "closedAt" | "source">>,
): Promise<WorkItem | null> {
  return serialized(async () => {
    const all = await readItems();
    const found = all.find((i) => i.id === id);
    if (!found) return null;
    Object.assign(found, patch);
    await writeJsonAtomic(itemsPath(), all);
    return found;
  });
}

export async function findBySource(provider: string, ref: string): Promise<WorkItem | null> {
  const all = await readItems();
  return all.find((i) => i.source?.provider === provider && i.source.ref === ref) ?? null;
}

/**
 * 认领一个外部引用：已经有对应的单就返回它，没有就建一张。
 *
 * 整个查找-建立在队列里，否则两个并发的认领会给同一个单号建出两张单。
 */
export async function ensureItemForSource(
  provider: string,
  ref: string,
  title?: string,
): Promise<WorkItem> {
  return serialized(async () => {
    const all = await readItems();
    const found = all.find((i) => i.source?.provider === provider && i.source.ref === ref);
    if (found) return found;
    const item: WorkItem = {
      id: newId(),
      title: title || ref,
      cwd: null,
      source: { provider, ref },
      tags: [],
      createdAt: Math.floor(Date.now() / 1000),
      closedAt: null,
    };
    all.push(item);
    await writeJsonAtomic(itemsPath(), all);
    return item;
  });
}
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `bun test src/items.test.ts && bun run typecheck`
Expected: 12 个测试 PASS，typecheck 无输出

- [ ] **Step 5: 提交**

```bash
git add src/items.ts src/items.test.ts
git commit -m "feat: 内核长出「单」，纯文本落盘、按来源认领"
```

---

### Task 3: 会话列表带出 `#{session_id}`

绑定要靠 tmux 内部 id 扛住改名。这个字段现在由 `plugins/jira/sessions.ts` 单独跑一次 `list-sessions` 取——那是因为当年绑定是插件的私产，且 CLAUDE.md 明令「不要为一个插件的需要往内核列表里加字段」。绑定进内核之后那条禁令不再适用：加的是内核自己要用的字段，插件那次多余的调用随之退休。

**注意字段位置。** `LIST_FORMAT` 里名字是最后一个、贪婪的字段（名字可能含 `|`），目录用 `#{q:…}` 转义过。`#{session_id}` 形如 `$7`，不可能含 `|`，所以放在**最前面**，解析时按固定下标取，名字仍然吃掉尾部全部。

**Files:**
- Modify: `src/tmux/session-list.ts`（`LIST_FORMAT` 常量、`SessionSummary` 类型、`listSessions` 里的解析）
- Test: `src/tmux/session-list.test.ts`

- [ ] **Step 1: 写下会失败的测试**

在 `src/tmux/session-list.test.ts` 末尾追加（先读该文件确认已有的 import 与既有断言风格，不要重复 import）：

```ts
test("LIST_FORMAT 把 session_id 放在最前，名字仍在最后", () => {
  expect(LIST_FORMAT.startsWith("#{session_id}|")).toBe(true);
  expect(LIST_FORMAT.endsWith("|#{session_name}")).toBe(true);
});

test("解析出 sessionId，名字里的竖线不受影响", () => {
  const row = "$7|80|24|1700000000|0|node|/tmp/x|叫 a|b 的会话";
  const parsed = parseSessionRow(row);
  expect(parsed?.sessionId).toBe("$7");
  expect(parsed?.name).toBe("叫 a|b 的会话");
  expect(parsed?.path).toBe("/tmp/x");
});
```

若 `LIST_FORMAT` 与行解析目前不是导出的，本步同时把它们导出：`export const LIST_FORMAT = …`，并把 `listSessions` 里那段 `row.split(FIELD_SEP)` 的解析抽成导出的纯函数

```ts
export function parseSessionRow(row: string): {
  sessionId: string; windowWidth: number; windowHeight: number;
  activity: number; attached: boolean; command: string; path: string; name: string;
} | null
```

`listSessions` 改为调用它。抽出来的理由是它现在有了自己的边界情况（名字含分隔符、字段位置），而那些无头就能测，不必去驱动 tmux。

- [ ] **Step 2: 跑一次确认它红**

Run: `bun test src/tmux/session-list.test.ts`
Expected: FAIL —— `parseSessionRow` 未导出 / `sessionId` 是 undefined

- [ ] **Step 3: 改实现**

`LIST_FORMAT` 改成：

```ts
// session_id 放最前：它形如 $7，不可能含分隔符，所以按固定下标取得住；名字仍
// 然是最后一个贪婪字段，因为它可以含 `|`。绑定要靠这个 id 扛住会话改名——
// #{session_id} 跨改名不变，名字跨改名变，两者各覆盖一半。
const LIST_FORMAT =
  "#{session_id}|#{window_width}|#{window_height}|#{window_activity}|#{session_attached}|" +
  "#{pane_current_command}|#{q:session_path}|#{session_name}";
```

`SessionSummary` 加一个字段，注释写明它是干什么的：

```ts
  /**
   * tmux 的内部会话 id（形如 `$7`）。
   *
   * 绑定用它扛住改名：id 跨改名不变、跨 tmux server 重启会重排；名字反过来。
   * 存两个、解析时 id 优先名字兜底，各覆盖一半——于是内核不必长出一个"会话改名
   * 事件"。
   */
  sessionId: string;
```

`listSessions` 里改用 `parseSessionRow(row)`，把 `sessionId` 带进 summary。

- [ ] **Step 4: 跑测试确认全绿**

Run: `bun test src/tmux/session-list.test.ts && bun run typecheck`
Expected: PASS；typecheck 会指出所有构造 `SessionSummary` 的地方缺字段，逐个补上

- [ ] **Step 5: 跑一次全量，确认没碰坏别的**

Run: `bun test`
Expected: 全绿。**若有红的，先读输出**——`server.test.ts` / `reconnect.test.ts` 的孤儿会话断言按 `web-${process.pid}-` 收窄过，那些红说明是真问题，不是"已知会飘"。

- [ ] **Step 6: 提交**

```bash
git add src/tmux/session-list.ts src/tmux/session-list.test.ts
git commit -m "feat: 会话摘要带出 session_id，行解析抽成可无头测的纯函数"
```

---

### Task 4: `src/session-binding.ts` —— 会话属于哪张单

**Files:**
- Create: `src/session-binding.ts`
- Test: `src/session-binding.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `readJson` / `writeJsonAtomic` / `serialized`
- Produces:
  - `type Binding = { itemId: string; sessionId: string; boundAt: number }`
  - `type ResolvedBinding = { session: string; itemId: string; live: boolean }`
  - `bindingsPath(): string`
  - `readBindings(): Promise<Record<string, Binding>>`
  - `bindSession(session: string, itemId: string, sessionId: string): Promise<void>`
  - `unbindSession(session: string): Promise<void>`
  - `resolveBindings(live: Array<{ name: string; sessionId: string }>): Promise<ResolvedBinding[]>`

- [ ] **Step 1: 写下会失败的测试**

创建 `src/session-binding.test.ts`：

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBindings, bindSession, unbindSession, resolveBindings } from "./session-binding";

/**
 * 按**会话**作键：一张单可以有多个会话（会话名唯一，单不唯一），反过来存则每次
 * 会话改名或消亡都要去数组里翻。
 *
 * 名字与 sessionId 都存，是为了改名：id 跨改名不变、跨 tmux server 重启会重排；
 * 名字反过来。两个都存、id 优先名字兜底，各覆盖一半，于是内核不必长出一个"会话
 * 改名事件"。
 */

let root: string;
let saved: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "binding-"));
  saved = process.env.TMUX_NEXT_BINDINGS_PATH;
  process.env.TMUX_NEXT_BINDINGS_PATH = join(root, "bindings.json");
});

afterEach(async () => {
  if (saved === undefined) delete process.env.TMUX_NEXT_BINDINGS_PATH;
  else process.env.TMUX_NEXT_BINDINGS_PATH = saved;
  await rm(root, { recursive: true, force: true });
});

test("没有文件时读出空表", async () => {
  expect(await readBindings()).toEqual({});
});

test("坏 JSON 读成空表，不抛", async () => {
  await writeFile(join(root, "bindings.json"), "{ not json");
  expect(await readBindings()).toEqual({});
});

test("没有 itemId 的记录被丢掉", async () => {
  await writeFile(
    join(root, "bindings.json"),
    JSON.stringify({ 甲: { itemId: "it-1", sessionId: "$1" }, 乙: { sessionId: "$2" } }),
  );
  expect(Object.keys(await readBindings())).toEqual(["甲"]);
});

test("绑定写得进读得回", async () => {
  await bindSession("修登录页", "it-1", "$7");
  const all = await readBindings();
  expect(all["修登录页"]?.itemId).toBe("it-1");
  expect(all["修登录页"]?.sessionId).toBe("$7");
  expect(typeof all["修登录页"]?.boundAt).toBe("number");
});

// 设计的轴心：一张单多个会话是常态，不是边角情况。
test("同一张单可以绑多个会话", async () => {
  await bindSession("跑测试", "it-1", "$7");
  await bindSession("改代码", "it-1", "$8");
  const all = await readBindings();
  expect(all["跑测试"]?.itemId).toBe("it-1");
  expect(all["改代码"]?.itemId).toBe("it-1");
});

test("解绑只解那一条", async () => {
  await bindSession("甲", "it-1", "$1");
  await bindSession("乙", "it-1", "$2");
  await unbindSession("甲");
  expect(Object.keys(await readBindings())).toEqual(["乙"]);
});

test("并发绑三个会话，一条都不丢", async () => {
  await Promise.all([
    bindSession("甲", "it-1", "$1"),
    bindSession("乙", "it-1", "$2"),
    bindSession("丙", "it-2", "$3"),
  ]);
  expect(Object.keys(await readBindings()).sort()).toEqual(["丙", "乙", "甲"].sort());
});

test("活着的会话解析为 live", async () => {
  await bindSession("甲", "it-1", "$1");
  const out = await resolveBindings([{ name: "甲", sessionId: "$1" }]);
  expect(out).toEqual([{ session: "甲", itemId: "it-1", live: true }]);
});

// 会话没了的绑定**不删**：这个仓库有会话恢复机制，一条指向已死会话的绑定恰好是
// "这张单之前开过，要不要恢复"。自动删会把那个入口一起删掉。
test("会话没了仍然留着记录，只是 live 为 false", async () => {
  await bindSession("甲", "it-1", "$1");
  const out = await resolveBindings([]);
  expect(out).toEqual([{ session: "甲", itemId: "it-1", live: false }]);
  expect(Object.keys(await readBindings())).toEqual(["甲"]);
});

test("改过名的会话按 id 认回来，并迁到新名字下", async () => {
  await bindSession("旧名", "it-1", "$7");
  const out = await resolveBindings([{ name: "新名", sessionId: "$7" }]);
  expect(out).toEqual([{ session: "新名", itemId: "it-1", live: true }]);
  const all = await readBindings();
  expect(all["新名"]?.itemId).toBe("it-1");
  expect(all["旧名"]).toBeUndefined();
});

test("id 对不上时按名字兜底", async () => {
  // tmux server 重启后 id 会重排，这时只剩名字能认。
  await bindSession("甲", "it-1", "$7");
  const out = await resolveBindings([{ name: "甲", sessionId: "$99" }]);
  expect(out).toEqual([{ session: "甲", itemId: "it-1", live: true }]);
});
```

- [ ] **Step 2: 跑一次确认它红**

Run: `bun test src/session-binding.test.ts`
Expected: FAIL，报 `Cannot find module './session-binding'`

- [ ] **Step 3: 写最小实现**

创建 `src/session-binding.ts`。**直接照搬 `plugins/jira/bindings.ts` 的算法**，只把 `key` 换成 `itemId`、把写入换成 Task 1 的模块：

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { readJson, writeJsonAtomic, serialized } from "./json-store";

/**
 * 会话属于哪张单。
 *
 * 按**会话名**作键，因为一张单可以有多个会话——会话名唯一，单不唯一。反过来存
 * （单 → 会话数组）每次会话改名或消亡都要去数组里翻。
 *
 * 名字与 tmux 的 #{session_id} 都存：id 跨改名不变、跨 tmux server 重启会重排；
 * 名字反过来。解析时 id 优先、名字兜底，两者各覆盖一半——于是内核不必为此长出
 * 一个"会话改名事件"。
 */

export type Binding = { itemId: string; sessionId: string; boundAt: number };
export type ResolvedBinding = { session: string; itemId: string; live: boolean };

export function bindingsPath(): string {
  return process.env.TMUX_NEXT_BINDINGS_PATH || join(homedir(), ".tmux-next", "bindings.json");
}

export async function readBindings(): Promise<Record<string, Binding>> {
  return readJson<Record<string, Binding>>(bindingsPath(), {}, (raw) => {
    const data = raw as Record<string, unknown>;
    const out: Record<string, Binding> = {};
    for (const [session, value] of Object.entries(data ?? {})) {
      const v = value as Record<string, unknown>;
      if (typeof v?.itemId !== "string" || !v.itemId) continue;
      out[session] = {
        itemId: v.itemId,
        sessionId: typeof v.sessionId === "string" ? v.sessionId : "",
        boundAt: typeof v.boundAt === "number" ? v.boundAt : 0,
      };
    }
    return out;
  });
}

export async function bindSession(
  session: string,
  itemId: string,
  sessionId: string,
): Promise<void> {
  await serialized(async () => {
    const all = await readBindings();
    all[session] = { itemId, sessionId, boundAt: Math.floor(Date.now() / 1000) };
    await writeJsonAtomic(bindingsPath(), all);
  });
}

export async function unbindSession(session: string): Promise<void> {
  await serialized(async () => {
    const all = await readBindings();
    delete all[session];
    await writeJsonAtomic(bindingsPath(), all);
  });
}

/**
 * 绑定对上现在活着的会话。
 *
 * 认回顺序是 id 优先、名字兜底。按 id 认回来的会话若已改名，记录跟着迁到新名字
 * 下——否则每次都要重认一遍，而一次写就能让它安顿。
 *
 * 会话没了的绑定**不删**：这个仓库有会话恢复机制，一条指向已死会话的绑定恰好是
 * "这张单之前开过，要不要恢复"。自动删会把那个入口一起删掉。
 */
export async function resolveBindings(
  live: Array<{ name: string; sessionId: string }>,
): Promise<ResolvedBinding[]> {
  const all = await readBindings();
  const byId = new Map(live.filter((s) => s.sessionId).map((s) => [s.sessionId, s]));
  const names = new Set(live.map((s) => s.name));

  const out: ResolvedBinding[] = [];
  const renames: Array<[string, string]> = [];

  for (const [session, binding] of Object.entries(all)) {
    const byIdHit = binding.sessionId ? byId.get(binding.sessionId) : undefined;
    if (byIdHit) {
      if (byIdHit.name !== session) renames.push([session, byIdHit.name]);
      out.push({ session: byIdHit.name, itemId: binding.itemId, live: true });
      continue;
    }
    out.push({ session, itemId: binding.itemId, live: names.has(session) });
  }

  if (renames.length) {
    // 整个读-改-写必须在队列里面，不只是写——在队列外面读、进队列写，中间那道
    // 缝跟没排队一样，一次 bindSession 落在缝里就会被这里的旧快照覆盖掉。
    await serialized(async () => {
      const next = await readBindings();
      for (const [from, to] of renames) {
        const moved = next[from];
        if (!moved) continue;
        delete next[from];
        next[to] = moved;
      }
      await writeJsonAtomic(bindingsPath(), next);
    });
  }

  return out;
}
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `bun test src/session-binding.test.ts && bun run typecheck`
Expected: 11 个测试 PASS

- [ ] **Step 5: 提交**

```bash
git add src/session-binding.ts src/session-binding.test.ts
git commit -m "feat: 会话与单的绑定进内核，id 优先名字兜底扛住改名"
```

---

### Task 5: `src/migrate-items.ts` —— 从 Jira 插件那份绑定一次性迁移

**Files:**
- Create: `src/migrate-items.ts`
- Test: `src/migrate-items.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `readItems` / `ensureItemForSource` / `itemsPath`，Task 4 的 `readBindings` / `bindSession` / `bindingsPath`
- Produces: `migrateJiraBindings(): Promise<{ migrated: number }>`

- [ ] **Step 1: 写下会失败的测试**

创建 `src/migrate-items.test.ts`：

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateJiraBindings } from "./migrate-items";
import { readItems } from "./items";
import { readBindings } from "./session-binding";

let root: string;
const saved: Record<string, string | undefined> = {};
const VARS = ["TMUX_NEXT_ITEMS_PATH", "TMUX_NEXT_BINDINGS_PATH", "TMUX_NEXT_JIRA_DIR"];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "migrate-"));
  for (const v of VARS) saved[v] = process.env[v];
  process.env.TMUX_NEXT_ITEMS_PATH = join(root, "items.json");
  process.env.TMUX_NEXT_BINDINGS_PATH = join(root, "bindings.json");
  process.env.TMUX_NEXT_JIRA_DIR = join(root, "jira");
  await mkdir(join(root, "jira"), { recursive: true });
});

afterEach(async () => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v]!;
  }
  await rm(root, { recursive: true, force: true });
});

async function writeOldBindings(data: unknown) {
  await writeFile(join(root, "jira", "bindings.json"), JSON.stringify(data));
}

test("旧文件不存在时什么都不做", async () => {
  expect(await migrateJiraBindings()).toEqual({ migrated: 0 });
  expect(await readItems()).toEqual([]);
});

test("每个不同的单号建一张单，标题先用单号", async () => {
  await writeOldBindings({
    跑测试: { key: "EXAMPLE-1", sessionId: "$1", boundAt: 1 },
    改代码: { key: "EXAMPLE-1", sessionId: "$2", boundAt: 2 },
    另一件: { key: "EXAMPLE-2", sessionId: "$3", boundAt: 3 },
  });

  expect(await migrateJiraBindings()).toEqual({ migrated: 3 });

  const items = await readItems();
  expect(items.length).toBe(2);
  expect(items.map((i) => i.title).sort()).toEqual(["EXAMPLE-1", "EXAMPLE-2"]);
  expect(items.every((i) => i.source?.provider === "jira")).toBe(true);
});

test("绑定搬进内核，一张单下的两个会话都在", async () => {
  await writeOldBindings({
    跑测试: { key: "EXAMPLE-1", sessionId: "$1", boundAt: 1 },
    改代码: { key: "EXAMPLE-1", sessionId: "$2", boundAt: 2 },
  });
  await migrateJiraBindings();

  const bindings = await readBindings();
  const items = await readItems();
  const id = items[0]!.id;
  expect(bindings["跑测试"]?.itemId).toBe(id);
  expect(bindings["改代码"]?.itemId).toBe(id);
  expect(bindings["跑测试"]?.sessionId).toBe("$1");
});

// 幂等：items.json 已存在就整个跳过，绝不重复建单。
test("再跑一次不重复建单", async () => {
  await writeOldBindings({ 甲: { key: "EXAMPLE-1", sessionId: "$1", boundAt: 1 } });
  await migrateJiraBindings();
  expect(await migrateJiraBindings()).toEqual({ migrated: 0 });
  expect((await readItems()).length).toBe(1);
});

test("不删旧文件——留一版回退证据", async () => {
  await writeOldBindings({ 甲: { key: "EXAMPLE-1", sessionId: "$1", boundAt: 1 } });
  await migrateJiraBindings();
  expect(await Bun.file(join(root, "jira", "bindings.json")).exists()).toBe(true);
});

test("旧文件坏了就当没有，不抛", async () => {
  await writeFile(join(root, "jira", "bindings.json"), "{ not json");
  expect(await migrateJiraBindings()).toEqual({ migrated: 0 });
});
```

- [ ] **Step 2: 跑一次确认它红**

Run: `bun test src/migrate-items.test.ts`
Expected: FAIL，报 `Cannot find module './migrate-items'`

- [ ] **Step 3: 写最小实现**

创建 `src/migrate-items.ts`：

```ts
import { join } from "node:path";
import { readJson } from "./json-store";
import { itemsPath, ensureItemForSource } from "./items";
import { bindSession } from "./session-binding";
import { pluginStateDir } from "../plugins/state";

/**
 * 把 Jira 插件私有的那份绑定搬进内核。
 *
 * 一次性、幂等：`items.json` 一旦存在就整个跳过。判据用文件是否存在而不是"有没有
 * 内容"，因为一个空的 items.json 是用户把单全归档掉的正当结果，再迁一次会把已经
 * 删掉的单变回来。
 *
 * **不删旧文件。** 留一版回退证据：迁移出了问题时，那份文件是唯一能对照的东西。
 */

type OldBinding = { key: string; sessionId: string; boundAt: number };

export async function migrateJiraBindings(): Promise<{ migrated: number }> {
  if (await Bun.file(itemsPath()).exists()) return { migrated: 0 };

  const oldPath = join(pluginStateDir("jira"), "bindings.json");
  const old = await readJson<Record<string, OldBinding>>(oldPath, {}, (raw) => {
    const data = raw as Record<string, unknown>;
    const out: Record<string, OldBinding> = {};
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
  });

  const entries = Object.entries(old);
  if (!entries.length) return { migrated: 0 };

  // 串行而不是 Promise.all：ensureItemForSource 与 bindSession 各自排队，但同一个
  // 单号的两个会话必须先后跑，否则两次 ensure 都在对方写盘之前读到空表。
  let migrated = 0;
  for (const [session, binding] of entries) {
    const item = await ensureItemForSource("jira", binding.key, binding.key);
    await bindSession(session, item.id, binding.sessionId);
    migrated += 1;
  }
  return { migrated };
}
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `bun test src/migrate-items.test.ts && bun run typecheck`
Expected: 6 个测试 PASS

**若「再跑一次不重复建单」是红的**，说明 `ensureItemForSource` 里的查找-建立不在同一个队列任务里——回 Task 2 检查，不要在迁移这边加去重绕过去。

- [ ] **Step 5: 提交**

```bash
git add src/migrate-items.ts src/migrate-items.test.ts
git commit -m "feat: 一次性把 Jira 插件的绑定迁进内核，幂等且不删旧文件"
```

---

### Task 6: `/api/items` 与会话列表带上 itemId

**Files:**
- Modify: `src/server.ts`（新路由；`/api/sessions` 的 GET 响应）
- Test: `src/items-api.test.ts`

**Interfaces:**
- Consumes: Task 2、4、5 的全部导出
- Produces:
  - `GET /api/items` → `{ items: WorkItem[], bindings: ResolvedBinding[] }`
  - `POST /api/items` body `{ title, cwd?, source? }` → `WorkItem`（201）
  - `PATCH /api/items/:id` body 为 patch → `WorkItem`（404 若不存在）
  - `POST /api/items/:id/bind` body `{ session }` → `{ ok: true }`
  - `DELETE /api/items/bind?session=<name>` → `{ ok: true }`
  - `GET /api/sessions` 响应新增 `itemId: string | null`（每条 session 上）与顶层 `items: WorkItem[]`

- [ ] **Step 1: 写下会失败的测试**

创建 `src/items-api.test.ts`。起真服务器，照 `src/server.test.ts` 的做法——**环境变量在 `import { startServer }` 之前设好**，因为那些路径是在函数体里现读的，模块加载顺序只要求"第一次调用之前"：

```ts
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 绝不碰用户的 ~/.tmux-next/。路径在函数体里现读，所以设在 import 之前就够。
const stamp = Math.random().toString(36).slice(2, 10);
process.env.TMUX_NEXT_ITEMS_PATH = join(tmpdir(), `items-test-${stamp}.json`);
process.env.TMUX_NEXT_BINDINGS_PATH = join(tmpdir(), `bindings-test-${stamp}.json`);

import { rm } from "node:fs/promises";
import { startServer } from "./server";

let server: { stop(): void; port: number };
const at = (path: string) => `http://127.0.0.1:${server.port}${path}`;

const json = (path: string, method: string, body: unknown) =>
  fetch(at(path), {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function makeItem(title: string, extra: Record<string, unknown> = {}) {
  const res = await json("/api/items", "POST", { title, ...extra });
  return (await res.json()) as { id: string; title: string; createdAt: number };
}

beforeAll(() => {
  server = startServer(0);
});

afterAll(async () => {
  server.stop();
  await rm(process.env.TMUX_NEXT_ITEMS_PATH!, { force: true });
  await rm(process.env.TMUX_NEXT_BINDINGS_PATH!, { force: true });
});

// 这些路由都读同一份文件，每条测试从空表开始。
afterEach(async () => {
  await rm(process.env.TMUX_NEXT_ITEMS_PATH!, { force: true });
  await rm(process.env.TMUX_NEXT_BINDINGS_PATH!, { force: true });
});

test("空的时候给空表", async () => {
  const res = await fetch(at("/api/items"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ items: [], bindings: [] });
});

test("建单返回 201 与建出来的单", async () => {
  const res = await json("/api/items", "POST", { title: "修登录页", cwd: "/tmp/x" });
  expect(res.status).toBe(201);
  const item = (await res.json()) as { id: string; title: string; cwd: string };
  expect(item.title).toBe("修登录页");
  expect(item.cwd).toBe("/tmp/x");
  expect(item.id).toMatch(/^it-/);
});

test("没有 title 的建单请求被拒", async () => {
  const res = await json("/api/items", "POST", { cwd: "/tmp/x" });
  expect(res.status).toBe(400);
});

test("只有空白的 title 也被拒", async () => {
  const res = await json("/api/items", "POST", { title: "   " });
  expect(res.status).toBe(400);
});

test("坏 JSON body 被拒而不是 500", async () => {
  const res = await json("/api/items", "POST", "{ not json");
  expect(res.status).toBe(400);
});

test("建出来的单在列表里", async () => {
  const created = await makeItem("甲");
  const body = (await (await fetch(at("/api/items"))).json()) as { items: { id: string }[] };
  expect(body.items.map((i) => i.id)).toEqual([created.id]);
});

test("改标题", async () => {
  const created = await makeItem("旧");
  const res = await json(`/api/items/${created.id}`, "PATCH", { title: "新" });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { title: string }).title).toBe("新");
});

test("改不存在的单给 404", async () => {
  const res = await json("/api/items/it-nope", "PATCH", { title: "x" });
  expect(res.status).toBe(404);
});

// 归档走的是同一条 PATCH，不是一条删除路由——单不删，只是从默认视图收起来。
test("归档写得进 closedAt", async () => {
  const created = await makeItem("甲");
  const res = await json(`/api/items/${created.id}`, "PATCH", { closedAt: 1787000000 });
  expect(((await res.json()) as { closedAt: number }).closedAt).toBe(1787000000);
});

// 只挑允许改的字段，绝不把请求体整个 assign 进去。
test("patch 里的 id 与 createdAt 被忽略", async () => {
  const created = await makeItem("甲");
  const res = await json(`/api/items/${created.id}`, "PATCH", {
    id: "it-hijack",
    createdAt: 0,
    title: "乙",
  });
  const next = (await res.json()) as { id: string; createdAt: number; title: string };
  expect(next.id).toBe(created.id);
  expect(next.createdAt).toBe(created.createdAt);
  expect(next.title).toBe("乙");
});

test("绑到不存在的单给 404", async () => {
  const res = await json("/api/items/it-nope/bind", "POST", { session: "whatever" });
  expect(res.status).toBe(404);
});

test("绑到不存在的会话给 404", async () => {
  const created = await makeItem("甲");
  const res = await json(`/api/items/${created.id}/bind`, "POST", {
    session: `no-such-session-${stamp}`,
  });
  expect(res.status).toBe(404);
});

test("解绑没绑过的会话也返回 ok", async () => {
  const res = await fetch(at("/api/items/bind?session=nobody"), { method: "DELETE" });
  expect(res.status).toBe(200);
});

test("/api/sessions 带上 items 与每条会话的 itemId", async () => {
  const body = (await (await fetch(at("/api/sessions"))).json()) as {
    sessions: { itemId: string | null }[];
    items: unknown[];
  };
  expect(Array.isArray(body.items)).toBe(true);
  for (const s of body.sessions) expect(s.itemId).toBeNull();
});
```

绑定路由的测试要真会话才有意义（会话必须活着才 `live: true`），放进 Task 8 的集成测试；这里只测 store 之上的 HTTP 形状。

- [ ] **Step 2: 跑一次确认它红**

Run: `bun test src/items-api.test.ts`
Expected: FAIL —— `/api/items` 落到 404

- [ ] **Step 3: 写路由**

在 `src/server.ts` 里，紧挨着现有 `/api/sessions` 那几条之后加。**保持现有风格：单个 `fetch` 里按 pathname 分派，没有路由表。**

```ts
      if (url.pathname === "/api/items" && req.method === "GET") {
        const [items, live] = await Promise.all([readItems(), listSessions()]);
        const bindings = await resolveBindings(
          live.map((s) => ({ name: s.name, sessionId: s.sessionId })),
        );
        return Response.json({ items, bindings });
      }

      if (url.pathname === "/api/items" && req.method === "POST") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return new Response("bad json", { status: 400 });
        }
        const b = body as Record<string, unknown>;
        const title = typeof b?.title === "string" ? b.title.trim() : "";
        if (!title) return new Response("missing title", { status: 400 });
        const item = await createItem({
          title: title.slice(0, 200),
          cwd: typeof b.cwd === "string" ? b.cwd : null,
          source:
            typeof (b.source as any)?.provider === "string" &&
            typeof (b.source as any)?.ref === "string"
              ? { provider: (b.source as any).provider, ref: (b.source as any).ref }
              : null,
        });
        return Response.json(item, { status: 201 });
      }
```

`PATCH /api/items/:id`：**只挑允许改的字段**，绝不把请求体整个 `Object.assign` 进去——`id` 与 `createdAt` 必须挡住。

```ts
      const itemPatch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
      if (itemPatch && req.method === "PATCH") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return new Response("bad json", { status: 400 });
        }
        const b = body as Record<string, unknown>;
        const patch: Parameters<typeof updateItem>[1] = {};
        if (typeof b.title === "string" && b.title.trim()) patch.title = b.title.trim().slice(0, 200);
        if (typeof b.cwd === "string" || b.cwd === null) patch.cwd = (b.cwd as string) ?? null;
        if (Array.isArray(b.tags)) patch.tags = b.tags.filter((t): t is string => typeof t === "string");
        if (typeof b.closedAt === "number" || b.closedAt === null) patch.closedAt = b.closedAt as number | null;
        const next = await updateItem(decodeURIComponent(itemPatch[1]!), patch);
        if (!next) return new Response("no such item", { status: 404 });
        return Response.json(next);
      }
```

绑定两条：

```ts
      const itemBind = url.pathname.match(/^\/api\/items\/([^/]+)\/bind$/);
      if (itemBind && req.method === "POST") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return new Response("bad json", { status: 400 });
        }
        const session = (body as Record<string, unknown>)?.session;
        if (typeof session !== "string" || !session) {
          return new Response("missing session", { status: 400 });
        }
        const id = decodeURIComponent(itemBind[1]!);
        const items = await readItems();
        if (!items.some((i) => i.id === id)) return new Response("no such item", { status: 404 });
        // 会话必须真的在，否则绑定会指向一个从没存在过的名字。
        const live = await listSessions();
        const found = live.find((s) => s.name === session);
        if (!found) return new Response("no such session", { status: 404 });
        await bindSession(session, id, found.sessionId);
        return Response.json({ ok: true });
      }

      if (url.pathname === "/api/items/bind" && req.method === "DELETE") {
        const session = url.searchParams.get("session");
        if (!session) return new Response("missing session", { status: 400 });
        await unbindSession(session);
        return Response.json({ ok: true });
      }
```

**注意分派顺序**：`/api/items/bind` 这条 DELETE 必须写在 `^/api/items/([^/]+)$` 的 PATCH 之前，否则 `bind` 会被当成一个 item id。（DELETE 与 PATCH 方法不同，实际不会撞，但顺序写对省掉一次将来的踩坑。）

`GET /api/sessions` 改为带上单：

```ts
      if (url.pathname === "/api/sessions" && req.method === "GET") {
        const sessions = await listSessions();
        const [items, bindings] = await Promise.all([
          readItems(),
          resolveBindings(sessions.map((s) => ({ name: s.name, sessionId: s.sessionId }))),
        ]);
        const itemOf = new Map(bindings.map((b) => [b.session, b.itemId]));
        // 插件贴的只读标注。拿不到就没有，列表照常出——失败语义只有这一种。
        const annotations = await collectAnnotations(sessions.map((s) => s.name));
        return Response.json({
          sessions: sessions.map((s) => ({ ...s, itemId: itemOf.get(s.name) ?? null })),
          items,
          annotations,
        });
      }
```

启动时跑一次迁移：在 `src/server.ts` 启动路径里（跟 `reapOrphanWebSessions` 同一处），`await migrateJiraBindings()`，包在 `try/catch` 里——迁移失败不能挡住服务器起来。

- [ ] **Step 4: 跑测试确认全绿**

Run: `bun test src/items-api.test.ts && bun run typecheck`
Expected: 14 个测试 PASS

- [ ] **Step 5: 跑全量**

Run: `bun test`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add src/server.ts src/items-api.test.ts
git commit -m "feat: /api/items 与绑定路由，会话列表带上所属单"
```

---

### Task 7: Jira 插件删掉私有绑定，三条路由改成落在内核 store 上的垫片

这一期**不动 `plugins/jira/public/jira.js` 一行**。它现在打的 `GET/POST/DELETE /api/jira/bindings` 保持同样的请求与响应形状，只是背后换成内核 store。理由是避免"同一个事实有两个写者"——那会让两个页面对同一个会话给出不同说法，而不是留一份将来再收拾的债。

`annotate` 删掉：它唯一的消费者是会话列表那行文字，Task 8 换成内核数据。删掉之后 `collectAnnotations` 暂时没有消费者——它连同测试一起保留，第 2 期原地泛化成 `enrich`。

**Files:**
- Delete: `plugins/jira/bindings.ts`、`plugins/jira/bindings.test.ts`、`plugins/jira/sessions.ts`
- Modify: `plugins/jira/server.ts`（三条绑定路由改写；删掉 `annotate` 导出）、`plugins/handlers.ts`（jira 那行去掉 `annotate`）
- Test: `plugins/jira/bindings-shim.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `readItems` / `ensureItemForSource`，Task 4 的 `resolveBindings` / `bindSession` / `unbindSession`
- Produces: `/api/jira/bindings` 三条路由形状不变（`GET` → `{ session, key, live }[]`）

- [ ] **Step 1: 写下会失败的测试**

创建 `plugins/jira/bindings-shim.test.ts`：

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jiraBindingsView, claimIssue } from "./server";
import { readItems } from "../../src/items";
import { readBindings } from "../../src/session-binding";

/**
 * 垫片只做翻译：内核存的是 itemId，Jira 页认的是单号。翻译发生在这里，是为了让
 * 同一个事实只有一个写者——否则两个页面会对同一个会话给出不同说法。
 */

let root: string;
const saved: Record<string, string | undefined> = {};
const VARS = ["TMUX_NEXT_ITEMS_PATH", "TMUX_NEXT_BINDINGS_PATH"];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "shim-"));
  for (const v of VARS) saved[v] = process.env[v];
  process.env.TMUX_NEXT_ITEMS_PATH = join(root, "items.json");
  process.env.TMUX_NEXT_BINDINGS_PATH = join(root, "bindings.json");
});

afterEach(async () => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v]!;
  }
  await rm(root, { recursive: true, force: true });
});

test("认领一个单号会建出一张挂了来源的单，并绑上会话", async () => {
  await claimIssue("跑测试", "EXAMPLE-1", "$1");
  const items = await readItems();
  expect(items.length).toBe(1);
  expect(items[0]!.source).toEqual({ provider: "jira", ref: "EXAMPLE-1" });
  expect((await readBindings())["跑测试"]?.itemId).toBe(items[0]!.id);
});

test("同一个单号的第二个会话不再建单", async () => {
  await claimIssue("跑测试", "EXAMPLE-1", "$1");
  await claimIssue("改代码", "EXAMPLE-1", "$2");
  expect((await readItems()).length).toBe(1);
});

test("视图把 itemId 翻回单号", async () => {
  await claimIssue("跑测试", "EXAMPLE-1", "$1");
  const view = await jiraBindingsView([{ name: "跑测试", sessionId: "$1" }]);
  expect(view).toEqual([{ session: "跑测试", key: "EXAMPLE-1", live: true }]);
});

test("没有 jira 来源的单不出现在这个视图里", async () => {
  const { createItem } = await import("../../src/items");
  const local = await createItem({ title: "本地的活" });
  const { bindSession } = await import("../../src/session-binding");
  await bindSession("随手开的", local.id, "$9");
  const view = await jiraBindingsView([{ name: "随手开的", sessionId: "$9" }]);
  expect(view).toEqual([]);
});

test("会话没了仍然列出来，live 为 false", async () => {
  await claimIssue("跑测试", "EXAMPLE-1", "$1");
  expect(await jiraBindingsView([])).toEqual([
    { session: "跑测试", key: "EXAMPLE-1", live: false },
  ]);
});
```

- [ ] **Step 2: 跑一次确认它红**

Run: `bun test plugins/jira/bindings-shim.test.ts`
Expected: FAIL —— `jiraBindingsView` / `claimIssue` 未导出

- [ ] **Step 3: 改实现**

在 `plugins/jira/server.ts` 里加这两个导出，并把三条路由改成调它们：

```ts
/**
 * 内核的绑定，翻译成 Jira 页认得的形状。
 *
 * 只挑 source 是 jira 的单——本地单与将来别家来源的单不属于这个视图。翻译放在
 * 插件这边而不是内核那边，是因为"itemId ↔ 单号"是 Jira 的语言，内核不认识它。
 */
export async function jiraBindingsView(
  live: Array<{ name: string; sessionId: string }>,
): Promise<Array<{ session: string; key: string; live: boolean }>> {
  const [items, bindings] = await Promise.all([readItems(), resolveBindings(live)]);
  const keyOf = new Map(
    items.filter((i) => i.source?.provider === "jira").map((i) => [i.id, i.source!.ref]),
  );
  const out: Array<{ session: string; key: string; live: boolean }> = [];
  for (const b of bindings) {
    const key = keyOf.get(b.itemId);
    if (!key) continue;
    out.push({ session: b.session, key, live: b.live });
  }
  return out;
}

/** 认领：这个单号还没有单就建一张，然后把会话绑上去。 */
export async function claimIssue(
  session: string,
  key: string,
  sessionId: string,
): Promise<void> {
  const item = await ensureItemForSource("jira", key, key);
  await bindSession(session, item.id, sessionId);
}
```

三条路由改写：`GET` 调 `jiraBindingsView(await liveFromKernel())`（`liveFromKernel` 用内核的 `listSessions()` 映射出 `{name, sessionId}`——`plugins/jira/sessions.ts` 那次单独的 `list-sessions` 因此删掉）；`POST` 调 `claimIssue`；`DELETE` 调内核的 `unbindSession`。

删掉 `annotate` 的导出与它的实现；`plugins/handlers.ts` 里 jira 那行改成 `jira: { handle: jira }`。

删除三个文件：

```bash
git rm plugins/jira/bindings.ts plugins/jira/bindings.test.ts plugins/jira/sessions.ts
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `bun test plugins/ && bun run typecheck`
Expected: PASS，包括 `plugins/registry.test.ts`（注册表与 SERVERS 双向同步那条）

- [ ] **Step 5: 手工验一次真页面**

**不能靠推断。** `src/` 是启动时加载一次的，Bun 没有 `--watch` 就不会重载——跑着的服务器常常是一半新一半旧。所以：**重启服务器**，然后：

```bash
bun run src/index.ts &
sleep 2
curl -s localhost:7682/api/jira/bindings | head -5
curl -s localhost:7682/api/items | head -20
```

打开 `/p/jira/`，确认工单页上的会话分组还在、能开会话、能解除绑定。

- [ ] **Step 6: 提交**

```bash
git add -A plugins/ && git commit -m "refactor: Jira 的绑定交回内核，插件侧只留单号翻译"
```

---

### Task 8: 会话列表每行显示所属单

**Files:**
- Modify: `public/list.js`（渲染）、`public/i18n.js`（两条新键）
- Test: `src/list-page.test.ts`（已存在，追加）

**Interfaces:**
- Consumes: Task 6 的 `GET /api/sessions` 响应新形状 `{ sessions, items, annotations }`

- [ ] **Step 1: 加 i18n 键**

`public/i18n.js`，`zh` 与 `en` **两边都要加**，缺一边 `src/i18n.test.ts` 就红：

```js
  // zh
  "list.itemOf": "属于",
  "list.noItem": "未归单",
```

```js
  // en
  "list.itemOf": "Part of",
  "list.noItem": "No work item",
```

- [ ] **Step 2: 写下会失败的测试**

`src/list-page.test.ts` 已经有一套 happy-dom 脚手架（`mount()` / `stubFetch()` / `PATCHED` 还原表）。**先读它**，然后做两件事。

一、`stubFetch` 现在给 `api/sessions` 回一个裸数组，服务器已改成回对象。把它改成能带上单：

```ts
function stubFetch(sessions: unknown[], restorable: unknown[] = [], items: unknown[] = []) {
  return (async (u: unknown, init?: RequestInit) => {
    const url = String(u);
    if (init?.method === "POST") {
      posted.push({ url, body: String(init.body ?? "") });
      if (url.includes("api/restore")) return new Response(JSON.stringify({ restored: 1 }));
    }
    // 新形状：{ sessions, items, annotations }。裸数组那条兼容分支留在 list.js 里，
    // 因为装成 PWA 的旧页面会打到新服务器，反过来也会。
    if (url.includes("api/sessions"))
      return new Response(JSON.stringify({ sessions, items, annotations: {} }));
    if (url.includes("api/restorable")) return new Response(JSON.stringify(restorable));
    if (url.includes("api/language")) return new Response(JSON.stringify({ lang: "en" }));
    if (url.includes("api/version"))
      return new Response(JSON.stringify({ version: "0.0.0", build: "test" }));
    return new Response("{}");
  }) as typeof fetch;
}
```

`mount()` 跟着多一个参数并传下去：

```ts
async function mount(
  sessions: unknown[],
  store: Record<string, string> = {},
  restorable: unknown[] = [],
  items: unknown[] = [],
) {
  // …原样，只把 stubFetch(sessions, restorable) 改成 stubFetch(sessions, restorable, items)
}
```

**已有的那些测试一条都不该改**——`items` 有默认值，`sessions` 仍然是第一个参数。跑一遍确认它们仍绿，再往下写。

二、追加三条：

```ts
const ITEM = {
  id: "it-1",
  title: "把登录页的报错文案改掉",
  cwd: "/Users/x/projects/app",
  source: { provider: "jira", ref: "EXAMPLE-1" },
  tags: [],
  createdAt: NOW - 3600,
  closedAt: null,
};

test("绑了单的会话行上显示单标题", async () => {
  const root = await mount([session({ name: "orbit", itemId: "it-1" })], {}, [], [ITEM]);
  expect(root.querySelector(".item-chip")?.textContent).toContain("把登录页的报错文案改掉");
});

test("没绑单的会话不画标记，也不炸", async () => {
  const root = await mount([session({ name: "orbit", itemId: null })], {}, [], [ITEM]);
  expect(root.querySelector(".name")?.textContent).toBe("orbit");
  expect(root.querySelector(".item-chip")).toBeNull();
});

// 绑定指向一张已经归档并被清掉的单时，渲染不能抛——抛了会吞掉整页，而不是少一个标记。
test("itemId 指向一张不在 items 里的单时，当作没绑", async () => {
  const root = await mount([session({ name: "orbit", itemId: "it-gone" })], {}, [], [ITEM]);
  expect(root.querySelector(".name")?.textContent).toBe("orbit");
  expect(root.querySelector(".item-chip")).toBeNull();
});
```

`session()` 那个工厂要加一个默认字段 `itemId: null`，跟服务器的新形状对齐。

- [ ] **Step 3: 跑一次确认它红**

Run: `bun test src/list-page.test.ts`
Expected: FAIL —— 找不到单标题

- [ ] **Step 4: 改实现**

`public/list.js` 里，接响应的地方从

```js
    const { sessions, annotations } = Array.isArray(body)
      ? { sessions: body, annotations: {} }
```

扩成同时接住 `items`（旧服务器不返回它，落回 `[]`——这个兼容分支现在就在那里，保持它）。渲染时用一个 `Map(items.map(i => [i.id, i]))` 查标题；`itemId` 为 null 或查不到就**什么都不画**，不画"未归单"字样——会话列表这一期还不是单驱动的，一个空标记只是噪声。`list.noItem` 这条键留给第 2 期的首页用。

样式加在 `public/style.css`，**颜色只能用主题变量**，`src/themes.test.ts` 会拦住字面量。

- [ ] **Step 5: 跑测试确认全绿**

Run: `bun test src/list-page.test.ts src/i18n.test.ts src/themes.test.ts src/public-parses.test.ts`
Expected: 全 PASS

- [ ] **Step 6: 手工验一眼**

重启服务器（前端是直出磁盘的，后端不是），开首页，确认绑了单的会话行上有标题、没绑的照常。

- [ ] **Step 7: 提交**

```bash
git add public/list.js public/i18n.js public/style.css src/list-page.test.ts
git commit -m "feat: 会话行显示所属单，数据来自内核绑定"
```

---

### Task 9: 真 tmux 的集成测试与收尾

**Files:**
- Create: `src/binding.integration.test.ts`
- Modify: `CLAUDE.md`（新的状态路径与概念）、`README.md` 与 `README.zh-CN.md`（两边同步）

- [ ] **Step 1: 写集成测试**

创建 `src/binding.integration.test.ts`。**清理规矩照抄仓库现有的集成测试**：只杀本轮建过并记在数组里的名字，一律用 `=<确切名字>`，绝不 `kill-server`。

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmux } from "./tmux/run";
import { listSessions } from "./tmux/session-list";
import { bindSession, resolveBindings, readBindings } from "./session-binding";
import { createItem } from "./items";

// 只清理这里面的名字。绝不 kill-server，绝不按前缀杀。
const created: string[] = [];
let root: string;
const saved: Record<string, string | undefined> = {};
const VARS = ["TMUX_NEXT_ITEMS_PATH", "TMUX_NEXT_BINDINGS_PATH"];

function name(suffix: string) {
  return `itest-${process.pid}-${suffix}`;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bind-itest-"));
  for (const v of VARS) saved[v] = process.env[v];
  process.env.TMUX_NEXT_ITEMS_PATH = join(root, "items.json");
  process.env.TMUX_NEXT_BINDINGS_PATH = join(root, "bindings.json");
});

afterEach(async () => {
  for (const n of created.splice(0)) {
    // 先确认它确实存在、确实是我们建的那个名字，读到结果之后才杀。
    const has = await tmux(["has-session", "-t", `=${n}`]);
    if (has.ok) await tmux(["kill-session", "-t", `=${n}`]);
  }
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v]!;
  }
  await rm(root, { recursive: true, force: true });
});

test("建会话、绑定、改名之后仍然认得回来", async () => {
  const first = name("a");
  await tmux(["new-session", "-d", "-s", first]);
  created.push(first);

  const live = await listSessions();
  const mine = live.find((s) => s.name === first);
  expect(mine).toBeDefined();
  expect(mine!.sessionId).toMatch(/^\$\d+$/);

  const item = await createItem({ title: "集成测试的单" });
  await bindSession(first, item.id, mine!.sessionId);

  const renamed = name("b");
  await tmux(["rename-session", "-t", `=${first}`, renamed]);
  created.splice(created.indexOf(first), 1);
  created.push(renamed);

  const after = await listSessions();
  const resolved = await resolveBindings(
    after.map((s) => ({ name: s.name, sessionId: s.sessionId })),
  );
  const hit = resolved.find((b) => b.itemId === item.id);
  expect(hit).toEqual({ session: renamed, itemId: item.id, live: true });

  // 记录迁到了新名字下，不是每次都靠 id 重认。
  expect((await readBindings())[renamed]).toBeDefined();
  expect((await readBindings())[first]).toBeUndefined();
});

test("会话被杀之后绑定还在，只是 live 为 false", async () => {
  const n = name("c");
  await tmux(["new-session", "-d", "-s", n]);
  created.push(n);
  const live = await listSessions();
  const mine = live.find((s) => s.name === n)!;
  const item = await createItem({ title: "会被杀掉的" });
  await bindSession(n, item.id, mine.sessionId);

  const has = await tmux(["has-session", "-t", `=${n}`]);
  expect(has.ok).toBe(true); // 读到结果之后才杀
  await tmux(["kill-session", "-t", `=${n}`]);
  created.splice(created.indexOf(n), 1);

  const after = await listSessions();
  const resolved = await resolveBindings(
    after.map((s) => ({ name: s.name, sessionId: s.sessionId })),
  );
  expect(resolved.find((b) => b.itemId === item.id)).toEqual({
    session: n,
    itemId: item.id,
    live: false,
  });
});
```

- [ ] **Step 2: 跑它**

Run: `bun test src/binding.integration.test.ts`
Expected: 2 个测试 PASS

- [ ] **Step 3: 跑全量 + typecheck**

Run: `bun run test`
Expected: 全绿。红了就读输出——孤儿会话那几条断言按 pid 收窄过，红说明是真问题。

- [ ] **Step 4: 更新文档**

`CLAUDE.md`：在「Every on-disk state path is env-overridable」那一段的路径清单里加 `TMUX_NEXT_ITEMS_PATH`、`TMUX_NEXT_BINDINGS_PATH`。在 Architecture 里加一段讲「单」是内核概念、绑定为什么按会话作键、为什么 `#{session_id}` 现在进了内核的 `LIST_FORMAT`（并说明当年那条「不要为一个插件的需要加字段」的禁令为何不再适用）。

`README.md` 与 `README.zh-CN.md`：**两边同步**，说明 `~/.tmux-next/items.json` 与 `bindings.json` 是什么、首次启动会从 Jira 插件那份绑定迁移一次且不删旧文件。

- [ ] **Step 5: 提交**

```bash
git add src/binding.integration.test.ts CLAUDE.md README.md README.zh-CN.md
git commit -m "test: 绑定跨改名与会话消亡的集成测试；文档记下新的状态路径"
```

---

## 第 1 期完成的判据

全部满足才算完：

- [ ] `bun run test` 全绿（typecheck + 全量测试）
- [ ] `~/.tmux-next/items.json` 与 `~/.tmux-next/bindings.json` 在真实运行后存在且 `cat` 得出人看得懂的内容
- [ ] 原本在 Jira 页上绑好的会话，迁移后仍然显示在对应工单下——**重启服务器之后**验证，不靠推断
- [ ] `plugins/jira/bindings.ts`、`plugins/jira/sessions.ts` 已删除，`plugins/registry.test.ts` 仍绿
- [ ] 会话列表每行显示所属单
- [ ] 提交历史里没有任何助手署名 trailer

## 不属于第 1 期

- 首页换成单列表、facet、group-by 与筛选 —— 第 2 期
- `annotate` → `enrich` 接缝改造与 Jira 插件贡献 facet —— 第 2 期
- 新建流程改成先选单、「未归单」的「归到…」、Jira tab 改成候选单页 —— 第 3 期
