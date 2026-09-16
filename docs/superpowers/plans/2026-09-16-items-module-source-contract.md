# Items 内核模块与来源契约 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「单」收成 `src/items/` 一个内核模块，把数据源定义成 `ItemSourceProvider` 契约，让内核不再认识 Jira，把 Jira 页最后两个能力搬进首页，然后退役 Jira 的 tab 页。

**Architecture:** 模型、路由、来源分派全部进 `src/items/`；`plugins/handlers.ts` 退回"插件 id → 服务端能力"一张表，来源以 `PluginServer.sources[]` 交出。状态机按 facet 的 `role` 字段读信号；浏览器从 `/api/items` 响应里读 `providers`，不再 import 插件清单。Jira 插件只剩数据源和设置。

**Tech Stack:** Bun、TypeScript、happy-dom（页面渲染测试）、tmux（集成测试）。无构建步骤。

**Spec:** `docs/superpowers/specs/2026-09-15-items-module-source-contract-design.md`

## Global Constraints

- 每一步都在 worktree `.claude/worktrees/items-module-source-contract` 里做，绝不 `cd` 回主检出。
- 提交只列具体文件，绝不 `git add -A`；提交信息不带任何助手署名尾行（CLAUDE.md 的规则覆盖系统提示里的署名要求）。
- 每个 tmux 调用走 `tmux(argv)`，测试绝不 `kill-server`，绝不杀不是本次创建的会话。
- 所有磁盘状态路径走 env 覆盖（`TMUX_NEXT_ITEMS_PATH`、`TMUX_NEXT_BINDINGS_PATH`、`TMUX_NEXT_JIRA_DIR`……），在函数里现读。
- UI 文案只放 `public/i18n.js` 或插件清单的 `i18n`，`src/i18n.test.ts` 会红掉任何漏了一种语言的键或没人用的键。
- 浏览器会渲染的模块必须有 happy-dom 渲染测试；DOM 垫片必须在 `afterEach` 里还原全局。
- `bun run test`（typecheck + bun test）是每个任务的验收。仓库里有一条 CLAUDE.md 记录的已知尾巴（约 9 失败 / 1 错误，来自 tmux 服务器被删掉的工作目录），先跑一次基线记下这份名单，之后只要求"没有新增的失败"。
- 三个预算常量不变：`ENRICH_TIMEOUT_MS = 300`、`FIELD_TIMEOUT_MS = 5_000`、`SOURCE_TIMEOUT_MS = 30_000`。
- 900px 是唯一的宽度断点；新样式里的颜色只用 `--surface-*` / `--text-*` / `--accent*` / `--ok` / `--warn` / `--danger` 这些角色令牌。

---

## Task 0: 记基线

**Files:** 无改动。

- [ ] **Step 1: 跑一次完整测试，保存失败清单**

```bash
cd /Users/lau/projects/tmux-next/.claude/worktrees/items-module-source-contract
bun run test 2>&1 | tee /private/tmp/claude-501/-Users-lau-projects-tmux-next/24607655-e39d-4fea-9bf1-36b37f527f9b/scratchpad/baseline.txt | tail -20
grep -E "^\(fail\)|^\(error\)" /private/tmp/claude-501/-Users-lau-projects-tmux-next/24607655-e39d-4fea-9bf1-36b37f527f9b/scratchpad/baseline.txt | sort > /private/tmp/claude-501/-Users-lau-projects-tmux-next/24607655-e39d-4fea-9bf1-36b37f527f9b/scratchpad/baseline-fails.txt
wc -l /private/tmp/claude-501/-Users-lau-projects-tmux-next/24607655-e39d-4fea-9bf1-36b37f527f9b/scratchpad/baseline-fails.txt
```

Expected: typecheck 通过；失败条目只来自 CLAUDE.md 描述的 tmux 工作目录尾巴（`pwd` 失败那类）。后面每个任务结束时用同一条 grep 比对，新增的失败才算这一任务的失败。

---

## Task 1: 模型文件搬进 `src/items/`

**Files:**
- Move: `src/items.ts` → `src/items/model.ts`
- Move: `src/session-binding.ts` → `src/items/binding.ts`
- Move: `src/item-lifecycle.ts` → `src/items/lifecycle.ts`
- Move: `src/item-facets.ts` → `src/items/facets.ts`
- Move: `src/item-fields.ts` → `src/items/fields.ts`
- Move: `src/migrate-items.ts` → `src/items/migrate.ts`
- Move tests: `src/items.test.ts` → `src/items/model.test.ts`；`src/session-binding.test.ts` → `src/items/binding.test.ts`；`src/item-lifecycle.test.ts` → `src/items/lifecycle.test.ts`；`src/item-facets.test.ts` → `src/items/facets.test.ts`；`src/item-fields.test.ts` → `src/items/fields.test.ts`；`src/migrate-items.test.ts` → `src/items/migrate.test.ts`；`src/items-api.test.ts` → `src/items/routes.test.ts`
- Modify: 每个 importer（下面列全）

**Interfaces:**
- Produces: 六个模块的导出**一个不变**，只是路径变了。后面的任务按新路径引用：`src/items/model.ts`（`WorkItem`、`ItemSource`、`readItems`、`createItem`、`updateItem`、`findBySource`、`ensureItemForSource`、`itemsPath`）、`src/items/binding.ts`（`Binding`、`ResolvedBinding`、`readBindings`、`bindSession`、`unbindSession`、`resolveBindings`、`bindingsPath`）、`src/items/lifecycle.ts`（`ItemStatus`、`deriveSignal`、`nextStatus`、`advanceLifecycle`、`sanitiseStatus`、`DEFAULT_ITEM_STATUS`、`LifecycleSignal`、`LifecycleTransition`）、`src/items/facets.ts`（`kernelFacets`）、`src/items/fields.ts`（`kernelFields`、`KERNEL_FIELD_KEYS`）、`src/items/migrate.ts`（`migrateJiraBindings`）。

- [ ] **Step 1: git mv 六个源文件和七个测试文件**

```bash
mkdir -p src/items
git mv src/items.ts src/items/model.ts
git mv src/session-binding.ts src/items/binding.ts
git mv src/item-lifecycle.ts src/items/lifecycle.ts
git mv src/item-facets.ts src/items/facets.ts
git mv src/item-fields.ts src/items/fields.ts
git mv src/migrate-items.ts src/items/migrate.ts
git mv src/items.test.ts src/items/model.test.ts
git mv src/session-binding.test.ts src/items/binding.test.ts
git mv src/item-lifecycle.test.ts src/items/lifecycle.test.ts
git mv src/item-facets.test.ts src/items/facets.test.ts
git mv src/item-fields.test.ts src/items/fields.test.ts
git mv src/migrate-items.test.ts src/items/migrate.test.ts
git mv src/items-api.test.ts src/items/routes.test.ts
```

- [ ] **Step 2: 改搬走的六个源文件里彼此之间和对外的 import**

搬进一层目录之后，它们引内核别的模块要多一个 `../`，彼此之间改用新文件名：

- `src/items/model.ts`：`from "./json-store"` → `from "../json-store"`；`from "./item-lifecycle"` → `from "./lifecycle"`。
- `src/items/binding.ts`：`from "./json-store"` → `from "../json-store"`；如有 `from "./tmux/..."` → `from "../tmux/..."`。
- `src/items/lifecycle.ts`：`from "../plugins/types"` → `from "../../plugins/types"`；`from "./items"` → `from "./model"`；`from "./session-binding"` → `from "./binding"`。
- `src/items/facets.ts`：`from "../plugins/types"` → `from "../../plugins/types"`；`from "./items"` → `from "./model"`；`from "./tmux/session-list"` → `from "../tmux/session-list"`；`from "./session-binding"` → `from "./binding"`。
- `src/items/fields.ts`：`from "./items"` → `from "./model"`。
- `src/items/migrate.ts`：`from "./items"` → `from "./model"`；`from "./session-binding"` → `from "./binding"`；`from "./plugin-state"`（或它实际引的 `pluginStateDir` 所在模块）→ 前面加 `../`；`from "./json-store"` → `from "../json-store"`。

每个文件打开确认，用 `grep -n "from \"" src/items/*.ts` 逐行核对。

- [ ] **Step 3: 改搬走的七个测试文件的 import**

- `src/items/model.test.ts`：`from "./items"` → `from "./model"`。
- `src/items/binding.test.ts`：`from "./session-binding"` → `from "./binding"`；`from "./items"` → `from "./model"`。
- `src/items/lifecycle.test.ts`：`from "./item-lifecycle"` → `from "./lifecycle"`；`from "../plugins/types"` → `from "../../plugins/types"`；`from "./items"` → `from "./model"`；`from "./session-binding"` → `from "./binding"`。
- `src/items/facets.test.ts`：`from "./item-facets"` → `from "./facets"`；其余同上规则。
- `src/items/fields.test.ts`：`from "./item-fields"` → `from "./fields"`；`from "./items"` → `from "./model"`。
- `src/items/migrate.test.ts`：`from "./migrate-items"` → `from "./migrate"`；`from "./items"` → `from "./model"`；`from "./session-binding"` → `from "./binding"`。
- `src/items/routes.test.ts`：`from "./server"` → `from "../server"`；`from "./session-binding"` → `from "./binding"`。文件顶部那段注释提到 `items-api.test.ts` 的地方改成 `routes.test.ts`。

- [ ] **Step 4: 改留在原地的 importer**

```bash
grep -rlE "from \"(\./|\.\./|\.\./\.\./src/)(items|session-binding|item-lifecycle|item-facets|item-fields|migrate-items)\"" src plugins
```

逐个改：

- `src/server.ts`：`"./items"` → `"./items/model"`；`"./session-binding"` → `"./items/binding"`；`"./item-facets"` → `"./items/facets"`；`"./item-lifecycle"` → `"./items/lifecycle"`；`"./item-fields"` → `"./items/fields"`。
- `src/index.ts`：`"./migrate-items"` → `"./items/migrate"`。
- `src/push.ts`：`"./item-lifecycle"` → `"./items/lifecycle"`。
- `src/binding.integration.test.ts`：`"./session-binding"` → `"./items/binding"`；`"./items"` → `"./items/model"`。
- `src/plugin-start-placement.test.ts`：如果它按文件路径读 `src/index.ts` 的源码找 `migrateJiraBindings`，路径字符串不用改；如果它 import 了 `./migrate-items`，改成 `./items/migrate`。
- `plugins/handlers.ts`：`"../src/item-lifecycle"` → `"../src/items/lifecycle"`。
- `plugins/jira/server.ts`：`"../../src/items"` → `"../../src/items/model"`；`"../../src/item-lifecycle"` → `"../../src/items/lifecycle"`；`"../../src/session-binding"` → `"../../src/items/binding"`。
- `plugins/jira/bindings-shim.test.ts`：同上三条。
- `src/template.ts`、`src/items/fields.ts` 里只有注释提到 `collectFields`，不动。

- [ ] **Step 5: typecheck 与全量测试**

```bash
bun run typecheck && bun test 2>&1 | grep -E "^\(fail\)|^\(error\)" | sort | diff - /private/tmp/claude-501/-Users-lau-projects-tmux-next/24607655-e39d-4fea-9bf1-36b37f527f9b/scratchpad/baseline-fails.txt
```

Expected: typecheck 无错；diff 为空（没有新增失败）。

- [ ] **Step 6: 提交**

```bash
git add src/items src/server.ts src/index.ts src/push.ts src/binding.integration.test.ts src/plugin-start-placement.test.ts plugins/handlers.ts plugins/jira/server.ts plugins/jira/bindings-shim.test.ts
git commit -m "Move the work-item model into src/items/

Six flat files and their tests become one directory. Exports and
behaviour are unchanged; only import paths move."
```

---

## Task 2: 路由搬进 `src/items/routes.ts`

**Files:**
- Create: `src/items/routes.ts`
- Modify: `src/server.ts`（删掉 `itemDetail`、`advanceAllLifecycles` 和全部 `/api/items*` 分支，换成一次调用）
- Test: `src/items/routes.test.ts`（已存在，不改）

**Interfaces:**
- Produces: `export async function itemsRoutes(req: Request, url: URL): Promise<Response | null>`——路径不以 `/api/items` 开头时返回 `null`。
- Produces: `export async function advanceAllLifecycles(): Promise<void>`（同步和刷新之后跑状态机）。

- [ ] **Step 1: 新建 `src/items/routes.ts`，把 server.ts 里的代码原样搬来**

从 `src/server.ts` 搬三块（用 `grep -n` 定位当前行号，下面的行号是写计划时的）：

1. `async function itemDetail(id: string)`（约 240–270 行）和它上面那段 JSDoc。
2. `async function advanceAllLifecycles()`（约 272–302 行）和它的 JSDoc。改成 `export`。
3. `fetch` 里从 `if (url.pathname === "/api/items" && req.method === "GET")` 开始，到 `PATCH /api/items/:id` 分支结束（约 398–600 行）之间**所有** `/api/items` 分支，包括 `/api/items/bind` DELETE、`/api/items/:id/bind` POST、`/api/items/sync`、`/api/items/:id/refresh`、`/api/items/:id/render`、`/api/items/by-session`、`GET /api/items/:id`、`PATCH /api/items/:id`。`/api/templates` 两条**不搬**，留在 server.ts。

文件骨架：

```ts
import { createItem, readItems, updateItem } from "./model";
import { bindSession, readBindings, resolveBindings, unbindSession } from "./binding";
import { kernelFacets } from "./facets";
import { advanceLifecycle } from "./lifecycle";
import { kernelFields } from "./fields";
import { historyForItem } from "../session-history";
import { listSessions, sessionIdentities } from "../tmux/session-list";
import { notifyLifecycle } from "../push";
import { render, sanitiseName } from "../template";
import { collectFacets, collectFields, runSync, refreshFromSource, notifyLifecycleChange } from "../../plugins/handlers";
import type { Facet } from "../../plugins/types";

/**
 * 单的全部 HTTP 路由。
 *
 * 从 server.ts 搬来，一行没改。留在这里的顺序陷阱有三个，都踩过：
 * /api/items/bind、/api/items/sync、/api/items/by-session 必须排在
 * ^/api/items/([^/]+)$ 之前，否则那条正则把 "bind"/"sync"/"by-session" 当成单号。
 * routes.test.ts 用 200 断言这个顺序，不靠注释。
 */

// …itemDetail、advanceAllLifecycles 原样贴在这里…

export async function itemsRoutes(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/items")) return null;

  // …搬来的每一个 if 分支，原样、原顺序…

  return null;
}
```

搬完后 `bun run typecheck` 会指出漏掉的 import；补齐，直到 routes.ts 自身无错。

- [ ] **Step 2: server.ts 改成一次调用**

在原来 `GET /api/items` 那个 `if` 所在的位置放：

```ts
      const itemsResponse = await itemsRoutes(req, url);
      if (itemsResponse) return itemsResponse;
```

删掉搬走的代码和 `itemDetail` / `advanceAllLifecycles` 两个函数；顶部 import 改成 `import { itemsRoutes } from "./items/routes";`，同时删掉只被搬走代码用到的 import（`createItem`、`readItems`、`updateItem`、`bindSession`、`readBindings`、`resolveBindings`、`unbindSession`、`historyForItem`、`kernelFacets`、`advanceLifecycle`、`kernelFields`、`collectFacets`、`collectFields`、`runSync`、`refreshFromSource`、`notifyLifecycleChange`、`notifyLifecycle`、`render`、`sanitiseName`——每个先 `grep -n` 确认 server.ts 里没有别的使用点再删；`KERNEL_FIELD_KEYS` 被 `/api/templates` 用，留下）。

- [ ] **Step 3: typecheck 与全量测试**

```bash
bun run typecheck && bun test src/items/routes.test.ts src/templates-api.test.ts src/items-page.test.ts 2>&1 | tail -5
bun test 2>&1 | grep -E "^\(fail\)|^\(error\)" | sort | diff - /private/tmp/claude-501/-Users-lau-projects-tmux-next/24607655-e39d-4fea-9bf1-36b37f527f9b/scratchpad/baseline-fails.txt
```

Expected: 三个文件全绿；diff 为空。

- [ ] **Step 4: 提交**

```bash
git add src/items/routes.ts src/server.ts
git commit -m "Move the /api/items routes into src/items/routes.ts

server.ts calls itemsRoutes() once where the inline branches used to be.
Route order is preserved verbatim; routes.test.ts pins it."
```

---

## Task 3: 来源契约 `ItemSourceProvider` 与分派搬进 `src/items/sources.ts`

**Files:**
- Create: `src/items/sources.ts`
- Create: `src/items/sources.test.ts`（承接 `src/plugin-enrich.test.ts`、`src/plugin-fields.test.ts`、`src/plugin-source.test.ts` 三个文件的用例）
- Delete: `src/plugin-enrich.test.ts`、`src/plugin-fields.test.ts`、`src/plugin-source.test.ts`（`startPlugins` 的用例搬到 `src/plugin-start.test.ts`）
- Create: `src/plugin-start.test.ts`
- Modify: `plugins/handlers.ts`（`PluginServer` 拆掉来源方法、加 `sources`；删掉搬走的分派与净化代码）
- Modify: `plugins/types.ts`（删 `provides`；`PluginEnricher`/`PluginFieldSource` 留着给 `sources.ts` 用）
- Modify: `plugins/jira/plugin.js`（删 `provides`）
- Modify: `plugins/jira/server.ts`（导出一个 `ItemSourceProvider`；`SyncResult` 类型改从 `sources.ts` 引）
- Modify: `src/items/routes.ts`（分派函数改从 `./sources` 引）
- Modify: `plugins/registry.test.ts`（删任何 `provides` 断言）

**Interfaces:**
- Produces（`src/items/sources.ts`）：

```ts
export type SyncResult = { created: number; updated: number; total: number; truncated: boolean };
export type ItemSourceProvider = {
  provider: string;
  sync?(opts?: { full?: boolean }): Promise<SyncResult>;
  refreshItem?(ref: string): Promise<void>;
  enrich?(items: ItemRef[]): Promise<Record<string, Facet[]>>;
  fields?(item: ItemRef): Promise<Record<string, string>>;
  onLifecycleChange?(ref: string, from: ItemStatus, to: ItemStatus): Promise<void>;
};
export const ENRICH_TIMEOUT_MS = 300;
export const FIELD_TIMEOUT_MS = 5_000;
export const SOURCE_TIMEOUT_MS = 30_000;
export const MAX_FACETS_PER_ITEM = 6;
export const MAX_DETAIL_ROWS = 20;
export const MAX_FIELDS_PER_ITEM = 12;
export const MAX_FIELD_LEN = 4000;
export function sourceProviders(servers?: Record<string, PluginServer>): ItemSourceProvider[];
export function claimedProviders(servers?: Record<string, PluginServer>): string[];
export function pluginEnrichers(servers?: Record<string, PluginServer>): PluginEnricher[];
export async function collectFacets(items: ItemRef[], sources?: ItemSourceProvider[], extra?: PluginEnricher[], cap?: number): Promise<Record<string, Facet[]>>;
export async function collectFields(item: ItemRef, sources?: ItemSourceProvider[], timeoutMs?: number): Promise<Record<string, string>>;
export async function runSync(sources?: ItemSourceProvider[], timeoutMs?: number): Promise<SyncResult>;
export async function refreshFromSource(provider: string, ref: string, sources?: ItemSourceProvider[], timeoutMs?: number): Promise<boolean>;
export async function notifyLifecycleChange(provider: string, ref: string, from: ItemStatus, to: ItemStatus, sources?: ItemSourceProvider[], timeoutMs?: number): Promise<void>;
```

- Produces（`plugins/handlers.ts`）：

```ts
export type PluginServer = {
  handle?: PluginHandler;
  start?: () => void;
  readSettings?: () => Promise<Record<string, SettingValue>>;
  writeSettings?: (values: Record<string, string | boolean>) => Promise<void>;
  runAction?: (key: string) => Promise<boolean>;
  sources?: ItemSourceProvider[];
  enrich?: PluginEnricher;   // 插件级，收到全部单
};
```

- Consumes: Task 1/2 的路径。

- [ ] **Step 1: 写 `src/items/sources.test.ts` 的第一批用例（分派规则）**

```ts
import { test, expect, afterEach } from "bun:test";
import {
  sourceProviders,
  claimedProviders,
  pluginEnrichers,
  collectFacets,
  collectFields,
  runSync,
  refreshFromSource,
  notifyLifecycleChange,
  ENRICH_TIMEOUT_MS,
  FIELD_TIMEOUT_MS,
  SOURCE_TIMEOUT_MS,
  MAX_FACETS_PER_ITEM,
  MAX_DETAIL_ROWS,
  MAX_FIELD_LEN,
  MAX_FIELDS_PER_ITEM,
  type ItemSourceProvider,
  type SyncResult,
} from "./sources";
import type { PluginServer } from "../../plugins/handlers";
import type { Facet, ItemRef, PluginEnricher } from "../../plugins/types";

/**
 * 内核只认识「来源」：一张单只有 source.provider，据此在插件交出的
 * ItemSourceProvider[] 里查一次。内核里没有任何 provider→插件 的名单。
 *
 * 来源表作为参数注入，理由跟从前的 collectFacets 一样：注册表是编译期常量，
 * 不注入假来源就没法证明超时和 try/catch 真的会兜住。
 */

const TEST_TIMEOUT_MS = 50;
const ok = (n: number): SyncResult => ({ created: n, updated: 0, total: n, truncated: false });

const items: ItemRef[] = [
  { id: "it-1", source: { provider: "alpha", ref: "A-1" } },
  { id: "it-2", source: null },
  { id: "it-3", source: { provider: "beta", ref: "B-9" } },
];

afterEach(() => {
  delete process.env.TMUX_NEXT_DISABLE_PLUGINS;
});

test("sourceProviders 收集每个启用插件交出的来源", () => {
  const servers: Record<string, PluginServer> = {
    p: { sources: [{ provider: "alpha" }, { provider: "beta" }] },
    q: { sources: [{ provider: "gamma" }] },
    r: {},
  };
  expect(sourceProviders(servers).map((s) => s.provider)).toEqual(["alpha", "beta", "gamma"]);
  expect(claimedProviders(servers)).toEqual(["alpha", "beta", "gamma"]);
});

test("两个来源声明同一个 provider，后者被丢弃", () => {
  const first: ItemSourceProvider = { provider: "alpha", sync: async () => ok(1) };
  const second: ItemSourceProvider = { provider: "alpha", sync: async () => ok(2) };
  const servers: Record<string, PluginServer> = { p: { sources: [first] }, q: { sources: [second] } };
  const got = sourceProviders(servers);
  expect(got).toHaveLength(1);
  expect(got[0]).toBe(first);
});

test("TMUX_NEXT_DISABLE_PLUGINS 关掉的插件，它的来源一并消失", () => {
  // 只有真注册表里的 id 才受 env 影响；这里用真的 jira id 来验证过滤。
  const servers: Record<string, PluginServer> = {
    jira: { sources: [{ provider: "jira" }] },
    other: { sources: [{ provider: "other" }] },
  };
  expect(claimedProviders(servers)).toEqual(["jira", "other"]);
  process.env.TMUX_NEXT_DISABLE_PLUGINS = "jira";
  expect(claimedProviders(servers)).toEqual(["other"]);
});

test("来源级 enrich 只收到自己 provider 的单", async () => {
  let seen: ItemRef[] = [];
  const alpha: ItemSourceProvider = {
    provider: "alpha",
    enrich: async (got) => {
      seen = got;
      return { "it-1": [{ dim: "alpha.status", value: "open" }] };
    },
  };
  const out = await collectFacets(items, [alpha], []);
  expect(seen.map((i) => i.id)).toEqual(["it-1"]);
  expect(out).toEqual({ "it-1": [{ dim: "alpha.status", value: "open" }] });
});

test("插件级 enrich 收到全部单", async () => {
  let seen: ItemRef[] = [];
  const extra: PluginEnricher = async (got) => {
    seen = got;
    return { "it-2": [{ dim: "git.branch", value: "main" }] };
  };
  const out = await collectFacets(items, [], [extra]);
  expect(seen.map((i) => i.id)).toEqual(["it-1", "it-2", "it-3"]);
  expect(out).toEqual({ "it-2": [{ dim: "git.branch", value: "main" }] });
});

test("collectFields 只问认领了这张单来源的那一个来源", async () => {
  const asked: string[] = [];
  const alpha: ItemSourceProvider = {
    provider: "alpha",
    fields: async () => {
      asked.push("alpha");
      return { "alpha.summary": "修登录页" };
    },
  };
  const beta: ItemSourceProvider = {
    provider: "beta",
    fields: async () => {
      asked.push("beta");
      return { "beta.summary": "不该问到" };
    },
  };
  expect(await collectFields(items[0]!, [alpha, beta])).toEqual({ "alpha.summary": "修登录页" });
  expect(asked).toEqual(["alpha"]);
  expect(await collectFields(items[1]!, [alpha, beta])).toEqual({});
});

test("runSync 把每个来源的结果相加", async () => {
  const sources: ItemSourceProvider[] = [
    { provider: "a", sync: async () => ({ created: 2, updated: 1, total: 3, truncated: false }) },
    { provider: "b", sync: async () => ({ created: 0, updated: 4, total: 4, truncated: true }) },
    { provider: "c" },
  ];
  expect(await runSync(sources)).toEqual({ created: 2, updated: 5, total: 7, truncated: true });
});

test("runSync：一个来源抛了或卡住了，别的照常汇总", async () => {
  const sources: ItemSourceProvider[] = [
    { provider: "a", sync: async () => ok(3) },
    { provider: "bad", sync: async () => { throw new Error("boom"); } },
    { provider: "hang", sync: () => new Promise(() => {}) },
  ];
  expect(await runSync(sources, TEST_TIMEOUT_MS)).toEqual(ok(3));
});

test("refreshFromSource 按 provider 找来源，找不到/没实现/抛/卡住都是 false", async () => {
  const calls: string[] = [];
  const sources: ItemSourceProvider[] = [
    { provider: "a", refreshItem: async (ref) => { calls.push(ref); } },
    { provider: "noimpl" },
    { provider: "bad", refreshItem: async () => { throw new Error("boom"); } },
    { provider: "hang", refreshItem: () => new Promise(() => {}) },
  ];
  expect(await refreshFromSource("a", "A-1", sources)).toBe(true);
  expect(calls).toEqual(["A-1"]);
  expect(await refreshFromSource("nobody", "X", sources)).toBe(false);
  expect(await refreshFromSource("noimpl", "X", sources)).toBe(false);
  expect(await refreshFromSource("bad", "X", sources)).toBe(false);
  expect(await refreshFromSource("hang", "X", sources, TEST_TIMEOUT_MS)).toBe(false);
});

test("notifyLifecycleChange 把迁移送给认领的来源，失败静默", async () => {
  const seen: string[] = [];
  const sources: ItemSourceProvider[] = [
    { provider: "a", onLifecycleChange: async (ref, from, to) => { seen.push(`${ref}:${from}>${to}`); } },
    { provider: "bad", onLifecycleChange: async () => { throw new Error("boom"); } },
    { provider: "hang", onLifecycleChange: () => new Promise(() => {}) },
  ];
  await notifyLifecycleChange("a", "A-1", "in_progress", "in_review", sources);
  await notifyLifecycleChange("nobody", "X", "in_progress", "in_review", sources);
  await notifyLifecycleChange("bad", "X", "in_progress", "in_review", sources);
  await notifyLifecycleChange("hang", "X", "in_progress", "in_review", sources, TEST_TIMEOUT_MS);
  expect(seen).toEqual(["A-1:in_progress>in_review"]);
});

test("预算常量的值不变", () => {
  expect(ENRICH_TIMEOUT_MS).toBe(300);
  expect(FIELD_TIMEOUT_MS).toBe(5_000);
  expect(SOURCE_TIMEOUT_MS).toBe(30_000);
  expect(MAX_FACETS_PER_ITEM).toBe(6);
  expect(MAX_DETAIL_ROWS).toBe(20);
  expect(MAX_FIELDS_PER_ITEM).toBe(12);
  expect(MAX_FIELD_LEN).toBe(4000);
});
```

- [ ] **Step 2: 把旧三个测试文件里的净化/超时用例搬进同一个文件**

打开 `src/plugin-enrich.test.ts` 和 `src/plugin-fields.test.ts`，把每条 `test(...)` 逐条贴到 `sources.test.ts` 末尾，改三处：

- `collectFacets(items, { p: ok })` 这种"以插件 id 为键的表"改成来源数组 `collectFacets(items, [{ provider: "alpha", enrich: ok }], [])`；`items` 里 `provider: "jira"` 改成 `"alpha"`。用例里"一个插件抛了不影响另一个"改成两个 provider 不同的来源。
- `collectFields(item, { p: ok })` 改成 `collectFields(item, [{ provider: "alpha", fields: ok }])`，`item.source.provider` 改成 `"alpha"`。
- 常量 import 已在文件顶部。

`src/plugin-source.test.ts` 里 `runSync`/`refreshFromSource`/`notifyLifecycleChange` 的用例已经被上面 Step 1 覆盖，不搬；只把 `startPlugins` 的用例搬到新文件 `src/plugin-start.test.ts`：

```ts
import { test, expect } from "bun:test";
import { startPlugins } from "../plugins/handlers";
import type { Plugin } from "../plugins/types";
import type { PluginServer } from "../plugins/handlers";

const fakePlugins = (ids: string[]): Plugin[] =>
  ids.map((id) => ({ id, titleKey: `${id}.title`, icon: "", i18n: { zh: {}, en: {} } })) as Plugin[];

// 下面贴 plugin-source.test.ts 里所有调用 startPlugins 的 test(...)，
// fakePlugins({ a: [...] }) 的调用改成 fakePlugins(["a"])。
```

然后删除三个旧文件：

```bash
git rm src/plugin-enrich.test.ts src/plugin-fields.test.ts src/plugin-source.test.ts
```

- [ ] **Step 3: 跑新测试，确认失败原因是模块不存在**

```bash
bun test src/items/sources.test.ts 2>&1 | head -5
```

Expected: `Cannot find module "./sources"`。

- [ ] **Step 4: 写 `src/items/sources.ts`**

```ts
import { SERVERS, enabledPlugins, type PluginServer } from "../../plugins/handlers";
import { PLUGINS } from "../../plugins/registry.js";
import type { Facet, FacetDetail, ItemRef, PluginEnricher } from "../../plugins/types";
import { FIELD_KEY_CHARS } from "../template";
import type { ItemStatus } from "./lifecycle";

/**
 * 数据源契约，以及内核对来源的全部分派。
 *
 * 一个来源就是"能同步、能刷新一张、能贴 chip、能提供模板字段、能在状态变化时
 * 写回"这五件事，别的不管。插件在 plugins/handlers.ts 的 PluginServer.sources
 * 里交出零个或多个来源；内核按 WorkItem.source.provider 查这张表，从不知道
 * 插件 id。
 *
 * 五个方法的语义、预算和失败语义跟它们在 handlers.ts 里时一模一样，只是从
 * 插件级搬到了来源级——这一步的意义在于"一个插件 = 一个来源"不再是隐含假设。
 */

export type SyncResult = { created: number; updated: number; total: number; truncated: boolean };

export type ItemSourceProvider = {
  /** WorkItem.source.provider 的取值。一个进程里两个来源撞同一个值，后者被丢弃。 */
  provider: string;
  /** 把这个来源同步一遍（新建/更新单）。显式动作，SOURCE_TIMEOUT_MS 预算。 */
  sync?(opts?: { full?: boolean }): Promise<SyncResult>;
  /** 只刷新一张单，ref 是 source.ref。显式动作，SOURCE_TIMEOUT_MS 预算。 */
  refreshItem?(ref: string): Promise<void>;
  /** 给单贴 chip。每次画页都跑，ENRICH_TIMEOUT_MS 预算，绝不发请求。只收到 provider 匹配的单。 */
  enrich?(items: ItemRef[]): Promise<Record<string, Facet[]>>;
  /** 喂模板的字段。按下按钮才跑，FIELD_TIMEOUT_MS 预算，允许一次真实请求。 */
  fields?(item: ItemRef): Promise<Record<string, string>>;
  /** 状态机迁移之后的尽力通知。抛出即失败，内核只记日志，不撤销已落盘的状态。 */
  onLifecycleChange?(ref: string, from: ItemStatus, to: ItemStatus): Promise<void>;
};

/** enrich 每次页面加载都跑，300ms 逼着它只读缓存。 */
export const ENRICH_TIMEOUT_MS = 300;
/** fields 是按下按钮才走的一次显式动作，允许一次真实往返，但有人盯着输入框。 */
export const FIELD_TIMEOUT_MS = 5_000;
/** sync / refreshItem 是显式动作，会真的发请求，30 秒是"慢"和"卡住"之间的线。 */
export const SOURCE_TIMEOUT_MS = 30_000;
/** 合并所有来源之后一张单最多留几条 facet——护的是卡片，不是每个来源的配额。 */
export const MAX_FACETS_PER_ITEM = 6;
/** 一个维度底下最多展开几行明细。 */
export const MAX_DETAIL_ROWS = 20;
/** 合并所有来源之后一张单最多留几个字段。 */
export const MAX_FIELDS_PER_ITEM = 12;
/** 一个字段的长度上限。 */
export const MAX_FIELD_LEN = 4000;
/** 一条 facet 文本的上限。 */
const MAX_TEXT = 120;
/** 一行明细"发给会话"的文本上限，小于 send-text.ts 的 2000。 */
const MAX_SEND_TEXT = 500;
/** 一个 chip 图标的路径长度上限。 */
const MAX_ICON = 2000;

/**
 * 一个插件是否该被这一轮考虑：不在真注册表里的（测试注进来的假插件）一律放行，
 * 在真注册表里的看 enabledPlugins()。TMUX_NEXT_DISABLE_PLUGINS 对来源生效的
 * 唯一一处。
 */
function isConsidered(id: string, enabled: Set<string>): boolean {
  return !PLUGINS.some((real) => real.id === id) || enabled.has(id);
}

/**
 * 启用的插件交出的全部来源。同一个 provider 出现两次，后者丢弃并记一行日志——
 * 不抛：一个插件写错不能让服务器起不来。
 */
export function sourceProviders(servers: Record<string, PluginServer> = SERVERS): ItemSourceProvider[] {
  const enabled = new Set(enabledPlugins().map((p) => p.id));
  const out: ItemSourceProvider[] = [];
  const seen = new Set<string>();
  for (const [id, server] of Object.entries(servers)) {
    if (!isConsidered(id, enabled)) continue;
    for (const source of server.sources ?? []) {
      if (seen.has(source.provider)) {
        console.error(`[items] 插件 ${id} 的来源 ${source.provider} 已被别的插件认领，丢弃`);
        continue;
      }
      seen.add(source.provider);
      out.push(source);
    }
  }
  return out;
}

/** 有人认领的 provider 列表，给 /api/items 响应用。 */
export function claimedProviders(servers: Record<string, PluginServer> = SERVERS): string[] {
  return sourceProviders(servers).map((s) => s.provider);
}

/** 插件级的 enrich：不绑来源、想给全部单贴 chip 的插件。 */
export function pluginEnrichers(servers: Record<string, PluginServer> = SERVERS): PluginEnricher[] {
  const enabled = new Set(enabledPlugins().map((p) => p.id));
  return Object.entries(servers)
    .filter(([id, s]) => s.enrich && isConsidered(id, enabled))
    .map(([, s]) => s.enrich!);
}

async function withTimeout<T>(work: Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
  const timeout = new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs));
  try {
    return await Promise.race([work, timeout]);
  } catch {
    return fallback;
  }
}

// ---- 净化：从 plugins/handlers.ts 原样搬来 ------------------------------------
// safeStage、safeSortKey、ICON_SHAPES、safeIconPaths、trim、safeHttpUrl 六个函数
// 及各自的注释，一字不改地从 handlers.ts 剪切到这里。

/**
 * 把一个 enrich 的返回值净化成 Facet 表。原来是 collectFacets 里的内联循环，
 * 抽出来是因为来源级和插件级两条路都要过同一道闸。
 */
function sanitiseFacets(got: unknown, asked: Set<string>): Record<string, Facet[]> | null {
  if (!got || typeof got !== "object" || Array.isArray(got)) return null;
  const clean: Record<string, Facet[]> = {};
  for (const [id, raw] of Object.entries(got as Record<string, unknown>)) {
    if (!asked.has(id)) continue;
    if (!Array.isArray(raw)) continue;
    const facets: Facet[] = [];
    for (const one of raw) {
      // …这里贴 handlers.ts 里 collectFacets 内层 for (const one of raw) 的整段
      // 净化代码（dim/value/tone/detail/icon/badge/stage/light/sortKey），一字不改…
    }
    if (facets.length) clean[id] = facets;
  }
  return clean;
}

/**
 * 向来源和插件级 enricher 各要一次 facet，合并成 item id → facet 数组。
 *
 * 失败语义只有一种：拿不到就当没有。来源级只收到自己 provider 的单；插件级
 * 收到全部。cap 默认 MAX_FACETS_PER_ITEM，单张单的详情面板传 Infinity。
 */
export async function collectFacets(
  items: ItemRef[],
  sources: ItemSourceProvider[] = sourceProviders(),
  extra: PluginEnricher[] = pluginEnrichers(),
  cap: number = MAX_FACETS_PER_ITEM,
): Promise<Record<string, Facet[]>> {
  const asked = new Set(items.map((i) => i.id));
  const jobs: Array<Promise<Record<string, Facet[]> | null>> = [];

  const ask = async (enrich: PluginEnricher, subset: ItemRef[]) => {
    if (!subset.length) return null;
    try {
      const got = await withTimeout(enrich(subset), null, ENRICH_TIMEOUT_MS);
      return sanitiseFacets(got, asked);
    } catch {
      return null;
    }
  };

  for (const source of sources) {
    if (!source.enrich) continue;
    jobs.push(ask(source.enrich, items.filter((i) => i.source?.provider === source.provider)));
  }
  for (const enrich of extra) jobs.push(ask(enrich, items));

  const merged: Record<string, Facet[]> = {};
  for (const one of await Promise.all(jobs)) {
    if (!one) continue;
    for (const [id, facets] of Object.entries(one)) (merged[id] ??= []).push(...facets);
  }
  for (const id of Object.keys(merged)) merged[id] = merged[id]!.slice(0, cap);
  return merged;
}

const FIELD_KEY = new RegExp(`^[${FIELD_KEY_CHARS}]+$`);

/**
 * 问认领了这张单来源的那一个来源要字段。本地单没有来源，不问任何人。
 * 失败语义同上：拿不到就当没有，占位符渲染成空。
 */
export async function collectFields(
  item: ItemRef,
  sources: ItemSourceProvider[] = sourceProviders(),
  timeoutMs: number = FIELD_TIMEOUT_MS,
): Promise<Record<string, string>> {
  const owner = item.source ? sources.find((s) => s.provider === item.source!.provider) : undefined;
  if (!owner?.fields) return {};
  let got: unknown;
  try {
    got = await withTimeout(owner.fields(item), null, timeoutMs);
  } catch {
    return {};
  }
  if (!got || typeof got !== "object" || Array.isArray(got)) return {};
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(got as Record<string, unknown>)) {
    if (typeof value !== "string" || !value) continue;
    if (!FIELD_KEY.test(key)) continue;
    if (key.startsWith("item.")) continue;
    clean[key] = value.slice(0, MAX_FIELD_LEN);
  }
  return Object.fromEntries(Object.entries(clean).slice(0, MAX_FIELDS_PER_ITEM));
}

/** 每个声明了 sync 的来源各同步一遍，结果相加。 */
export async function runSync(
  sources: ItemSourceProvider[] = sourceProviders(),
  timeoutMs: number = SOURCE_TIMEOUT_MS,
): Promise<SyncResult> {
  const results = await Promise.all(
    sources
      .filter((s) => s.sync)
      .map((s) => withTimeout(s.sync!(), null, timeoutMs).catch(() => null)),
  );
  const total: SyncResult = { created: 0, updated: 0, total: 0, truncated: false };
  for (const r of results) {
    if (!r) continue;
    total.created += r.created;
    total.updated += r.updated;
    total.total += r.total;
    total.truncated = total.truncated || r.truncated;
  }
  return total;
}

/** 按 provider 找来源刷新一张单。没人认领、没实现、抛了、超时，一律 false。 */
export async function refreshFromSource(
  provider: string,
  ref: string,
  sources: ItemSourceProvider[] = sourceProviders(),
  timeoutMs: number = SOURCE_TIMEOUT_MS,
): Promise<boolean> {
  const refreshItem = sources.find((s) => s.provider === provider)?.refreshItem;
  if (!refreshItem) return false;
  try {
    return await withTimeout(refreshItem(ref).then(() => true), false, timeoutMs);
  } catch {
    return false;
  }
}

/** 状态机迁移之后通知认领的来源一声。失败全部静默：写回是旁路。 */
export async function notifyLifecycleChange(
  provider: string,
  ref: string,
  from: ItemStatus,
  to: ItemStatus,
  sources: ItemSourceProvider[] = sourceProviders(),
  timeoutMs: number = SOURCE_TIMEOUT_MS,
): Promise<void> {
  const onLifecycleChange = sources.find((s) => s.provider === provider)?.onLifecycleChange;
  if (!onLifecycleChange) return;
  try {
    await withTimeout(onLifecycleChange(ref, from, to), undefined, timeoutMs);
  } catch {
    // 尽力而为。
  }
}
```

`sanitiseFacets` 内层循环和六个净化函数**必须**从 `handlers.ts` 剪切而不是重写——`src/plugin-enrich.test.ts` 那些"onload 属性过不了图标白名单"之类的用例现在在 `sources.test.ts` 里，重写会把它们弄红。

- [ ] **Step 5: 精简 `plugins/handlers.ts`**

- `PluginServer` 改成 Interfaces 里的形状：删 `enrich`（改为插件级语义，注释按 spec 写清"收到全部单"）、`fields`、`sync`、`refreshItem`、`onLifecycleChange`；加 `sources?: ItemSourceProvider[]`（`import type { ItemSourceProvider } from "../src/items/sources"`）。
- 删掉搬走的：`ENRICHERS`、`ENRICH_TIMEOUT_MS`、`MAX_TEXT`、`MAX_SEND_TEXT`、`MAX_FACETS_PER_ITEM`、`MAX_DETAIL_ROWS`、`MAX_ICON`、`safeStage`、`safeSortKey`、`ICON_SHAPES`、`safeIconPaths`、`trim`、`safeHttpUrl`、`collectFacets`、`FIELD_SOURCES`、`FIELD_TIMEOUT_MS`、`MAX_FIELD_LEN`、`MAX_FIELDS_PER_ITEM`、`FIELD_KEY`、`collectFields`、`SyncResult`、`SOURCE_TIMEOUT_MS`、`runSync`、`refreshFromSource`、`notifyLifecycleChange`。
- 留下：`SERVERS`、`enabledPlugins`、`isConsidered`、`withTimeout`、`MAX_SETTING_LEN`、`startPlugins`、`pluginSettings`、`savePluginSettings`、`runPluginAction`。`pluginSettings` 等三个函数里的 `SOURCE_TIMEOUT_MS` 改成从 `../src/items/sources` import（值只导出一次）。
- 这样 `handlers.ts` 和 `sources.ts` 互相 import，是一个 ESM 环。它安全的条件是**两边都只在函数体和默认参数里引用对方的导出，模块顶层一处都不用**——`sources.ts` 里不能再有 `ENRICHERS` 那种从 `SERVERS` 顶层推导出来的常量，`handlers.ts` 里也不能在顶层用 `SOURCE_TIMEOUT_MS`。在 `sources.ts` 的文件头注释里把这条写明，下一个往顶层加东西的人才会看到。
- `SERVERS.jira` 改成：

```ts
  jira: {
    handle: jira,
    start: jiraStart,
    readSettings: jiraReadSettings,
    writeSettings: jiraWriteSettings,
    runAction: jiraRunAction,
    sources: [jiraSource],
  },
```

import 行改成 `import { handle as jira, start as jiraStart, readSettings as jiraReadSettings, writeSettings as jiraWriteSettings, runAction as jiraRunAction, source as jiraSource } from "./jira/server";`。

- [ ] **Step 6: Jira 导出一个来源对象**

`plugins/jira/server.ts` 末尾加：

```ts
/** 交给内核的来源：五个方法都是这个文件里已有的函数。 */
export const source: ItemSourceProvider = {
  provider: "jira",
  sync,
  refreshItem,
  enrich,
  fields,
  onLifecycleChange,
};
```

顶部 `import type { SyncResult } from "../handlers"` 改成 `import type { ItemSourceProvider, SyncResult } from "../../src/items/sources"`。`fields` 的签名有两个注入参数（`getDescription`、`now`），作为对象属性赋给 `fields?(item)` 时多出来的可选参数不影响类型兼容。

- [ ] **Step 7: 删清单里的 `provides`**

- `plugins/types.ts`：删 `provides?: string[]` 及其注释。
- `plugins/jira/plugin.js`：删 `provides: ["jira"]` 及其注释。
- `plugins/registry.test.ts`：`grep -n provides`，删任何断言它的用例（写计划时没有，确认一次）。

- [ ] **Step 8: routes.ts 改从 sources 引分派**

`src/items/routes.ts`：`import { collectFacets, collectFields, runSync, refreshFromSource, notifyLifecycleChange } from "../../plugins/handlers"` → `from "./sources"`。`itemDetail` 里 `collectFacets(refs, undefined, Infinity)` 改成 `collectFacets(refs, undefined, undefined, Infinity)`。

- [ ] **Step 9: 全量测试**

```bash
bun run typecheck && bun test src/items/ src/plugin-start.test.ts plugins/ 2>&1 | tail -5
bun test 2>&1 | grep -E "^\(fail\)|^\(error\)" | sort | diff - /private/tmp/claude-501/-Users-lau-projects-tmux-next/24607655-e39d-4fea-9bf1-36b37f527f9b/scratchpad/baseline-fails.txt
```

Expected: 全绿；diff 为空。`plugins/jira/refresh-item.test.ts` 若 import 了 `refreshFromSource`，改成从 `../../src/items/sources` 引。

- [ ] **Step 10: 提交**

```bash
git add src/items/sources.ts src/items/sources.test.ts src/items/routes.ts src/plugin-start.test.ts plugins/handlers.ts plugins/types.ts plugins/jira/plugin.js plugins/jira/server.ts plugins/registry.test.ts plugins/jira/refresh-item.test.ts
git rm -q src/plugin-enrich.test.ts src/plugin-fields.test.ts src/plugin-source.test.ts 2>/dev/null || true
git commit -m "Define ItemSourceProvider and move source dispatch into src/items/sources.ts

A data source is now an object a plugin hands over in
PluginServer.sources[], keyed by the provider string it claims. The
kernel dispatches sync, refresh, enrich, fields and lifecycle writeback
by looking that string up; the manifest's provides field goes away
because nothing needs it any more. Budgets, caps and sanitisation are
unchanged and their tests moved with them."
```

---

## Task 4: `providers` 从 `/api/items` 下发，浏览器停止 import 清单

**Files:**
- Modify: `src/items/routes.ts`（三个响应加 `providers`）
- Modify: `src/items/routes.test.ts`
- Modify: `public/item-card.js`（删 `claimedProviders`、删 registry import；`refreshButton(item, providers, onChange)`）
- Modify: `public/items.js`、`public/item-panel.js`
- Modify: `src/items-page.test.ts`、`src/item-panel.test.ts`、`src/item-card.test.ts`

**Interfaces:**
- Produces: `GET /api/items`、`GET /api/items/:id`、`GET /api/items/by-session` 响应体多一个 `providers: string[]`。
- Produces: `export function refreshButton(item, providers, onChange)`——`providers` 是 `Iterable<string>`，`item.source.provider` 不在其中时**不画**，返回 `null`。

- [ ] **Step 1: 路由测试：三个响应带 providers**

`src/items/routes.test.ts` 末尾加：

```ts
test("列表、详情、by-session 三个响应都带 providers", async () => {
  const item = await makeItem("有来源", { source: { provider: "jira", ref: "EXAMPLE-1" } });
  const list = await (await fetch(at("/api/items"))).json();
  expect(Array.isArray(list.providers)).toBe(true);
  // jira 插件默认启用，它认领 "jira"。
  expect(list.providers).toContain("jira");
  const detail = await (await fetch(at(`/api/items/${item.id}`))).json();
  expect(detail.providers).toEqual(list.providers);
});

test("禁用 jira 之后 providers 里就没有它", async () => {
  const prev = process.env.TMUX_NEXT_DISABLE_PLUGINS;
  process.env.TMUX_NEXT_DISABLE_PLUGINS = "jira";
  try {
    const list = await (await fetch(at("/api/items"))).json();
    expect(list.providers).not.toContain("jira");
  } finally {
    if (prev === undefined) delete process.env.TMUX_NEXT_DISABLE_PLUGINS;
    else process.env.TMUX_NEXT_DISABLE_PLUGINS = prev;
  }
});
```

- [ ] **Step 2: 跑，确认红**

```bash
bun test src/items/routes.test.ts -t "providers" 2>&1 | tail -5
```

Expected: FAIL，`providers` 是 `undefined`。

- [ ] **Step 3: routes.ts 三处响应加字段**

`import { claimedProviders } from "./sources"`；`GET /api/items` 的 `Response.json({ items, bindings, sessions: live, facets })` 改成 `Response.json({ items, bindings, sessions: live, facets, providers: claimedProviders() })`；`itemDetail` 末尾 `Response.json({ item, sessions, facets: [...], history })` 加 `providers: claimedProviders()`（`by-session` 走的就是 `itemDetail`）。

- [ ] **Step 4: 跑路由测试，绿**

```bash
bun test src/items/routes.test.ts 2>&1 | tail -3
```

- [ ] **Step 5: 页面测试改成从响应体喂 providers**

`src/items-page.test.ts`：`mount(body, store, enabledIds)` 的第三个参数改名 `providers`，默认 `["jira"]`；fetch 垫片里 `if (href.includes("api/items")) return new Response(JSON.stringify(nextBody ?? body))` 改成把 `providers` 合进去：

```ts
      if (href.includes("api/items")) {
        const b = (nextBody ?? body) as Record<string, unknown>;
        return new Response(JSON.stringify({ ...b, providers }));
      }
```

删掉 `if (href.includes("api/plugins"))` 那一行（离线那段里的也删）。`mount` 上面那段注释改写成"`providers` 是 /api/items 响应里服务端报出的已认领来源"。"有来源，但没有启用的插件认领这个 provider 时不画刷新按钮"那条把 `mount(payload(...), {}, [])` 留着，注释改成"服务端 providers 为空"。

`src/item-panel.test.ts`：`let enabled: string[] = []` 改名 `providers`；fetch 垫片删掉 `api/plugins` 那一行，`reply.body` 返回前合并 `providers`：`return new Response(JSON.stringify({ ...(reply.body as object), providers }))`。三条「刷新」测试里 `enabled = ["jira"]` 改成 `providers = ["jira"]`。

`src/item-card.test.ts` 加：

```ts
test("refreshButton：来源被认领才画，否则返回 null", async () => {
  const { refreshButton } = await load();
  const item = { id: "it-1", title: "x", source: { provider: "jira", ref: "A-1" } };
  expect(refreshButton(item, ["jira"], async () => {})).toBeTruthy();
  expect(refreshButton(item, [], async () => {})).toBeNull();
  expect(refreshButton({ id: "it-2", title: "本地", source: null }, ["jira"], async () => {})).toBeNull();
});
```

- [ ] **Step 6: 跑三个页面测试，确认红**

```bash
bun test src/items-page.test.ts src/item-panel.test.ts src/item-card.test.ts 2>&1 | grep -E "^\(fail\)" | head
```

Expected: 刷新按钮相关的用例红。

- [ ] **Step 7: 改 `public/item-card.js`**

- 删 `import { PLUGINS } from "../plugins/registry.js";` 和整个 `claimedProviders` 函数及其注释。
- `refreshButton` 改签名并在开头判断：

```js
/**
 * 「刷新」。……（原注释保留，"见 claimedProviders"那句改成"providers 是服务端
 * 在 /api/items 响应里报出的已认领来源——浏览器不再自己拼这份名单"）
 *
 * @param {*} item
 * @param {Iterable<string>} providers 服务端报出的已认领来源
 * @param {() => Promise<void>} onChange
 * @returns {HTMLButtonElement | null}
 */
export function refreshButton(item, providers, onChange) {
  if (!item.source || !new Set(providers).has(item.source.provider)) return null;
  const btn = document.createElement("button");
  // …其余不变…
}
```

- [ ] **Step 8: 改 `public/items.js`**

- import 列表删 `claimedProviders`。
- `render()` 里删 `let claimed;` 和 `claimed = await claimedProviders();`，在解析 body 那段加 `const providers = Array.isArray(body?.providers) ? body.providers : [];`。
- `itemCard(item, sessions, facets, claimed, onChange, link)` 和 `itemListRow(..., claimed, ...)`、`itemList(..., claimed, ...)` 三个函数的参数 `claimed` 改名 `providers`；里面 `if (item.source && claimed.has(item.source.provider)) actions.append(refreshButton(item, onChange))` 改成：

```js
  const refresh = refreshButton(item, providers, onChange);
  if (refresh) actions.append(refresh);
```

  所有调用点把 `claimed` 换成 `providers`（`grep -n claimed public/items.js` 直到为零）。

- [ ] **Step 9: 改 `public/item-panel.js`**

- import 列表删 `claimedProviders`。
- `openItemPanel` 里 `const [detail, claimed] = await Promise.all([fetchDetail(query), claimedProviders()])` 改成 `const detail = await fetchDetail(query)`。
- `fill(data)` 里 `if (data.item.source && claimed.has(...)) { … refreshButton(data.item, again) … }` 改成：

```js
      const providers = Array.isArray(data.providers) ? data.providers : [];
      const again = async () => fill(await fetchDetail({ id: data.item.id }));
      const refresh = refreshButton(data.item, providers, again);
      if (refresh) {
        const actions = document.createElement("div");
        actions.className = "item-actions";
        actions.append(refresh);
        sheet.append(actions);
      }
```

  `fetchDetail` 的返回类型注释加 `providers?: string[]`。文件顶部注释里关于 `claimedProviders` 的句子删掉。

- [ ] **Step 10: 全量测试**

```bash
bun run typecheck && bun test src/items-page.test.ts src/item-panel.test.ts src/item-card.test.ts src/public-parses.test.ts src/list-page.test.ts 2>&1 | tail -5
bun test 2>&1 | grep -E "^\(fail\)|^\(error\)" | sort | diff - /private/tmp/claude-501/-Users-lau-projects-tmux-next/24607655-e39d-4fea-9bf1-36b37f527f9b/scratchpad/baseline-fails.txt
```

Expected: 全绿；diff 为空。`grep -rn "registry.js" public/` 只剩 `nav.js` 和 `i18n.js`。

- [ ] **Step 11: 提交**

```bash
git add src/items/routes.ts src/items/routes.test.ts public/item-card.js public/items.js public/item-panel.js src/items-page.test.ts src/item-panel.test.ts src/item-card.test.ts
git commit -m "Send claimed providers down the items API instead of importing the plugin registry in the browser

The refresh button used to be decided by intersecting /api/plugins with
each manifest's provides list, which meant item-card.js imported
plugins/registry.js. The server already knows which providers are
claimed; it now says so in every items response."
```

---

## Task 5: 状态机按 `role` 读信号

**Files:**
- Modify: `plugins/types.ts`（`Facet.role`）
- Modify: `src/items/sources.ts`（净化透传 `role`）
- Modify: `src/items/lifecycle.ts`（`deriveSignal`）
- Modify: `src/items/lifecycle.test.ts`、`src/items/sources.test.ts`
- Modify: `plugins/jira/server.ts`（`facetsFor` 加 `role`）、`plugins/jira/enrich.test.ts`

**Interfaces:**
- Produces: `Facet.role?: "pr" | "check"`。语义写在类型注释里，是契约的一部分。

- [ ] **Step 1: lifecycle 测试改 fixture**

`src/items/lifecycle.test.ts` 顶部的五个 fixture 改成：

```ts
// 维度名故意不叫 jira.*：状态机只认 role，不认维度名。这是"内核不再认识
// Jira"的那条断言。
const openPr: Facet = {
  dim: "tracker.pulls",
  value: "1",
  role: "pr",
  detail: [{ label: "fix", value: "OPEN", tone: undefined }],
};
const mergedPr: Facet = {
  dim: "tracker.pulls",
  value: "1",
  role: "pr",
  detail: [{ label: "fix", value: "MERGED", tone: "dim" }],
};
const declinedPr: Facet = {
  dim: "tracker.pulls",
  value: "1",
  role: "pr",
  detail: [{ label: "fix", value: "DECLINED", tone: "warn" }],
};
const checksOk: Facet = { dim: "tracker.ci", value: "0/2", tone: "ok", role: "check" };
const checksFailed: Facet = { dim: "tracker.ci", value: "1/2", tone: "warn", role: "check" };
```

`describe("deriveSignal")` 里加一条：

```ts
  test("没有 role 的 facet 即使叫 jira.prs 也不算信号", () => {
    const lookalike: Facet = {
      dim: "jira.prs",
      value: "1",
      detail: [{ label: "fix", value: "OPEN", tone: undefined }],
    };
    expect(deriveSignal([lookalike], true).hasOpenPr).toBe(false);
  });
```

- [ ] **Step 2: sources 测试加 role 净化**

`src/items/sources.test.ts` 加：

```ts
test("role 只认 pr / check，别的当没给", async () => {
  const src: ItemSourceProvider = {
    provider: "alpha",
    enrich: async () => ({
      "it-1": [
        { dim: "a.prs", value: "1", role: "pr" },
        { dim: "a.checks", value: "0/1", role: "check" },
        { dim: "a.other", value: "x", role: "bogus" } as unknown as Facet,
      ],
    }),
  };
  const got = await collectFacets(items, [src], []);
  expect(got["it-1"]!.map((f) => f.role)).toEqual(["pr", "check", undefined]);
});
```

- [ ] **Step 3: 跑，确认红**

```bash
bun test src/items/lifecycle.test.ts src/items/sources.test.ts 2>&1 | grep -E "^\(fail\)" | head
```

Expected: typecheck 或断言红（`role` 不在 `Facet` 上；`hasOpenPr` 为 false）。

- [ ] **Step 4: 类型、净化、状态机**

`plugins/types.ts` 的 `Facet` 末尾加：

```ts
  /**
   * 这条 facet 在单的进度状态机里扮演什么角色。内核只认这一个字段，不看 dim。
   *
   * "pr"：value 是 PR 数，detail 每行一个 PR，行的 tone 是 undefined=open、
   *       "dim"=merged、"warn"=declined。
   * "check"：顶层 tone 是 "ok"=全过、"warn"=有失败；这条 facet 只在真的问到过
   *          检查时才出现——缺席就是"没查到"，不是"过了"。
   *
   * 一张单有多条同 role 的 facet 时状态机取第一条。
   */
  role?: "pr" | "check";
```

`src/items/sources.ts` 的 `sanitiseFacets` 内层，`sortKey` 之后加 `const role = f?.role === "pr" || f?.role === "check" ? f.role : undefined;`，`facets.push({...})` 里加 `...(role ? { role } : {})`。

`src/items/lifecycle.ts` 的 `deriveSignal`：

```ts
  const prs = facets.find((f) => f.role === "pr");
  const checks = facets.find((f) => f.role === "check");
```

上面那段 JSDoc 改成：

```ts
/**
 * 从一张单的 facet 里挤出状态机信号。
 *
 * 只认 `role === "pr"` 和 `role === "check"` 两条 facet，不认维度名——哪个来源
 * 贴的、维度叫什么，内核一概不问。tone 的语义写在 plugins/types.ts 的 `role`
 * 注释里，是契约的一部分。
 */
```

- [ ] **Step 5: Jira 贴 role**

`plugins/jira/server.ts` 的 `facetsFor`：`jira.prs` 那个对象加 `role: "pr",`；`jira.checks` 那个加 `role: "check",`。`plugins/jira/enrich.test.ts` 找到断言 `jira.prs` / `jira.checks` 整个对象的用例，把期望值加上对应 `role`；若那些用例只断言 `dims()`，加一条：

```ts
test("PR 和检查两个 facet 带 role，给状态机认", () => {
  const dev = new Map<string, DevResult>([
    ["10001", { ok: true, hidden: 0, prs: [{ id: "1", title: "fix", branch: "b", url: "https://x/1", status: "OPEN", checks: [{ name: "ci", state: "SUCCESSFUL" }], checksKnown: true }] }],
  ]);
  const facets = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue()]]), dev);
  expect(facets.find((f) => f.dim === "jira.prs")?.role).toBe("pr");
  expect(facets.find((f) => f.dim === "jira.checks")?.role).toBe("check");
});
```

（`PullRequest` 的字段以 `plugins/jira/dev.ts` 的类型为准，补齐必填项。）

- [ ] **Step 6: 全量测试**

```bash
bun run typecheck && bun test src/items/ plugins/jira/enrich.test.ts 2>&1 | tail -3
bun test 2>&1 | grep -E "^\(fail\)|^\(error\)" | sort | diff - /private/tmp/claude-501/-Users-lau-projects-tmux-next/24607655-e39d-4fea-9bf1-36b37f527f9b/scratchpad/baseline-fails.txt
```

- [ ] **Step 7: 提交**

```bash
git add plugins/types.ts src/items/sources.ts src/items/sources.test.ts src/items/lifecycle.ts src/items/lifecycle.test.ts plugins/jira/server.ts plugins/jira/enrich.test.ts
git commit -m "Read lifecycle signals from a facet's role, not its dimension name

deriveSignal used to look for facets literally named jira.prs and
jira.checks. A source now marks those facets role: \"pr\" / \"check\"; the
kernel matches on that and never on a dim."
```

---

## Task 6: chip 可点（`Facet.url`）

**Files:**
- Modify: `plugins/types.ts`（`Facet.url`）
- Modify: `src/items/sources.ts`（净化）
- Modify: `public/item-card.js`（`facetChip`）、`public/style.css`（`a.facet` 样式）
- Modify: `src/item-card.test.ts`、`src/items/sources.test.ts`
- Modify: `plugins/jira/server.ts`（`facetsFor` 第四个参数 `browseBase`；`jira.epic` 带 url）、`plugins/jira/enrich.test.ts`

**Interfaces:**
- Produces: `Facet.url?: string`，只认 http/https。
- Produces: `facetsFor(item, issues, dev, browseBase = "")`；`browseBase` 是 Jira 实例地址（无尾斜杠），空串表示不给链接。

- [ ] **Step 1: 渲染测试**

`src/item-card.test.ts` 加三条：

```ts
test("只有 url 的 chip 画成新开标签的链接", async () => {
  const { facetChip } = await load();
  const chip = facetChip({ dim: "jira.epic", value: "登录改版", url: "https://j/browse/EP-1" });
  expect(chip.tagName).toBe("A");
  expect(chip.getAttribute("href")).toBe("https://j/browse/EP-1");
  expect(chip.getAttribute("target")).toBe("_blank");
  expect(chip.getAttribute("rel")).toContain("noopener");
  expect(chip.textContent).toContain("登录改版");
});

test("有明细的 chip 仍是按钮，url 进浮层标题旁", async () => {
  const { facetChip } = await load();
  const chip = facetChip({
    dim: "jira.prs", value: "1", url: "https://j/browse/A-1",
    detail: [{ label: "fix", value: "OPEN" }],
  });
  expect(chip.tagName).toBe("BUTTON");
  chip.click();
  const sheet = document.querySelector(".sheet");
  expect(sheet?.querySelector("a.sheet-link")?.getAttribute("href")).toBe("https://j/browse/A-1");
});

test("没有 url 也没有明细的 chip 还是 span", async () => {
  const { facetChip } = await load();
  expect(facetChip({ dim: "jira.status", value: "Done" }).tagName).toBe("SPAN");
});
```

`src/items/sources.test.ts` 加：

```ts
test("facet 的 url 只认 http/https", async () => {
  const src: ItemSourceProvider = {
    provider: "alpha",
    enrich: async () => ({
      "it-1": [
        { dim: "a.epic", value: "x", url: "https://j/browse/E-1" },
        { dim: "a.bad", value: "y", url: "javascript:alert(1)" },
        { dim: "a.rel", value: "z", url: "browse/E-1" },
      ],
    }),
  };
  const got = await collectFacets(items, [src], []);
  expect(got["it-1"]!.map((f) => f.url)).toEqual(["https://j/browse/E-1", undefined, undefined]);
});
```

- [ ] **Step 2: 跑，确认红**

```bash
bun test src/item-card.test.ts src/items/sources.test.ts 2>&1 | grep -E "^\(fail\)" | head
```

- [ ] **Step 3: 类型、净化、渲染**

`plugins/types.ts` 的 `Facet` 加：

```ts
  /**
   * 这颗 chip 本身指向哪里。只认 http/https，内核在 collectFacets 里挡（safeHttpUrl）。
   * 没有 detail 时 chip 画成链接；有 detail 时 chip 仍是开浮层的按钮，链接放进
   * 浮层标题旁。Jira 用它让史诗 chip 链回工单页。
   */
  url?: string;
```

`src/items/sources.ts` 的 `sanitiseFacets`：`const facetUrl = safeHttpUrl(f?.url);`，push 时 `...(facetUrl ? { url: facetUrl } : {})`。

`public/item-card.js` 的 `facetChip`：

```js
  let chip;
  if (rows.length) {
    const btn = el("button", facet.tone ? `facet has-detail ${facet.tone}` : "facet has-detail");
    btn.type = "button";
    btn.addEventListener("click", () => openDetailSheet(`${label}: ${value}`, rows, sessionName, facet.url));
    chip = btn;
  } else if (facet.url) {
    // 只有链接、没有明细：chip 本身就是去处。新开标签，跟明细行里的链接一样——
    // 这一页的分组和筛选不该被一次跳转带走。
    const a = el("a", facet.tone ? `facet is-link ${facet.tone}` : "facet is-link");
    a.href = facet.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    chip = a;
  } else {
    chip = el("span", facet.tone ? `facet ${facet.tone}` : "facet");
  }
```

`openDetailSheet(title, rows, sessionName, url)` 加第四个可选参数：标题行旁边画一个 `a.sheet-link`（`href = url`，`target = _blank`，`rel = noopener noreferrer`，内容用 `icon("link")`——`public/icons.js` 里已有 `groupUrl` 用的那个链接图标，用同一个名字），`url` 为空时不画。JSDoc 补 `@param {string} [url]`。

`public/style.css`：在 `.facet` 规则附近加

```css
a.facet.is-link { text-decoration: none; color: inherit; }
a.facet.is-link:hover { text-decoration: underline; }
```

不引入新颜色。

- [ ] **Step 4: Jira 给史诗链接**

`plugins/jira/server.ts`：

- `facetsFor(item, issues, dev, browseBase = "")`，史诗那段改成：

```ts
  const epic = epicSummaryOf(issue);
  if (epic) {
    facets.push({
      dim: "jira.epic",
      value: epic,
      // 史诗有自己的工单页，chip 直接链过去——从前只有工单页上那颗父级 chip
      // 能点，首页的这颗只是文字。
      ...(browseBase && issue.parent ? { url: `${browseBase}/browse/${encodeURIComponent(issue.parent.key)}` } : {}),
    });
  }
```

- 模块级加 `let browseBase = "";`，在 `issues()`、`refreshIssue()`、`sync()` 里 `readJiraConfig()` 成功后各加一行 `browseBase = config.url.replace(/\/+$/, "");`。`enrich()` 里 `facetsFor(item, issueMap, devMap, browseBase)`。

`plugins/jira/enrich.test.ts` 加：

```ts
test("给了实例地址，史诗 chip 带链接；没给就没有", () => {
  const withEpic = issue({ parent: { key: "EP-1", summary: "登录改版", hierarchy: 1 } });
  const issues = new Map([["EXAMPLE-1", withEpic]]);
  const linked = facetsFor(jiraItem, issues, new Map(), "https://example.atlassian.net");
  expect(linked.find((f) => f.dim === "jira.epic")?.url).toBe("https://example.atlassian.net/browse/EP-1");
  const bare = facetsFor(jiraItem, issues, new Map());
  expect(bare.find((f) => f.dim === "jira.epic")?.url).toBeUndefined();
});
```

- [ ] **Step 5: 全量测试**

```bash
bun run typecheck && bun test src/item-card.test.ts src/items/sources.test.ts plugins/jira/enrich.test.ts src/items-page.test.ts src/themes.test.ts 2>&1 | tail -3
bun test 2>&1 | grep -E "^\(fail\)|^\(error\)" | sort | diff - /private/tmp/claude-501/-Users-lau-projects-tmux-next/24607655-e39d-4fea-9bf1-36b37f527f9b/scratchpad/baseline-fails.txt
```

- [ ] **Step 6: 提交**

```bash
git add plugins/types.ts src/items/sources.ts src/items/sources.test.ts public/item-card.js public/style.css src/item-card.test.ts plugins/jira/server.ts plugins/jira/enrich.test.ts
git commit -m "Let a facet carry a link, and link the epic chip back to Jira

A chip with a url and no detail renders as a new-tab anchor; with detail
it stays a button and the link sits beside the sheet title. Same
http/https gate as detail rows."
```

---

## Task 7: "另有 N 条 PR 被隐藏"折进 PR 明细

**Files:**
- Modify: `plugins/jira/server.ts`（`facetsFor` 在 `jira.prs` 明细末尾加一行）
- Modify: `plugins/jira/enrich.test.ts`

- [ ] **Step 1: 测试**

`plugins/jira/enrich.test.ts` 加：

```ts
test("被过滤掉的 PR 数在明细末尾多一行 dim 提示", () => {
  const dev = new Map<string, DevResult>([
    ["10001", { ok: true, hidden: 2, prs: [{ id: "1", title: "fix", branch: "b", url: "https://x/1", status: "OPEN", checks: [], checksKnown: false }] }],
  ]);
  const facets = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue()]]), dev);
  const rows = facets.find((f) => f.dim === "jira.prs")?.detail ?? [];
  expect(rows.at(-1)).toEqual({ label: "另有 2 条 PR 未带本单号，已隐藏", value: "", tone: "dim" });
});
```

- [ ] **Step 2: 跑，确认红**

```bash
bun test plugins/jira/enrich.test.ts -t "隐藏" 2>&1 | tail -3
```

- [ ] **Step 3: 实现**

`facetsFor` 里 `jira.prs` 的 `detail` 改成：

```ts
      detail: [
        ...got.prs.map((pr) => ({ label: pr.title || pr.branch, value: pr.status, tone: prFacetTone(pr.status), url: pr.url })),
        // 过滤掉的说出来，不是悄悄少几条：onlyKeyedPrs 的意义就是 dev-status 会
        // 把别的单的 PR 挂过来，一个不声不响的过滤只是把一种不准换成另一种。
        // 文案是服务端中文：enrich 没有语言上下文，来源侧文案的 i18n 通路本轮不开。
        ...(got.hidden ? [{ label: `另有 ${got.hidden} 条 PR 未带本单号，已隐藏`, value: "", tone: "dim" as const }] : []),
      ],
```

`sanitiseFacets` 那条 `if (!label) continue;` 只挡空 label，`value: ""` 能过——用 `sources.test.ts` 里已搬来的"明细行截断"用例确认 value 为空的行仍被保留；若没有这样的用例，加一条：

```ts
test("明细行 value 为空也保留", async () => {
  const src: ItemSourceProvider = {
    provider: "alpha",
    enrich: async () => ({ "it-1": [{ dim: "a.prs", value: "1", detail: [{ label: "提示", value: "" }] }] }),
  };
  const got = await collectFacets(items, [src], []);
  expect(got["it-1"]![0]!.detail).toEqual([{ label: "提示", value: "" }]);
});
```

- [ ] **Step 4: 跑，绿；提交**

```bash
bun test plugins/jira/enrich.test.ts src/items/sources.test.ts 2>&1 | tail -3
git add plugins/jira/server.ts plugins/jira/enrich.test.ts src/items/sources.test.ts
git commit -m "Say how many PRs the key filter hid, as the last detail row"
```

---

## Task 8: 会话在等你时，就地回一句（Markdown 进内核，`sessionRow` 加「回答」）

**Files:**
- Move: `plugins/jira/public/markdown.js` → `public/markdown.js`；`src/jira-markdown.test.ts` → `src/markdown.test.ts`
- Modify: `public/item-card.js`（`sessionRow` 第三参数；新 `openAnswerSheet`）
- Modify: `public/items.js`、`public/item-panel.js`（传 `onSent`）
- Modify: `public/i18n.js`（八个新键，两种语言）
- Modify: `public/style.css`（`.answer-body`、`.answer-form` 样式）
- Modify: `src/item-card.test.ts`
- Modify: `plugins/jira/public/jira.js`（import 路径改成 `../../markdown.js`，让页面在 Task 9 删掉之前仍能跑）

**Interfaces:**
- Produces: `export function sessionRow(session, onUnbind, opts = {})`，`opts.onSent?: () => Promise<void>`——会话 `waiting` 时画 `button.item-answer`。
- Produces: `export function openAnswerSheet(sessionName, onSent)`——返回背板元素。
- Produces: i18n 键 `items.answer`、`items.answerTitle`、`items.answerLoading`、`items.answerNone`、`items.answerPlaceholder`、`items.send`、`items.sending`、`items.sendFailed`。

- [ ] **Step 1: 搬 Markdown**

```bash
git mv plugins/jira/public/markdown.js public/markdown.js
git mv src/jira-markdown.test.ts src/markdown.test.ts
```

`src/markdown.test.ts`：`from "../plugins/jira/public/markdown.js"` → `from "../public/markdown.js"`。`plugins/jira/public/jira.js`：`from "./markdown.js"` → `from "../../markdown.js"`（页面在 `/p/jira/` 下，`../../` 到根）。

```bash
bun test src/markdown.test.ts src/public-parses.test.ts 2>&1 | tail -3
```

Expected: 绿。

- [ ] **Step 2: 渲染测试**

`src/item-card.test.ts` 加（文件里 `PATCHED` 只垫 window/document；这几条需要 fetch，所以在用例内自己换、`finally` 里还原）：

```ts
async function withFetch(fake: (u: string, init?: RequestInit) => Promise<Response>, run: () => Promise<void>) {
  const real = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", { value: fake, writable: true, configurable: true });
  try {
    await run();
  } finally {
    Object.defineProperty(globalThis, "fetch", { value: real, writable: true, configurable: true });
  }
}

test("等你的会话行有「回答」按钮，在跑的没有", async () => {
  const { sessionRow } = await load();
  const waiting = sessionRow(session({ turn: "waiting" }), null);
  expect(waiting.querySelector(".item-answer")?.textContent).toBe(tr("items.answer"));
  const working = sessionRow(session({ turn: "working" }), null);
  expect(working.querySelector(".item-answer")).toBeNull();
});

test("回答浮层显示会话最后说的话，发送 POST 到 keys 端点并回调", async () => {
  const { openAnswerSheet } = await load();
  const asked: string[] = [];
  let sent = 0;
  await withFetch(async (u, init) => {
    asked.push(`${init?.method ?? "GET"} ${u}`);
    if (String(u).endsWith("/message")) return new Response(JSON.stringify({ text: "要**合并**吗？" }));
    return new Response(null, { status: 204 });
  }, async () => {
    const back = openAnswerSheet("甲", async () => { sent += 1; });
    await new Promise((r) => setTimeout(r, 20));
    expect(back.querySelector(".answer-body strong")?.textContent).toBe("合并");
    const input = back.querySelector<HTMLInputElement>(".answer-input")!;
    input.value = "合并吧";
    back.querySelector<HTMLFormElement>(".answer-form")!.dispatchEvent(new window.Event("submit", { cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(asked.some((a) => a.startsWith("POST") && a.includes("api/sessions/%E7%94%B2/keys"))).toBe(true);
    expect(sent).toBe(1);
    expect(document.querySelector(".answer-form")).toBeNull(); // 发成功就关
  });
});

test("发送失败留在浮层里，输入不清", async () => {
  const { openAnswerSheet } = await load();
  await withFetch(async (u) => {
    if (String(u).endsWith("/message")) return new Response(JSON.stringify({ text: "?" }));
    return new Response("gone", { status: 404 });
  }, async () => {
    const back = openAnswerSheet("甲", async () => {});
    await new Promise((r) => setTimeout(r, 20));
    const input = back.querySelector<HTMLInputElement>(".answer-input")!;
    input.value = "回一句";
    back.querySelector<HTMLFormElement>(".answer-form")!.dispatchEvent(new window.Event("submit", { cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(back.isConnected).toBe(true);
    expect(input.value).toBe("回一句");
    expect(back.querySelector(".answer-note")?.textContent).toBe(tr("items.sendFailed"));
  });
});

test("读不到最后一句时说明读不到", async () => {
  const { openAnswerSheet } = await load();
  await withFetch(async () => new Response(JSON.stringify({ text: null })), async () => {
    const back = openAnswerSheet("甲", async () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(back.querySelector(".answer-body")?.textContent).toBe(tr("items.answerNone"));
  });
});
```

- [ ] **Step 3: 跑，确认红**

```bash
bun test src/item-card.test.ts -t "回答|发送|读不到" 2>&1 | grep -E "^\(fail\)" | head
```

- [ ] **Step 4: i18n 键**

`public/i18n.js` 的 zh 字典（`items.` 那一组附近）加：

```js
  "items.answer": "回答",
  "items.answerTitle": "它在等你回答",
  "items.answerLoading": "读取中…",
  "items.answerNone": "没读到它最后说的话",
  "items.answerPlaceholder": "回一句…",
  "items.send": "发送",
  "items.sending": "发送中…",
  "items.sendFailed": "发送失败，会话可能已经结束",
```

en 字典加：

```js
  "items.answer": "Answer",
  "items.answerTitle": "Waiting on you",
  "items.answerLoading": "Reading…",
  "items.answerNone": "Could not read what it last said",
  "items.answerPlaceholder": "Reply…",
  "items.send": "Send",
  "items.sending": "Sending…",
  "items.sendFailed": "Could not send — the session may have ended",
```

- [ ] **Step 5: `openAnswerSheet` 与 `sessionRow`**

`public/item-card.js` 加 `import { parseMarkdown } from "./markdown.js";`，并把 `plugins/jira/public/jira.js` 里的 `renderSpans(parent, spans)` 和 `renderMarkdown(text)` 两个函数（把解析结果建成 DOM 节点的那两个）复制进来，改名不变。然后：

```js
/**
 * 会话停在"等你回答"时，就地看它问了什么、回一句。
 *
 * 从工单页搬进内核：它读的是会话的最后一条消息（GET /api/sessions/:name/message）、
 * 发的是 send-keys（POST /api/sessions/:name/keys），两条路由早就在内核里，跟
 * 哪个来源没有关系。为这一两句话先进终端、等 xterm 起来、再找输入框，正是
 * 这个浮层要省掉的那段路。
 *
 * 发成功就关，然后 onSent 让调用方重画——会话从"等你"变成"在跑"。失败留在
 * 浮层里、输入不清：最不该做的事是把人刚打的字扔掉。
 *
 * @param {string} sessionName
 * @param {() => Promise<void>} onSent
 * @returns {HTMLElement} 背板
 */
export function openAnswerSheet(sessionName, onSent) {
  const back = el("div", "sheet-backdrop");
  const sheet = el("div", "sheet");
  const close = () => back.remove();

  sheet.append(el("h2", "sheet-title", tr("items.answerTitle")));
  sheet.append(el("p", "sheet-name", sessionName));

  const body = el("div", "answer-body", tr("items.answerLoading"));
  sheet.append(body);

  const form = el("form", "answer-form");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "answer-input";
  input.placeholder = tr("items.answerPlaceholder");
  input.setAttribute("aria-label", tr("items.answerPlaceholder"));
  input.enterKeyHint = "send";
  input.autocapitalize = "off";
  input.setAttribute("autocorrect", "off");
  input.spellcheck = false;
  const send = el("button", "btn primary answer-send", tr("items.send"));
  send.type = "submit";
  const note = el("p", "answer-note");
  form.append(input, send);
  sheet.append(form, note);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    input.disabled = true;
    note.textContent = tr("items.sending");
    try {
      const res = await fetch(url(`api/sessions/${encodeURIComponent(sessionName)}/keys`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(String(res.status));
      close();
      await onSent();
    } catch {
      note.textContent = tr("items.sendFailed");
      send.disabled = false;
      input.disabled = false;
    }
  });

  const actions = el("div", "sheet-actions");
  const cancel = el("button", "btn", tr("items.close"));
  cancel.type = "button";
  cancel.addEventListener("click", close);
  const open = el("a", "btn", tr("items.open"));
  open.href = url(`terminal.html?target=${encodeURIComponent(sessionName)}`);
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  actions.append(cancel, open);
  sheet.append(actions);

  back.addEventListener("click", (e) => {
    if (e.target === back) close();
  });
  back.append(sheet);
  document.body.append(back);
  setTimeout(() => input.focus(), 50);

  fetch(url(`api/sessions/${encodeURIComponent(sessionName)}/message`))
    .then((r) => r.json())
    .then((got) => {
      if (got && typeof got.text === "string" && got.text) body.replaceChildren(...renderMarkdown(got.text));
      else body.textContent = tr("items.answerNone");
    })
    .catch(() => {
      body.textContent = tr("items.answerNone");
    });

  return back;
}
```

`sessionRow(session, onUnbind, opts = {})`：在 `link` 建好之后、`if (!onUnbind) return link;` 之前改成：

```js
  const waiting = stateOf(session) === "waiting";
  if (!onUnbind && !waiting) return link;

  const row = el("div", "item-session-row");
  row.append(link);
  if (waiting) {
    // 它在等你：一个"回答"入口，不用进终端。放在链接外面——button 不能嵌在 <a> 里。
    const answer = el("button", "item-answer", tr("items.answer"));
    answer.type = "button";
    answer.addEventListener("click", () => openAnswerSheet(session.name, opts.onSent ?? (async () => {})));
    row.append(answer);
  }
  if (onUnbind) {
    // …原来建 unbind 按钮的代码原样…
    row.append(unbind);
  }
  return row;
```

JSDoc 加 `@param {{onSent?: () => Promise<void>}} [opts]`。

`public/items.js` 里 `card.append(sessionRow(session, onChange))` 改成 `sessionRow(session, onChange, { onSent: onChange })`（表格视图里的同名调用一起改）。`public/item-panel.js` 的 `fill` 里 `sheet.append(sessionRow(session, null))` 改成 `sessionRow(session, null, { onSent: again })`，把 `again` 的定义提到会话行循环之前。

`public/style.css` 加：

```css
.item-answer { margin-left: 6px; padding: 2px 8px; border: 1px solid var(--border-2); border-radius: 6px; background: var(--surface-3); color: var(--text-1); font-size: 12px; }
.answer-body { margin: 8px 0; max-height: 40vh; overflow: auto; color: var(--text-1); white-space: pre-wrap; }
.answer-form { display: flex; gap: 8px; }
.answer-input { flex: 1; min-width: 0; }
.answer-note { min-height: 1.2em; color: var(--text-3); font-size: 12px; }
```

- [ ] **Step 6: 全量测试**

```bash
bun run typecheck && bun test src/item-card.test.ts src/items-page.test.ts src/item-panel.test.ts src/i18n.test.ts src/public-parses.test.ts src/markdown.test.ts src/themes.test.ts 2>&1 | tail -3
bun test 2>&1 | grep -E "^\(fail\)|^\(error\)" | sort | diff - /private/tmp/claude-501/-Users-lau-projects-tmux-next/24607655-e39d-4fea-9bf1-36b37f527f9b/scratchpad/baseline-fails.txt
```

- [ ] **Step 7: 提交**

```bash
git add public/markdown.js src/markdown.test.ts plugins/jira/public/jira.js public/item-card.js public/items.js public/item-panel.js public/i18n.js public/style.css src/item-card.test.ts
git commit -m "Answer a waiting session from its row, on every page that draws one

The Jira page's read-what-it-asked-and-reply sheet moves into the shared
session row, since it only ever spoke to kernel routes. Markdown
rendering comes along into public/."
```

---

## Task 9: 退役 Jira 页

**Files:**
- Delete: `plugins/jira/public/`（整个目录）、`src/jira-filter.test.ts`、`src/jira-refresh-state.test.ts`、`plugins/jira/session-name.test.ts`、`plugins/jira/bindings-shim.test.ts`
- Modify: `plugins/jira/server.ts`（删五条路由和 `jiraBindingsView`、`claimIssue`、`liveFromKernel`）
- Modify: `plugins/jira/plugin.js`（删 `page`、`icon`、`titleKey` 和只有页面用的字典键）
- Modify: `plugins/types.ts`（`titleKey`、`icon`、`page` 可选）
- Modify: `public/nav.js`（没有 `titleKey` 的插件不出 tab）
- Modify: `src/server.ts`（没有页面的插件 `/p/<id>/` 301 到首页）
- Modify: `plugins/registry.test.ts`、`src/plugin-routing.test.ts`、`src/back-target.test.ts`
- Modify: `src/i18n.test.ts`（若它把 `titleKey` 当必有项）

**Interfaces:**
- Produces: `Plugin.titleKey?`、`Plugin.icon?`、`Plugin.page?` 三个可选；有 `titleKey` 的插件才出 tab。
- Produces: `/p/<id>/` 对既无 `page` 也无 `public/index.html` 的插件答 `301 Location: ../../`。

- [ ] **Step 1: 路由测试先写**

`src/plugin-routing.test.ts`：

- 删掉 `test("查询串里的 jql 到不了 Jira——真正发出去的还是配置里那条", …)` 整条（它打的 `/api/jira/issues` 不复存在；"JQL 只来自配置"由 `sync()` 直接调 `fetchIssues(config, …)` 保证，`plugins/jira/sync-e2e.test.ts` 覆盖）。
- `test("jira 插件挂在自己的前缀下，未配置时如实说未配置")` 里删掉最后三行对 `/api/jira/issues` 的断言。
- 加：

```ts
test("没有页面的插件，/p/<id>/ 301 到首页", async () => {
  // jira 退役了自己的页面：清单没有 page，目录里也没有 public/index.html。
  const res = await fetch(`${base()}/p/jira/`, { redirect: "manual" });
  expect(res.status).toBe(301);
  expect(res.headers.get("location")).toBe("../../");
  const idx = await fetch(`${base()}/p/jira/index.html`, { redirect: "manual" });
  expect(idx.status).toBe(301);
});

test("没有页面的插件不在 /api/plugins 之外多出任何页面资源", async () => {
  expect((await fetch(`${base()}/p/jira/jira.js`)).status).toBe(404);
});
```

`plugins/registry.test.ts` 的"每个 id 合法、唯一，且不撞内核路由"里，`typeof p.titleKey`/`p.icon` 两组断言和 `p.i18n.en[p.titleKey]` 改成条件式：

```ts
  for (const p of PLUGINS) {
    if (p.titleKey === undefined) {
      // 没有页面的插件：不出 tab，也就不需要标题和图标。
      expect(p.page).toBeUndefined();
      continue;
    }
    expect(p.titleKey.length).toBeGreaterThan(0);
    expect(typeof p.icon).toBe("string");
    expect(p.icon!.length).toBeGreaterThan(0);
    expect(p.i18n.en[p.titleKey]).toBeDefined();
  }
```

`src/back-target.test.ts` 里 `{ id: "jira", path: "p/jira/", titleKey: "jira.title" }` 那份 `PAGES` 是测试自己的 fixture，不读注册表——保留，但 `jira.title` 会被 i18n 死键扫描判成"用了但字典里没有"吗？扫描只看 `titleKey: "…"` 这个字面量，而 fixture 正是这种写法。把 fixture 改成 `{ id: "gallery", path: "p/gallery/", titleKey: "gallery.title" }` 并把三处断言的期望值跟着改。

- [ ] **Step 2: 跑，确认红**

```bash
bun test src/plugin-routing.test.ts -t "没有页面" 2>&1 | tail -3
```

- [ ] **Step 3: 删页面与路由**

```bash
git rm -r plugins/jira/public
git rm src/jira-filter.test.ts src/jira-refresh-state.test.ts plugins/jira/session-name.test.ts plugins/jira/bindings-shim.test.ts
```

`plugins/jira/server.ts`：

- 删 `jiraBindingsView`、`claimIssue`、`liveFromKernel` 三个函数及注释。
- `handle()` 只留 `/api/jira/config` GET 那一段，其余（`issues`、`dev`、`bindings` GET/POST/DELETE）删掉。
- 删掉随之无用的 import（`bindSession`、`unbindSession`、`resolveBindings`……逐个 `grep -n` 后删；`resolveBindings`、`sessionIdentities` 仍被 `sync()` 用，留）。
- `mapLimited` 仍被 `sync()` 用，留。

`plugins/jira/plugin.js`：删 `titleKey`、`icon`、`page` 三个属性；`i18n` 两种语言里删这些键：`jira.title`、`jira.count`、`jira.empty`、`jira.unconfigured`、`jira.unconfiguredHint`、`jira.authFailed`、`jira.queryFailed`、`jira.unreachable`、`jira.refresh`、`jira.filterEpic`、`jira.filterStatus`、`jira.noneMatch`、`jira.refreshOne`、`jira.ciNone`、`jira.checksTitle`、`jira.close`、`jira.askedTitle`、`jira.loadingAsk`、`jira.askedNone`、`jira.replyPlaceholder`、`jira.send`、`jira.sending`、`jira.sendFailed`、`jira.prHidden`、`jira.newSession`、`jira.firstSession`、`jira.dead`、`jira.unbind`、`jira.open`。留下 `jira.cfg.*`、`jira.fullSync`、`jira.fullSyncDone` 和七个 `facetDims` 键。顶部注释里"页面外壳由内核生成"那行删掉，改成一句"这个插件没有页面：单在首页，它只是首页的一个数据源"。

- [ ] **Step 4: 清单可选项、nav、301**

`plugins/types.ts`：`titleKey: string` → `titleKey?: string`，注释加"没有页面的插件不出 tab，可以不给"；`icon: string` → `icon?: string`。

`public/nav.js`：`...PLUGINS.filter((p) => on.has(p.id)).map(...)` 改成 `...PLUGINS.filter((p) => on.has(p.id) && p.titleKey).map(...)`，`key: p.titleKey` 和 `icon: p.icon` 保持（此时已收窄为有值）。

`src/server.ts` 插件页面那段，在 `if (file === "index.html") { … }` 的 `plugin?.page` 判断之后、最后的 `return new Response("not found", …)` 之前加：

```ts
        // 没有页面的插件（清单没有 page，目录里也没有 index.html）：/p/<id>/ 是
        // 一个从前存在过的地址，手机上可能还有书签。答 301 到首页而不是 404——
        // 通用规则，不点名任何插件。相对的 Location，子路径部署下同样成立。
        if (file === "index.html") {
          return new Response(null, { status: 301, headers: { Location: "../../" } });
        }
```

（`legacyPaths` 的分支不动。）`pluginShell(plugin.id, plugin.titleKey, …)` 处 `titleKey` 现在可能是 `undefined`，改成 `plugin.titleKey ?? ""`。

- [ ] **Step 5: 全量测试与死键扫描**

```bash
bun run typecheck && bun test src/i18n.test.ts plugins/registry.test.ts src/plugin-routing.test.ts src/public-parses.test.ts src/responsive.test.ts src/themes.test.ts src/back-target.test.ts src/list-page.test.ts 2>&1 | tail -3
bun test 2>&1 | grep -E "^\(fail\)|^\(error\)" | sort | diff - /private/tmp/claude-501/-Users-lau-projects-tmux-next/24607655-e39d-4fea-9bf1-36b37f527f9b/scratchpad/baseline-fails.txt
```

`src/i18n.test.ts` 会指出任何漏删或漏加的键，按它的输出补。

- [ ] **Step 6: 提交**

```bash
git add -u plugins/jira plugins/types.ts public/nav.js src/server.ts plugins/registry.test.ts src/plugin-routing.test.ts src/back-target.test.ts
git add plugins/jira/plugin.js plugins/jira/server.ts
git commit -m "Retire the Jira tab page

The home page now carries everything it did. The plugin keeps its
settings, its config route and its data source; /p/jira/ answers 301 to
the home page for old bookmarks. A plugin without a page no longer needs
a titleKey or icon and gets no tab."
```

（`git add -u plugins/jira` 只暂存已跟踪文件的删除与修改，不会扫进别的目录。）

---

## Task 10: 拆分 `plugins/jira/server.ts`

**Files:**
- Create: `plugins/jira/cache.ts`、`plugins/jira/facets.ts`、`plugins/jira/source.ts`、`plugins/jira/settings.ts`
- Modify: `plugins/jira/server.ts`（只剩拼装）
- Modify: 测试 import：`enrich.test.ts`、`connector.test.ts`、`fields.test.ts`、`resolve-dev-ids.test.ts`、`issue-cache.test.ts`、`refresh-item.test.ts`、`sync*.test.ts`、`settings.test.ts`、`sync-log.test.ts`、`writeback.test.ts`（先 `grep -n 'from "./server"' plugins/jira/*.test.ts` 列全）
- Modify: `plugins/handlers.ts`（import 路径）

**Interfaces:**
- `cache.ts` 导出：`issues(refresh)`、`refreshIssue(key)`、`dev(issueId, issueKey, refresh)`、`mapLimited`、`ISSUE_CACHE_MS`、`DESC_CACHE_MS`、`DEV_CONCURRENCY`、`getCache()`（返回 `cache` 引用给 `sync` 判冷热）、`issueCache`、`devCache`、`descCache`、`getBrowseBase()`。
- `facets.ts` 导出：`facetsFor(item, issues, dev, browseBase)`，以及 `typeKey`、`epicSummaryOf`、`prGroupLabel`（被 `source.ts` 的 `fields` 用到的只有 `epicSummaryOf`）。
- `source.ts` 导出：`sync`、`refreshItem`、`enrich`、`fields`、`onLifecycleChange`、`devTargets`、`resolveDevIds`、`start`、`source: ItemSourceProvider`。
- `settings.ts` 导出：`readSettings`、`writeSettings`、`runAction`。
- `server.ts` 导出：`handle`，并 re-export `start`、`source`、`readSettings`、`writeSettings`、`runAction`。

- [ ] **Step 1: 按现有分段剪切**

`server.ts` 里从上到下的段落对应目标文件：

| 段 | 去向 |
|---|---|
| `CACHE_MS`、`cache`、`ISSUE_CACHE_MS`、`issueCache`、`issues()`、`DEV_CACHE_MS`、`devCache`、`repoNameCache`、`DEV_CONCURRENCY`、`dev()`、`mapLimited`、`refreshIssue`、`browseBase`（Task 6 加的） | `cache.ts` |
| `prFacetTone`、`prsFacetTone`、`checkFacetTone`、`checkFixPrompt`、`prGroupLabel`、`PR_ICON`、`CHECK_ICON`、`TYPE_ICONS`、`typeKey`、`epicSummaryOf`、`isoDate`、`facetsFor` | `facets.ts` |
| `enrich`、`DESC_CACHE_MS`、`descCache`、`fetchDescription`、`fields`、`devTargets`、`resolveDevIds`、`incrementalWindowMinutes`、`sync`、`refreshItem`、`jiraStatusFor`、`onLifecycleChange`、`browseUrl`、`start`、`source` | `source.ts` |
| `runAction`、`readSettings`、`writeSettings` | `settings.ts` |
| `handle` | 留在 `server.ts` |

`cache` 变量是 `let`，跨模块要用函数暴露：`cache.ts` 里加 `export function getCache() { return cache; }`，`source.ts` 的 `sync()` 里 `!cache` → `!getCache()`，`enrich()` 里 `cache?.result.ok` → `getCache()?.result.ok`。`issueCache`、`devCache` 直接 `export const`。`browseBase` 同理 `export function getBrowseBase()`。

每个新文件顶部保留原来对应段落的模块级注释（`server.ts` 开头那段"浏览器永不直连 Jira"的说明放到 `cache.ts` 顶部，因为对外请求都从那里出去）。

- [ ] **Step 2: `server.ts` 收成拼装**

```ts
import { readJiraConfig } from "./config";
export { start, source } from "./source";
export { readSettings, writeSettings, runAction } from "./settings";

/**
 * 工单插件的服务端入口。数据源在 source.ts，缓存在 cache.ts，chip 拼装在
 * facets.ts，设置在 settings.ts；这里只剩一条路由。
 */
export async function handle(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/jira/config" && req.method === "GET") {
    const config = await readJiraConfig();
    // token 从不出门。url 和 email 出门是为了页面能显示"连的是哪个实例"。
    return Response.json(
      config ? { configured: true, url: config.url, email: config.email } : { configured: false },
    );
  }
  return null;
}
```

`plugins/handlers.ts` 的 import 行不用改（`server.ts` 仍导出同名符号）。

- [ ] **Step 3: 改测试 import**

`grep -n 'from "./server"' plugins/jira/*.test.ts`，按符号改：`facetsFor` → `./facets`；`fields`、`DESC_CACHE_MS`、`devTargets`、`resolveDevIds`、`sync`、`refreshItem`、`enrich` → `./source`；`issues`、`refreshIssue`、`ISSUE_CACHE_MS` → `./cache`；`readSettings`、`writeSettings`、`runAction` → `./settings`。`DESC_CACHE_MS` 随 `fields` 进 `source.ts`。

- [ ] **Step 4: 全量测试**

```bash
bun run typecheck && bun test plugins/jira 2>&1 | tail -3
bun test 2>&1 | grep -E "^\(fail\)|^\(error\)" | sort | diff - /private/tmp/claude-501/-Users-lau-projects-tmux-next/24607655-e39d-4fea-9bf1-36b37f527f9b/scratchpad/baseline-fails.txt
wc -l plugins/jira/server.ts plugins/jira/cache.ts plugins/jira/facets.ts plugins/jira/source.ts plugins/jira/settings.ts
```

Expected: 全绿；`server.ts` 在 40 行以内。

- [ ] **Step 5: 提交**

```bash
git add plugins/jira/server.ts plugins/jira/cache.ts plugins/jira/facets.ts plugins/jira/source.ts plugins/jira/settings.ts plugins/jira/*.test.ts
git commit -m "Split the Jira plugin's server.ts along the seams its comments already drew

cache.ts holds the four caches and the fetch-through-cache helpers,
facets.ts the chip assembly, source.ts the ItemSourceProvider, and
settings.ts the settings-page hooks. server.ts is the config route plus
re-exports."
```

---

## Task 11: 文档

**Files:**
- Create: `docs/plugin-sources.md`
- Modify: `CLAUDE.md`、`README.md`、`README.zh-CN.md`

- [ ] **Step 1: 写 `docs/plugin-sources.md`**

内容就是 spec 第四部分那张表加上 `ItemSourceProvider` 的五个方法、三个预算、失败语义、`role` 与 tone 的约定、`url` 的白名单、"不在这里的就没有"。按 spec 里的表原样抄，加一段"怎么接一个新来源"的四步：在 `plugins/<id>/server.ts` 导出一个 `ItemSourceProvider`；在 `plugins/handlers.ts` 的 `SERVERS[id].sources` 里列出；`sync()` 里用 `ensureItemForSource(provider, ref, title, { refreshTitle: true, url })` 建单；`enrich()` 只读缓存。

- [ ] **Step 2: 改 CLAUDE.md**

架构一节里涉及以下内容的段落改写，改的是事实而不是重写整段：

- "Four exist: the artifacts gallery, the notification history, Jira issues, and the supervisor." → Jira 没有页面，是首页的一个数据源；三个有 tab。
- 提到 `provides` 的段落（"**\"Sync this source\" and \"refresh this one item\" are dispatched by the same manifest field…**" 和 "**The provider contract (`provides`) was rejected once…**"）：改成 `PluginServer.sources[]` + `ItemSourceProvider`，浏览器从 `/api/items` 的 `providers` 读，不再 import 注册表；保留"被推翻过一次"的那段历史，把结论改成现在的形状。
- "**`sync`/`refreshItem` get a 30-second budget…**"里 `isConsidered` 的描述改成 `sourceProviders()` 是 `TMUX_NEXT_DISABLE_PLUGINS` 对来源生效的唯一一处。
- 工作项那几段里 `src/items.ts`、`src/session-binding.ts`、`src/item-lifecycle.ts`、`src/item-facets.ts`、`src/item-fields.ts`、`src/migrate-items.ts` 的路径改成 `src/items/…`。
- 加一段：状态机按 `role` 读信号，不按维度名；这是内核唯一需要"理解"插件内容的地方。
- 加一段：会话行的「回答」是内核能力，三处共用 `sessionRow` 都有。

- [ ] **Step 3: 改两份 README**

`README.md` 功能表里 "**Jira issues**" 那一行改成"Jira (optional plugin): a data source for work items — syncs the issues assigned to you into the home page, and paints status, epic, PRs and CI checks on each card; configured on the settings page"。`README.zh-CN.md` 对应行同样改。其余提到 Jira 的句子（work items 那段、templates 那段）事实不变，不动。

- [ ] **Step 4: 提交**

```bash
git add docs/plugin-sources.md CLAUDE.md README.md README.zh-CN.md
git commit -m "Document the item source contract and the Jira plugin's new shape"
```

---

## Task 12: 手工验收

- [ ] **Step 1: 起服务，对照 spec 第六部分的清单逐项过**

```bash
bun run src/index.ts
```

在手机或窄窗口上：筛史诗、筛状态、看 PR、看检查、点 PR 链接、点史诗链接、开新会话、挂已有会话、解绑、回答一个等你的会话、单条刷新、全部同步、访问 `/p/jira/` 看它跳到首页。每项通过打勾，不通过的记下来修完再提交。

- [ ] **Step 2: 最终全量**

```bash
bun run test 2>&1 | grep -E "^\(fail\)|^\(error\)" | sort | diff - /private/tmp/claude-501/-Users-lau-projects-tmux-next/24607655-e39d-4fea-9bf1-36b37f527f9b/scratchpad/baseline-fails.txt
grep -rn "jira" src/ --include=*.ts | grep -vE "test\.ts|//|\* " || true
```

Expected: diff 为空；第二条 grep 只剩 `src/items/migrate.ts`（本轮保留的一次性迁移）。
