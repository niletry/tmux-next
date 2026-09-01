# 单子驱动 · 第 2 期：facet 接缝与单驱动的首页

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把首页从会话列表翻成单列表——单卡片带 facet chips 与它底下的会话，插件通过泛化后的 `enrich` 接缝贡献维度，视图层支持按任意维度分组与筛选。

**Architecture:** 插件接缝从 `annotate(sessions) → 文本` 泛化成 `enrich(items) → facets`，安全阀（300ms 超时、try/catch、截断、丢弃未问到的键）一字不改，只多一条每单 facet 上限。内核自己也产 facet 走同一条路，于是视图层不需要知道一个维度是内核的还是插件的。会话列表退成 `sessions.html`，`/` 变成单列表。

**Tech Stack:** Bun（无构建步骤）、TypeScript、`bun:test`、happy-dom、tmux 3.2+ 控制模式。零运行时依赖。

**Spec:** `docs/superpowers/specs/2026-09-01-work-item-driven-design.md`（「插件接缝」与「首页与视图」两节）

## Global Constraints

- **`bun` 不在 PATH 上，一律用 `~/.bun/bin/bun`。** `node_modules` 在 worktree 里是软链接、显示为未跟踪，**绝不 `git add -A`**，只按显式路径提交。
- **每一次 tmux 调用走 `src/tmux/run.ts` 的 `tmux(argv)`，绝不用 `Bun.$`。** 目标一律 `=<name>`。
- **绝不 `tmux kill-server`，绝不杀不是本轮自己建的会话。** 全量测试跑在与用户真实工作共用的 tmux server 上。破坏性命令前必须先检查目标并**读到结果**再执行。
- **每一条磁盘状态路径可用环境变量覆盖，且在函数体里现读**，测试绝不碰用户的 `~/.tmux-next/`。
- **UI 字符串一律进 `public/i18n.js`**，`src/i18n.test.ts` 会因为**键缺失、键没人用、或只有一种语言有**而变红——加键必须同时加 zh 与 en，且必须真的被引用。
- **样式里不许出现颜色字面量**，颜色只能来自 `public/themes.js` 派生的主题变量，`src/themes.test.ts` 守着内核样式表与每个插件样式表。
- **`public/` 下的页面脚本不做类型检查**（`checkJs: false`），只有测试能抓住空指针。**会渲染的浏览器模块必须有渲染测试**——`public-parses.test.ts` 只证明能解析、import 能解析，不证明它画得出东西。
- **浏览器共享模块用 `public/root.js` 的 `url()` 解析地址**，不要写绝对路径，否则反代子路径部署会坏。
- **提交信息不带任何助手署名**：不写 `Co-Authored-By`、`Claude-Session`、`🤖 Generated with`。仓库公开，历史清洗过一次。
- **不引入任何新依赖。**
- 命令：`~/.bun/bin/bun run typecheck`、`~/.bun/bin/bun test`、`~/.bun/bin/bun run test`（CI 等价物）。

## 文件结构

| 文件 | 职责 |
|---|---|
| `plugins/types.ts` | 改：`Annotation`/`PluginAnnotator` → `Facet`/`ItemRef`/`PluginEnricher` |
| `plugins/handlers.ts` | 改：`SERVERS` 声明 `enrich`；`collectAnnotations` → `collectFacets` |
| `src/plugin-enrich.test.ts` | 由 `src/plugin-annotate.test.ts` 改名而来，继承会抛/会卡的假插件 |
| `src/item-facets.ts` | 新：内核自己的 facet（agent 状态、会话数、目录、标签、来源） |
| `plugins/jira/server.ts` | 改：新增 `enrich`，从既有 60 秒缓存产状态/Epic/PR/检查四个维度 |
| `src/server.ts` | 改：`/api/items` 带上 facets；`/api/sessions` 去掉 annotations |
| `public/facet-view.js` | 新：纯逻辑——从数据算出维度选项、分组、筛选。`@ts-check`，无头可测 |
| `public/items.js` | 新：首页。单卡片、facet chips、会话行、未归单 |
| `public/sessions.html` | 新：会话列表搬到这里 |
| `public/index.html` | 改：变成单列表的页面外壳 |
| `public/nav.js` | 改：tab 变成 单·会话·制品·通知·工单 |
| `public/list.js` | 改：去掉 annotations 渲染（第 1 期起就没有生产者了） |

---

### Task 1: 接缝从 `annotate` 泛化成 `enrich`

第 1 期把 Jira 的 `annotate` 删了，于是这条通路**没有任何生产者**——`collectAnnotations` 每次 `/api/sessions` 都跑一遍空转，`public/list.js` 的 `renderAnnotations` 在生产里永远不会被调到。这一期把它整条换成 facet 版本，同时把会话列表那边的死路径清掉。

**安全阀一字不改**，它是这个口子能存在的唯一理由：300ms 硬超时、try/catch、失败语义唯一（拿不到就当没有）、截断、丢弃没被问到的键。新增一条：**每单最多 6 个 facet**。

`collectFacets` 继续把 enricher 表**作为参数**接收——注册表是编译期常量，没有这个参数就没法塞进"会抛的假插件"和"永远卡住的假插件"。

**Files:**
- Modify: `plugins/types.ts`、`plugins/handlers.ts`、`src/server.ts`（`/api/sessions` 去掉 annotations）、`public/list.js`（去掉 `renderAnnotations` 及其调用）
- Rename: `src/plugin-annotate.test.ts` → `src/plugin-enrich.test.ts`
- Delete: `src/list-annotations.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type Facet = { dim: string; value: string; tone?: "ok" | "warn" | "dim" }`
  - `type ItemRef = { id: string; source: { provider: string; ref: string } | null }`
  - `type PluginEnricher = (items: ItemRef[]) => Promise<Record<string, Facet[]>>`
  - `type PluginServer = { handle?: PluginHandler; enrich?: PluginEnricher }`
  - `ENRICHERS: Record<string, PluginEnricher>`、`ENRICH_TIMEOUT_MS = 300`、`MAX_FACETS_PER_ITEM = 6`
  - `collectFacets(items: ItemRef[], enrichers?: Record<string, PluginEnricher>): Promise<Record<string, Facet[]>>` —— 返回的是 **item id → 合并后的 facet 数组**，不按插件分层（首页要画的是一行 chips，不是按插件分组的 chips）

- [ ] **Step 1: 改名测试文件，写成 facet 版**

`git mv src/plugin-annotate.test.ts src/plugin-enrich.test.ts`，然后整体改写。**先读原文件**，把它那两个假插件（一个抛、一个永远卡住）原样保留——它们是这条口子的安全证据。

```ts
import { test, expect } from "bun:test";
import { collectFacets, ENRICH_TIMEOUT_MS, MAX_FACETS_PER_ITEM } from "../plugins/handlers";
import type { Facet, ItemRef, PluginEnricher } from "../plugins/types";

/**
 * 这条口子的失败语义只有一种：**拿不到就当没有**。插件抛了、超时了、返回了不是
 * 对象的东西，都只是这一轮没有 facet，首页照常渲染。内核的页面不能因为一个插件
 * 而出不来——这是开这个口子的唯一安全阀。
 *
 * enrichers 是参数而不是直接用 ENRICHERS，正是为了能在这里塞进假插件：注册表是
 * 编译期常量，没有这个参数就没法证明超时和 try/catch 真的会兜住。
 */

const items: ItemRef[] = [
  { id: "it-1", source: { provider: "jira", ref: "EXAMPLE-1" } },
  { id: "it-2", source: null },
];

const ok: PluginEnricher = async () => ({ "it-1": [{ dim: "jira.status", value: "In Progress" }] });
const throws: PluginEnricher = async () => {
  throw new Error("boom");
};
const hangs: PluginEnricher = () => new Promise(() => {});

test("没有插件时给空表", async () => {
  expect(await collectFacets(items, {})).toEqual({});
});

test("正常插件的 facet 收得到", async () => {
  expect(await collectFacets(items, { p: ok })).toEqual({
    "it-1": [{ dim: "jira.status", value: "In Progress" }],
  });
});

test("插件抛了，只是这一轮没有 facet", async () => {
  expect(await collectFacets(items, { bad: throws })).toEqual({});
});

test("一个插件抛了不影响另一个", async () => {
  expect(await collectFacets(items, { bad: throws, good: ok })).toEqual({
    "it-1": [{ dim: "jira.status", value: "In Progress" }],
  });
});

test("插件卡住时超时返回，不吊死页面", async () => {
  const started = Date.now();
  expect(await collectFacets(items, { slow: hangs })).toEqual({});
  expect(Date.now() - started).toBeLessThan(ENRICH_TIMEOUT_MS * 4);
});

test("卡住的插件不影响正常插件", async () => {
  expect(await collectFacets(items, { slow: hangs, good: ok })).toEqual({
    "it-1": [{ dim: "jira.status", value: "In Progress" }],
  });
});

test("返回不是对象时当作没有", async () => {
  const weird = (async () => ["nope"]) as unknown as PluginEnricher;
  expect(await collectFacets(items, { weird })).toEqual({});
});

// 插件只能标注被问到的单，不能塞进没要求的键。
test("没被问到的 item id 被丢掉", async () => {
  const sneaky: PluginEnricher = async () => ({
    "it-1": [{ dim: "a", value: "1" }],
    "it-999": [{ dim: "b", value: "2" }],
  });
  expect(await collectFacets(items, { sneaky })).toEqual({ "it-1": [{ dim: "a", value: "1" }] });
});

test("value 截断到 120 字符", async () => {
  const long: PluginEnricher = async () => ({ "it-1": [{ dim: "a", value: "x".repeat(500) }] });
  const got = await collectFacets(items, { long });
  expect(got["it-1"]![0]!.value.length).toBe(120);
});

test("dim 也截断，且没有 dim 或没有 value 的整条丢掉", async () => {
  const messy = (async () => ({
    "it-1": [
      { dim: "", value: "无维度" },
      { dim: "a", value: "" },
      { dim: "y".repeat(500), value: "有" },
    ],
  })) as unknown as PluginEnricher;
  const got = await collectFacets(items, { messy });
  expect(got["it-1"]!.length).toBe(1);
  expect(got["it-1"]![0]!.dim.length).toBe(120);
});

// 一个插件不能刷爆卡片。
test("每单最多 6 个 facet", async () => {
  const flood: PluginEnricher = async () => ({
    "it-1": Array.from({ length: 50 }, (_, i) => ({ dim: `d${i}`, value: String(i) })),
  });
  const got = await collectFacets(items, { flood });
  expect(got["it-1"]!.length).toBe(MAX_FACETS_PER_ITEM);
});

test("tone 只认三个值，别的丢掉", async () => {
  const toned = (async () => ({
    "it-1": [
      { dim: "a", value: "1", tone: "ok" },
      { dim: "b", value: "2", tone: "purple" },
    ],
  })) as unknown as PluginEnricher;
  const got = await collectFacets(items, { toned });
  expect(got["it-1"]![0]!.tone).toBe("ok");
  expect(got["it-1"]![1]!.tone).toBeUndefined();
});

// 两个插件给同一张单贴维度时，合并成一行 chips，而不是按插件分层。
test("多个插件的 facet 合并到同一张单下", async () => {
  const other: PluginEnricher = async () => ({ "it-1": [{ dim: "git.branch", value: "main" }] });
  const got = await collectFacets(items, { good: ok, other });
  expect(got["it-1"]!.length).toBe(2);
  expect(got["it-1"]!.map((f: Facet) => f.dim).sort()).toEqual(["git.branch", "jira.status"]);
});
```

- [ ] **Step 2: 跑一次确认它红**

Run: `~/.bun/bin/bun test src/plugin-enrich.test.ts`
Expected: FAIL —— `collectFacets` 不存在

- [ ] **Step 3: 改类型**

`plugins/types.ts`：删掉 `Annotation` 与 `PluginAnnotator`，换成——

```ts
/**
 * 插件贴在一张单上的一个维度。
 *
 * `dim` 是 **i18n 键**，不是显示文本（`jira.status`、`jira.epic`）。插件的字典本
 * 来就合并进内核字典，所以 `tr(dim)` 直接查得到，查不到就退回显示 dim 本身。
 *
 * 这条是整个设计能不违反"内核绝不点名插件"的关键：**内核里因此没有任何"哪个插件
 * 有哪些维度"的表**——维度是数据，跟着 facet 一起来。
 */
export type Facet = { dim: string; value: string; tone?: "ok" | "warn" | "dim" };

/**
 * 问插件时给它看的单。
 *
 * 传**全部**单给每个插件，不按 `source.provider === 插件 id` 预筛——预筛会在内核里
 * 写死"provider 名就是插件 id"这个等式，而那正是要守的那条线。让插件自己看 source
 * 挑，成本可以忽略（几十条），还顺带允许一个不绑定任何来源的插件（比如读 git 分支
 * 的）也贡献维度。
 */
export type ItemRef = { id: string; source: { provider: string; ref: string } | null };

/** 插件可选导出的维度函数。不认识的单不必出现在返回值里。 */
export type PluginEnricher = (items: ItemRef[]) => Promise<Record<string, Facet[]>>;
```

- [ ] **Step 4: 改 `plugins/handlers.ts`**

`PluginServer` 的 `annotate` 换成 `enrich`；`ANNOTATORS` 换成 `ENRICHERS`（仍从 `SERVERS` 推导）；`ANNOTATE_TIMEOUT_MS` 换成 `ENRICH_TIMEOUT_MS`；新增 `MAX_FACETS_PER_ITEM = 6`。`collectAnnotations` 换成：

```ts
/** 一条 facet 文本的上限，够放一个状态或一个史诗名，不够撑破一张卡片。 */
const MAX_TEXT = 120;

/** 一张卡片上最多几个 chips。上限在内核这边，不信插件自觉。 */
export const MAX_FACETS_PER_ITEM = 6;

/**
 * 向每个声明了维度能力的插件要一次 facet，合并成 item id → facet 数组。
 *
 * 失败语义只有一种：**拿不到就当没有**。插件抛了、超时了、返回了不是对象的东西，
 * 都只是这个插件这一轮没有维度，首页照常渲染。内核的页面不能因为一个插件而出不
 * 来——这是开这个口子的唯一安全阀，也是它可以被接受的原因。
 *
 * 不按插件分层返回：首页要画的是一行 chips，谁贴的不重要。分层只会让调用方再拍平
 * 一次，还得决定插件之间的顺序。
 *
 * enrichers 是参数而不是直接用 ENRICHERS，好让内核侧的测试能塞进一个会抛、一个会
 * 卡住的假插件——注册表是编译期写死的，没有这个参数就没法测这条安全阀。
 */
export async function collectFacets(
  items: ItemRef[],
  enrichers: Record<string, PluginEnricher> = ENRICHERS,
): Promise<Record<string, Facet[]>> {
  const enabled = new Set(enabledPlugins().map((p) => p.id));
  // 真实插件按启用状态过滤；测试注进来的假插件不在注册表里，一律放行。
  const entries = Object.entries(enrichers).filter(
    ([id]) => !PLUGINS.some((p) => p.id === id) || enabled.has(id),
  );
  const asked = new Set(items.map((i) => i.id));

  const results = await Promise.all(
    entries.map(async ([, enrich]) => {
      try {
        const timeout = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), ENRICH_TIMEOUT_MS),
        );
        const got = await Promise.race([enrich(items), timeout]);
        if (!got || typeof got !== "object" || Array.isArray(got)) return null;
        const clean: Record<string, Facet[]> = {};
        for (const [id, raw] of Object.entries(got)) {
          if (!asked.has(id)) continue; // 插件只能标注被问到的单
          if (!Array.isArray(raw)) continue;
          const facets: Facet[] = [];
          for (const one of raw) {
            const f = one as Record<string, unknown>;
            const dim = trim(f?.dim, MAX_TEXT);
            const value = trim(f?.value, MAX_TEXT);
            if (!dim || !value) continue;
            const tone =
              f?.tone === "ok" || f?.tone === "warn" || f?.tone === "dim" ? f.tone : undefined;
            facets.push({ dim, value, ...(tone ? { tone } : {}) });
          }
          if (facets.length) clean[id] = facets;
        }
        return clean;
      } catch {
        return null;
      }
    }),
  );

  // 合并各插件，再按单封顶——上限是"一张卡片上最多几个"，不是"每个插件最多几个"。
  const merged: Record<string, Facet[]> = {};
  for (const one of results) {
    if (!one) continue;
    for (const [id, facets] of Object.entries(one)) {
      (merged[id] ??= []).push(...facets);
    }
  }
  for (const id of Object.keys(merged)) merged[id] = merged[id]!.slice(0, MAX_FACETS_PER_ITEM);
  return merged;
}
```

- [ ] **Step 5: 清掉会话列表那边的死路径**

`src/server.ts` 的 `GET /api/sessions` 去掉 `annotations` 字段与 `collectAnnotations` 调用（响应变成 `{sessions, items}`）。`public/list.js` 删掉 `renderAnnotations` 函数、它的调用、以及 `card`/`groupOf`/`sections` 上一路传下来的 `annotations` 参数。接响应的地方保留裸数组兼容分支。

`git rm src/list-annotations.test.ts` —— 它测的是"list.js 不认识 jira 这个词、标注只走 textContent"，而被测的那条路径整条没了。**这不是删掉一条碍事的测试**：它守的东西（插件不能往内核列表里塞标记）在新接缝上由 `plugin-enrich.test.ts` 的截断与丢弃断言继续守着，而 chips 的渲染由 Task 7 的 happy-dom 测试守。在提交信息里说清这一点。

- [ ] **Step 6: 跑测试**

Run: `~/.bun/bin/bun test src/plugin-enrich.test.ts src/list-page.test.ts src/public-parses.test.ts && ~/.bun/bin/bun run typecheck`
Expected: 全 PASS

- [ ] **Step 7: 跑全量**

Run: `~/.bun/bin/bun test`
Expected: 全绿。删了 `list-annotations.test.ts` 会让总数下降，把下降数对上账再往下走。

- [ ] **Step 8: 提交**

```bash
git add plugins/types.ts plugins/handlers.ts src/server.ts public/list.js src/plugin-enrich.test.ts
git rm src/plugin-annotate.test.ts src/list-annotations.test.ts
git commit -m "refactor: 插件接缝从会话标注泛化成单的维度，安全阀原样保留"
```

---

### Task 2: 内核自己的 facet

内核也产 facet，走同一条路，于是视图层的 group-by 不需要知道一个维度是内核的还是插件的——这正是"视图后边可以慢慢优化"能成立的前提。

**Files:**
- Create: `src/item-facets.ts`
- Test: `src/item-facets.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Facet` 类型；`src/items.ts` 的 `WorkItem`；`src/tmux/session-list.ts` 的 `SessionSummary`；`src/session-binding.ts` 的 `ResolvedBinding`
- Produces: `kernelFacets(items: WorkItem[], sessions: SessionSummary[], bindings: ResolvedBinding[]): Record<string, Facet[]>` —— 纯函数，不碰磁盘也不碰 tmux

维度与取值：

| dim | 取值 | tone |
|---|---|---|
| `item.agent` | `waiting` / `working` / `idle` / `none` | `warn` / `ok` / `dim` / `dim` |
| `item.sessions` | 会话条数（字符串） | 无 |
| `item.cwd` | 目录的 basename | 无 |
| `item.source` | `source.provider` | 无 |
| `item.tag` | 每个标签一个 facet | 无 |

`item.agent` 的判断顺序：**任一会话在等你 → `waiting`**（这是最要紧的那个，一张单只要有一个会话在等，整张单就该排在前面）；否则任一在跑 → `working`；否则有活着的会话 → `idle`；否则 `none`。会话的轮次优先看 `turn`（从 transcript 的 `stop_reason` 读，是记录格式的一部分），读不到再退回屏幕推出来的 `idle`。

- [ ] **Step 1: 写下会失败的测试**

创建 `src/item-facets.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑一次确认它红**

Run: `~/.bun/bin/bun test src/item-facets.test.ts`
Expected: FAIL —— `Cannot find module './item-facets'`

- [ ] **Step 3: 写实现**

创建 `src/item-facets.ts`：

```ts
import { basename } from "node:path";
import type { Facet } from "../plugins/types";
import type { WorkItem } from "./items";
import type { SessionSummary } from "./tmux/session-list";
import type { ResolvedBinding } from "./session-binding";

/**
 * 内核自己的维度。
 *
 * 跟插件贴上来的走同一条路、同一种形状，于是视图层的 group-by 不需要知道一个维度
 * 是内核的还是插件的——这正是"视图后边可以慢慢优化"能成立的前提。
 *
 * 纯函数：不碰磁盘、不碰 tmux。要什么由调用方查好了传进来，于是这里能无头地测。
 */

/** 一张单的 agent 状态：等你 › 在跑 › 闲着 › 没有会话。 */
type AgentState = "waiting" | "working" | "idle" | "none";

const AGENT_TONE: Record<AgentState, Facet["tone"]> = {
  waiting: "warn",
  working: "ok",
  idle: "dim",
  none: "dim",
};

/**
 * 一条会话此刻算在跑还是在等。
 *
 * `turn` 优先：它从 transcript 的 stop_reason 读出来，是记录格式的一部分。读不到
 * 才退回 `idle`——那是认 TUI 屏幕上的空闲标记，会随 agent 改版无声失效，所以只当
 * 兜底，不当依据。
 */
function stateOf(session: SessionSummary): "waiting" | "working" {
  if (session.turn) return session.turn;
  return session.idle ? "waiting" : "working";
}

/**
 * 一张单的 agent 状态。
 *
 * 只要有**一个**会话在等你，整张单就算等你——手机上第一眼要回答的是"该我动了吗"，
 * 而一个在等的会话不该被同一张单下另一个正在跑的会话盖过去。
 */
function agentState(sessions: SessionSummary[]): AgentState {
  if (!sessions.length) return "none";
  const states = sessions.map(stateOf);
  if (states.includes("waiting")) return "waiting";
  if (states.includes("working")) return "working";
  return "idle";
}

export function kernelFacets(
  items: WorkItem[],
  sessions: SessionSummary[],
  bindings: ResolvedBinding[],
): Record<string, Facet[]> {
  const byName = new Map(sessions.map((s) => [s.name, s]));
  // 只认还活着的绑定：一条指向已死会话的记录是"这张单之前开过"，不是它现在的状态。
  const liveByItem = new Map<string, SessionSummary[]>();
  for (const b of bindings) {
    if (!b.live) continue;
    const found = byName.get(b.session);
    if (!found) continue;
    const list = liveByItem.get(b.itemId);
    if (list) list.push(found);
    else liveByItem.set(b.itemId, [found]);
  }

  const out: Record<string, Facet[]> = {};
  for (const item of items) {
    const mine = liveByItem.get(item.id) ?? [];
    const state = agentState(mine);
    const facets: Facet[] = [
      { dim: "item.agent", value: state, tone: AGENT_TONE[state] },
      { dim: "item.sessions", value: String(mine.length) },
    ];
    if (item.cwd) facets.push({ dim: "item.cwd", value: basename(item.cwd) });
    if (item.source) facets.push({ dim: "item.source", value: item.source.provider });
    for (const tag of item.tags) facets.push({ dim: "item.tag", value: tag });
    out[item.id] = facets;
  }
  return out;
}
```

- [ ] **Step 4: 跑测试**

Run: `~/.bun/bin/bun test src/item-facets.test.ts && ~/.bun/bin/bun run typecheck`
Expected: 13 个测试 PASS

- [ ] **Step 5: 提交**

```bash
git add src/item-facets.ts src/item-facets.test.ts
git commit -m "feat: 内核自己的单维度，与插件贴的走同一条路"
```

---

### Task 3: Jira 插件贡献维度

`annotate` 没了，换成 `enrich`：一张挂了 jira 来源的单 → 状态、史诗、PR 数、检查红绿。

**它仍然不在 `enrich` 里访问 Jira。** 这条路每次页面加载都跑、预算 300ms，一次网络往返进不来，而且按页加载去打 Jira 会把速率限制撞穿。继续读已有的两个内存缓存（工单列表 60 秒、PR/检查 5 分钟），**缓存未命中就少给几个维度**——那是正确的降级，比阻塞或给陈旧值都好。

**Files:**
- Modify: `plugins/jira/server.ts`（新增 `enrich` 导出）、`plugins/handlers.ts`（`jira: { handle, enrich }`）、`plugins/jira/plugin.js`（四个 dim 的 i18n 键）
- Test: `plugins/jira/enrich.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Facet` / `ItemRef` / `PluginEnricher`
- Produces: `enrich(items: ItemRef[]): Promise<Record<string, Facet[]>>`，以及可注入缓存的纯函数
  `facetsFor(item: ItemRef, issues: Map<string, Issue>, dev: Map<string, DevResult>): Facet[]`

维度：`jira.status`（工单状态，`statusCategory === "done"` 给 `dim`，`indeterminate` 给 `ok`）、`jira.epic`（父史诗名）、`jira.prs`（PR 条数）、`jira.checks`（`失败数/总数`，有失败给 `warn`，全过给 `ok`；`checksKnown` 为 false 时**不产这个维度**——"没问到"和"没有检查"是两回事）。

- [ ] **Step 1: 写下会失败的测试**

创建 `plugins/jira/enrich.test.ts`。**先读 `plugins/jira/client.ts` 的 `Issue` 与 `plugins/jira/dev.ts` 的 `DevResult`/`PullRequest`/`Check`**，按它们真实的字段名构造夹具，不要照抄下面的形状而不核对：

```ts
import { test, expect } from "bun:test";
import { facetsFor } from "./server";
import type { Issue } from "./client";
import type { DevResult } from "./dev";
import type { ItemRef } from "../types";

/**
 * 这条路每次页面加载都跑，预算 300ms——所以 enrich 只读已有缓存，绝不发请求。
 * 缓存没命中就少给几个维度，那是正确的降级。这份测试因此把缓存作为参数喂进来。
 */

const jiraItem: ItemRef = { id: "it-1", source: { provider: "jira", ref: "EXAMPLE-1" } };
const localItem: ItemRef = { id: "it-2", source: null };

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: "10001",
    key: "EXAMPLE-1",
    summary: "修登录页",
    status: "In Progress",
    statusCategory: "indeterminate",
    updated: 0,
    ...over,
  } as Issue;
}

const dims = (facets: ReturnType<typeof facetsFor>) =>
  Object.fromEntries(facets.map((f) => [f.dim, f.value]));

test("没有来源的单，一个维度都不给", () => {
  expect(facetsFor(localItem, new Map(), new Map())).toEqual([]);
});

test("来源不是 jira 的单，一个维度都不给", () => {
  const other: ItemRef = { id: "it-3", source: { provider: "github", ref: "12" } };
  expect(facetsFor(other, new Map([["EXAMPLE-1", issue()]]), new Map())).toEqual([]);
});

// 缓存没命中就少给几个维度，而不是阻塞、也不是给陈旧值。
test("缓存里没有这个单号时，不给维度也不抛", () => {
  expect(facetsFor(jiraItem, new Map(), new Map())).toEqual([]);
});

test("有工单就给状态", () => {
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue()]]), new Map());
  expect(dims(got)["jira.status"]).toBe("In Progress");
});

test("已完成的工单，状态给 dim 色", () => {
  const got = facetsFor(
    jiraItem,
    new Map([["EXAMPLE-1", issue({ status: "Done", statusCategory: "done" })]]),
    new Map(),
  );
  expect(got.find((f) => f.dim === "jira.status")!.tone).toBe("dim");
});

test("进行中的工单，状态给 ok 色", () => {
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue()]]), new Map());
  expect(got.find((f) => f.dim === "jira.status")!.tone).toBe("ok");
});

test("有史诗就给史诗名", () => {
  const got = facetsFor(
    jiraItem,
    new Map([["EXAMPLE-1", issue({ epicName: "登录改版" } as Partial<Issue>)]]),
    new Map(),
  );
  expect(dims(got)["jira.epic"]).toBe("登录改版");
});

test("PR 数按 dev 缓存给", () => {
  const dev: DevResult = {
    ok: true,
    prs: [
      { id: "1", title: "a", url: "u", status: "OPEN", checks: [], checksKnown: true },
      { id: "2", title: "b", url: "u", status: "OPEN", checks: [], checksKnown: true },
    ],
  } as unknown as DevResult;
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue()]]), new Map([["10001", dev]]));
  expect(dims(got)["jira.prs"]).toBe("2");
});

test("检查全过给 ok 色", () => {
  const dev: DevResult = {
    ok: true,
    prs: [
      {
        id: "1", title: "a", url: "u", status: "OPEN", checksKnown: true,
        checks: [{ name: "ci", state: "SUCCESSFUL" }, { name: "lint", state: "SUCCESSFUL" }],
      },
    ],
  } as unknown as DevResult;
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue()]]), new Map([["10001", dev]]));
  const checks = got.find((f) => f.dim === "jira.checks")!;
  expect(checks.value).toBe("0/2");
  expect(checks.tone).toBe("ok");
});

test("有检查失败给 warn 色", () => {
  const dev: DevResult = {
    ok: true,
    prs: [
      {
        id: "1", title: "a", url: "u", status: "OPEN", checksKnown: true,
        checks: [{ name: "ci", state: "FAILED" }, { name: "lint", state: "SUCCESSFUL" }],
      },
    ],
  } as unknown as DevResult;
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue()]]), new Map([["10001", dev]]));
  const checks = got.find((f) => f.dim === "jira.checks")!;
  expect(checks.value).toBe("1/2");
  expect(checks.tone).toBe("warn");
});

// 「没问到」和「没有检查」是两回事，收成一个会让页面往好看的方向撒谎。
test("checksKnown 为 false 时不产检查维度", () => {
  const dev: DevResult = {
    ok: true,
    prs: [{ id: "1", title: "a", url: "u", status: "OPEN", checks: [], checksKnown: false }],
  } as unknown as DevResult;
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue()]]), new Map([["10001", dev]]));
  expect(dims(got)["jira.checks"]).toBeUndefined();
  expect(dims(got)["jira.prs"]).toBe("1");
});

test("dev 缓存里是失败结果时，只是没有 PR 维度", () => {
  const dev = { ok: false, reason: "auth" } as unknown as DevResult;
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue()]]), new Map([["10001", dev]]));
  expect(dims(got)["jira.prs"]).toBeUndefined();
  expect(dims(got)["jira.status"]).toBe("In Progress");
});
```

**若 `Issue` 上没有史诗名字段**（第 1 期之前它带的是 `parent`，字段名以真实类型为准），把那条测试和实现里的取值改成真实字段，并在报告里说明——**不要**为此往 `Issue` 上加字段。

- [ ] **Step 2: 跑一次确认它红**

Run: `~/.bun/bin/bun test plugins/jira/enrich.test.ts`
Expected: FAIL —— `facetsFor` 未导出

- [ ] **Step 3: 写实现**

在 `plugins/jira/server.ts` 里加纯函数 `facetsFor` 和薄薄的 `enrich`：

```ts
/**
 * 一张单能从两个缓存里读出哪些维度。纯函数，缓存当参数喂进来，于是能无头地测。
 *
 * 只认 source 是 jira 的单——传进来的是**全部**单（内核不按 provider 预筛，那会在
 * 内核里写死"provider 名就是插件 id"），挑是这边的事。
 */
export function facetsFor(
  item: ItemRef,
  issues: Map<string, Issue>,
  dev: Map<string, DevResult>,
): Facet[] {
  if (item.source?.provider !== "jira") return [];
  const issue = issues.get(item.source.ref);
  if (!issue) return []; // 缓存没命中：少给几个维度，不阻塞、不给陈旧值

  const facets: Facet[] = [
    {
      dim: "jira.status",
      value: issue.status,
      tone: issue.statusCategory === "done" ? "dim" : issue.statusCategory === "indeterminate" ? "ok" : undefined,
    },
  ];
  // 史诗名的字段以 client.ts 的 Issue 为准。
  if (issue.epicName) facets.push({ dim: "jira.epic", value: issue.epicName });

  const got = dev.get(issue.id);
  if (got?.ok) {
    facets.push({ dim: "jira.prs", value: String(got.prs.length) });
    // 只统计问到过检查的 PR：checksKnown 为 false 是"我们没问到"，跟"没有检查"是
    // 两回事，收成一个数字会让页面往好看的方向撒谎。
    const known = got.prs.filter((pr) => pr.checksKnown);
    const all = known.flatMap((pr) => pr.checks);
    if (known.length && all.length) {
      const failed = all.filter((c) => c.state === "FAILED").length;
      facets.push({
        dim: "jira.checks",
        value: `${failed}/${all.length}`,
        tone: failed ? "warn" : "ok",
      });
    }
  }
  return facets;
}

/**
 * 内核每次画首页都会调这里，预算 300ms——**绝不发请求**，只读已有缓存。
 *
 * 一次网络往返进不了这个预算，而且按页加载去打 Jira 会把速率限制撞穿。缓存没命中
 * 就少给几个维度，那是正确的降级。
 */
export async function enrich(items: ItemRef[]): Promise<Record<string, Facet[]>> {
  const issues = new Map<string, Issue>(
    cache?.result.ok ? cache.result.issues.map((i) => [i.key, i]) : [],
  );
  const devs = new Map([...devCache].map(([id, hit]) => [id, hit.result]));

  const out: Record<string, Facet[]> = {};
  for (const item of items) {
    const facets = facetsFor(item, issues, devs);
    if (facets.length) out[item.id] = facets;
  }
  return out;
}
```

`plugins/handlers.ts` 改成 `jira: { handle: jira, enrich: jiraEnrich }`（import 时改名，跟原来 `annotate` 的写法一致）。

- [ ] **Step 4: 加四个维度名的 i18n 键**

`plugins/jira/plugin.js` 的 `i18n.zh` 与 `i18n.en` **两边都加**（少一边 `src/i18n.test.ts` 会红）：

```js
// zh
"jira.status": "状态",
"jira.epic": "史诗",
"jira.prs": "PR",
"jira.checks": "检查",
```

```js
// en
"jira.status": "Status",
"jira.epic": "Epic",
"jira.prs": "PRs",
"jira.checks": "Checks",
```

**注意 `jira.filterEpic`/`jira.filterStatus` 已经存在**，别跟它们搞混，也别删——工单页自己的筛选器还在用。

- [ ] **Step 5: 跑测试**

Run: `~/.bun/bin/bun test plugins/ src/i18n.test.ts && ~/.bun/bin/bun run typecheck`
Expected: 全 PASS，包括 `plugins/registry.test.ts`

- [ ] **Step 6: 提交**

```bash
git add plugins/jira/server.ts plugins/jira/plugin.js plugins/jira/enrich.test.ts plugins/handlers.ts
git commit -m "feat: Jira 把状态、史诗、PR 与检查作为维度贴到单上，只读缓存不发请求"
```

---

### Task 4: `/api/items` 带上 facets

**Files:**
- Modify: `src/server.ts`（`GET /api/items`）
- Test: `src/items-api.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `collectFacets`、Task 2 的 `kernelFacets`
- Produces: `GET /api/items` → `{ items: WorkItem[], bindings: ResolvedBinding[], sessions: SessionSummary[], facets: Record<string, Facet[]> }`

**为什么响应里要带 `sessions`**：首页每张卡片下要画它的会话行（状态、最后动作、进入），那些字段只有会话摘要里有。让首页再打一次 `/api/sessions` 就是两次请求各拿一半、还可能拿到两个时刻的状态——同一张卡片上"单说有 2 个会话、下面只列出 1 个"就是这么来的。一次请求一个时刻。

- [ ] **Step 1: 写下会失败的测试**

在 `src/items-api.test.ts` 追加（沿用该文件已有的 `at()` / `json()` / `makeItem()` 助手）：

```ts
test("列表带上 facets，没有单时是空表", async () => {
  const body = (await (await fetch(at("/api/items"))).json()) as { facets: Record<string, unknown> };
  expect(body.facets).toEqual({});
});

test("一张没有会话的单，内核给出 agent=none 与 sessions=0", async () => {
  const created = await makeItem("孤零零的单");
  const body = (await (await fetch(at("/api/items"))).json()) as {
    facets: Record<string, Array<{ dim: string; value: string }>>;
  };
  const dims = Object.fromEntries((body.facets[created.id] ?? []).map((f) => [f.dim, f.value]));
  expect(dims["item.agent"]).toBe("none");
  expect(dims["item.sessions"]).toBe("0");
});

test("带 cwd 的单给出目录维度", async () => {
  const created = await makeItem("有目录的单", { cwd: "/tmp/orbit" });
  const body = (await (await fetch(at("/api/items"))).json()) as {
    facets: Record<string, Array<{ dim: string; value: string }>>;
  };
  const dims = Object.fromEntries((body.facets[created.id] ?? []).map((f) => [f.dim, f.value]));
  expect(dims["item.cwd"]).toBe("orbit");
});

// 首页要在一次请求里拿齐画卡片需要的东西：单、绑定、会话摘要、维度。
// 分两次请求会让同一张卡片上的「几个会话」和下面列出的会话来自两个时刻。
test("列表同时带上会话摘要", async () => {
  const body = (await (await fetch(at("/api/items"))).json()) as { sessions: unknown };
  expect(Array.isArray(body.sessions)).toBe(true);
});
```

- [ ] **Step 2: 跑一次确认它红**

Run: `~/.bun/bin/bun test src/items-api.test.ts`
Expected: FAIL —— 响应里没有 `facets`

- [ ] **Step 3: 改路由**

`src/server.ts` 的 `GET /api/items`：

```ts
      if (url.pathname === "/api/items" && req.method === "GET") {
        const [items, live] = await Promise.all([readItems(), listSessions()]);
        const bindings = await resolveBindings(
          live.map((s) => ({ name: s.name, sessionId: s.sessionId })),
        );
        // 内核的维度和插件的合并成一张表：视图层不该知道一个维度是谁产的。
        const mine = kernelFacets(items, live, bindings);
        const theirs = await collectFacets(
          items.map((i) => ({
            id: i.id,
            source: i.source ? { provider: i.source.provider, ref: i.source.ref } : null,
          })),
        );
        const facets: Record<string, Facet[]> = {};
        for (const item of items) {
          facets[item.id] = [...(mine[item.id] ?? []), ...(theirs[item.id] ?? [])];
        }
        return Response.json({ items, bindings, sessions: live, facets });
      }
```

**注意这里用 `listSessions()` 而不是 `sessionIdentities()`**：响应要带完整的会话摘要给卡片画，那正是 `listSessions` 的产出。第 1 期把这条路上的 `sessionIdentities()` 换进来是因为当时只要 `{name, sessionId}`；现在需求变了，换回去是对的，不是把那次优化改回来——`plugins/jira/server.ts` 的 `liveFromKernel` 仍然只要身份，**保持用 `sessionIdentities()` 不动**。

- [ ] **Step 4: 跑测试**

Run: `~/.bun/bin/bun test src/items-api.test.ts && ~/.bun/bin/bun run typecheck`
Expected: 全 PASS

- [ ] **Step 5: 跑全量并提交**

Run: `~/.bun/bin/bun test`

```bash
git add src/server.ts src/items-api.test.ts
git commit -m "feat: /api/items 一次给齐单、绑定、会话与维度"
```

---

### Task 5: `public/facet-view.js` —— 分组与筛选的纯逻辑

**选项从当前数据里出现过的 facet 现算**，不维护一张写死的维度表——沿用工单页 `plugins/jira/public/filter.js` 已经在用的做法（**先读它**）。这一层单独成文件、`@ts-check`、无头可测，因为它是这一期唯一真有判断的逻辑，而页面文件不做类型检查。

**Files:**
- Create: `public/facet-view.js`
- Test: `src/facet-view.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Facet` 形状（浏览器侧用 JSDoc 描述，不 import 类型）
- Produces:
  - `dimensionsOf(facets): string[]` —— 数据里出现过的维度，按首次出现排序
  - `valuesOf(facets, dim): string[]` —— 某个维度出现过的取值，去重、按出现排序
  - `groupItems(items, facets, dim): Array<{ value: string, items: T[] }>` —— 按维度分组；同一张单在某维度上有多个取值（例如多个标签）时**进入每一组**；没有该维度的单落进最后一个 `value: ""` 的组
  - `filterItems(items, facets, selected): T[]` —— `selected` 是 `{ [dim]: string[] }`，同一维度内是或、跨维度是与
  - `AGENT_ORDER: string[]` —— `item.agent` 分组的固定顺序：`waiting` › `working` › `idle` › `none`

- [ ] **Step 1: 写下会失败的测试**

创建 `src/facet-view.test.ts`：

```ts
import { test, expect } from "bun:test";
import {
  dimensionsOf,
  valuesOf,
  groupItems,
  filterItems,
  AGENT_ORDER,
} from "../public/facet-view.js";

/**
 * 视图层的判断全在这里，而页面文件不做类型检查——所以这一层单独成文件，无头地测。
 *
 * 维度与取值都是**从当前数据里现算**的，不维护写死的表：加一个插件维度不该需要动
 * 这个文件。
 */

const items = [
  { id: "a", title: "甲" },
  { id: "b", title: "乙" },
  { id: "c", title: "丙" },
];

const facets = {
  a: [
    { dim: "item.agent", value: "waiting" },
    { dim: "jira.status", value: "In Progress" },
    { dim: "item.tag", value: "急" },
  ],
  b: [
    { dim: "item.agent", value: "idle" },
    { dim: "jira.status", value: "In Progress" },
  ],
  c: [{ dim: "item.agent", value: "waiting" }],
};

test("维度按首次出现的顺序列出，去重", () => {
  expect(dimensionsOf(facets)).toEqual(["item.agent", "jira.status", "item.tag"]);
});

test("没有数据时没有维度", () => {
  expect(dimensionsOf({})).toEqual([]);
});

test("取值去重且按出现顺序", () => {
  expect(valuesOf(facets, "item.agent")).toEqual(["waiting", "idle"]);
  expect(valuesOf(facets, "jira.status")).toEqual(["In Progress"]);
});

test("不存在的维度没有取值", () => {
  expect(valuesOf(facets, "nope")).toEqual([]);
});

test("按维度分组", () => {
  const groups = groupItems(items, facets, "jira.status");
  expect(groups.map((g) => g.value)).toEqual(["In Progress", ""]);
  expect(groups[0]!.items.map((i) => i.id)).toEqual(["a", "b"]);
  expect(groups[1]!.items.map((i) => i.id)).toEqual(["c"]);
});

// 没有这个维度的单不能凭空消失——它们落进最后一组。
test("缺这个维度的单落进最后一个空组", () => {
  const groups = groupItems(items, facets, "item.tag");
  expect(groups[groups.length - 1]!.value).toBe("");
  expect(groups[groups.length - 1]!.items.map((i) => i.id)).toEqual(["b", "c"]);
});

// 一张单可以有多个标签，它在每个标签下都该出现。
test("一张单在某维度上有多个取值时进入每一组", () => {
  const multi = { a: [{ dim: "item.tag", value: "急" }, { dim: "item.tag", value: "前端" }] };
  const groups = groupItems([{ id: "a", title: "甲" }], multi, "item.tag");
  expect(groups.map((g) => g.value)).toEqual(["急", "前端"]);
  expect(groups[0]!.items.map((i) => i.id)).toEqual(["a"]);
  expect(groups[1]!.items.map((i) => i.id)).toEqual(["a"]);
});

// 手机上第一眼要回答的是「该我动了吗」，所以 agent 维度不按出现顺序，按紧急程度。
test("按 agent 分组时用固定顺序，不按出现顺序", () => {
  const groups = groupItems(items, facets, "item.agent");
  expect(groups.map((g) => g.value)).toEqual(["waiting", "idle"]);
  expect(AGENT_ORDER).toEqual(["waiting", "working", "idle", "none"]);
});

test("空的分组不出现", () => {
  const groups = groupItems(items, facets, "item.agent");
  expect(groups.some((g) => g.items.length === 0)).toBe(false);
});

test("没有筛选时原样返回", () => {
  expect(filterItems(items, facets, {}).map((i) => i.id)).toEqual(["a", "b", "c"]);
  expect(filterItems(items, facets, { "item.agent": [] }).map((i) => i.id)).toEqual(["a", "b", "c"]);
});

test("同一维度内多选是或", () => {
  const got = filterItems(items, facets, { "item.agent": ["waiting", "idle"] });
  expect(got.map((i) => i.id)).toEqual(["a", "b", "c"]);
});

test("跨维度是与", () => {
  const got = filterItems(items, facets, {
    "item.agent": ["waiting"],
    "jira.status": ["In Progress"],
  });
  expect(got.map((i) => i.id)).toEqual(["a"]);
});

test("筛掉所有单时返回空表，不抛", () => {
  expect(filterItems(items, facets, { "item.agent": ["nope"] })).toEqual([]);
});

test("没有 facet 记录的单在有筛选时被筛掉", () => {
  const got = filterItems([...items, { id: "d", title: "丁" }], facets, {
    "item.agent": ["waiting"],
  });
  expect(got.map((i) => i.id)).toEqual(["a", "c"]);
});
```

- [ ] **Step 2: 跑一次确认它红**

Run: `~/.bun/bin/bun test src/facet-view.test.ts`
Expected: FAIL —— 找不到 `../public/facet-view.js`

- [ ] **Step 3: 写实现**

创建 `public/facet-view.js`：

```js
// @ts-check
/**
 * 首页的分组与筛选。
 *
 * 维度和取值都**从当前数据里现算**，不维护一张写死的表——加一个插件维度不该需要
 * 动这个文件，这正是 facet 这套设计要买到的东西。做法沿用工单页 filter.js 的先例。
 *
 * 单独成文件、`@ts-check`、无头可测：页面文件不做类型检查，而这一层是这一期唯一
 * 真有判断的地方，一个空指针就能让整页画不出来。
 */

/** @typedef {{ dim: string, value: string, tone?: "ok" | "warn" | "dim" }} Facet */
/** @typedef {Record<string, Facet[]>} FacetMap */

/**
 * `item.agent` 的分组顺序：手机上第一眼要回答的是「该我动了吗」，所以这个维度按
 * 紧急程度排，不按数据里的出现顺序。别的维度没有天然次序，就按出现顺序。
 */
export const AGENT_ORDER = ["waiting", "working", "idle", "none"];

const AGENT_DIM = "item.agent";

/**
 * 数据里出现过的维度，按首次出现排序、去重。
 * @param {FacetMap} facets
 * @returns {string[]}
 */
export function dimensionsOf(facets) {
  const out = [];
  const seen = new Set();
  for (const list of Object.values(facets ?? {})) {
    for (const f of list ?? []) {
      if (seen.has(f.dim)) continue;
      seen.add(f.dim);
      out.push(f.dim);
    }
  }
  return out;
}

/**
 * 某个维度出现过的取值，去重、按出现排序。
 * @param {FacetMap} facets
 * @param {string} dim
 * @returns {string[]}
 */
export function valuesOf(facets, dim) {
  const out = [];
  const seen = new Set();
  for (const list of Object.values(facets ?? {})) {
    for (const f of list ?? []) {
      if (f.dim !== dim || seen.has(f.value)) continue;
      seen.add(f.value);
      out.push(f.value);
    }
  }
  return out;
}

/**
 * 一张单在某维度上的全部取值。
 * @param {FacetMap} facets
 * @param {string} id
 * @param {string} dim
 * @returns {string[]}
 */
function valuesFor(facets, id, dim) {
  return (facets?.[id] ?? []).filter((f) => f.dim === dim).map((f) => f.value);
}

/**
 * 按维度分组。
 *
 * 一张单在这个维度上有多个取值（多个标签）时**进入每一组**——它确实同时属于那几
 * 组，挑一个显示等于骗人。没有这个维度的单落进最后一个 `value: ""` 的组，绝不让它
 * 凭空消失。
 *
 * @template {{ id: string }} T
 * @param {T[]} items
 * @param {FacetMap} facets
 * @param {string} dim
 * @returns {Array<{ value: string, items: T[] }>}
 */
export function groupItems(items, facets, dim) {
  /** @type {Map<string, T[]>} */
  const byValue = new Map();
  /** @type {T[]} */
  const missing = [];

  for (const item of items) {
    const values = valuesFor(facets, item.id, dim);
    if (!values.length) {
      missing.push(item);
      continue;
    }
    for (const value of values) {
      const list = byValue.get(value);
      if (list) list.push(item);
      else byValue.set(value, [item]);
    }
  }

  const order =
    dim === AGENT_DIM
      ? AGENT_ORDER.filter((v) => byValue.has(v))
      : [...byValue.keys()];

  const groups = order.map((value) => ({ value, items: byValue.get(value) ?? [] }));
  if (missing.length) groups.push({ value: "", items: missing });
  return groups;
}

/**
 * 按选中的取值筛选。同一维度内是**或**，跨维度是**与**。
 *
 * 取值为空数组的维度当作没选，而不是当作"一个都不匹配"——清空一个筛选器应该是回到
 * 全部，不是清空页面。
 *
 * @template {{ id: string }} T
 * @param {T[]} items
 * @param {FacetMap} facets
 * @param {Record<string, string[]>} selected
 * @returns {T[]}
 */
export function filterItems(items, facets, selected) {
  const active = Object.entries(selected ?? {}).filter(([, vs]) => vs && vs.length);
  if (!active.length) return items;
  return items.filter((item) =>
    active.every(([dim, wanted]) => {
      const mine = valuesFor(facets, item.id, dim);
      return mine.some((v) => wanted.includes(v));
    }),
  );
}
```

- [ ] **Step 4: 跑测试**

Run: `~/.bun/bin/bun test src/facet-view.test.ts && ~/.bun/bin/bun run typecheck`
Expected: 15 个测试 PASS。`public/facet-view.js` 带 `// @ts-check`，所以 typecheck 会检查它——JSDoc 里的泛型标注要能过。

- [ ] **Step 5: 提交**

```bash
git add public/facet-view.js src/facet-view.test.ts
git commit -m "feat: 分组与筛选的纯逻辑，维度从数据现算"
```

---

### Task 6: 首页变成单列表，会话列表搬到 `sessions.html`

**这一期的可见回报就在这个任务**：打开应用看到的是你的单，每张单下面挂着它的会话。facet chips 和视图控件分别在 Task 7、8 加上去，这一步先把轴心翻过来。

会话列表**不消失**——"这台机器上现在有哪些 tmux 会话"仍然是个正当问题，而且外部起的会话要有地方看。它退成一个 tab。

**Files:**
- Create: `public/sessions.html`、`public/items.js`
- Modify: `public/index.html`（变成单列表的外壳）、`public/nav.js`（五个 tab）、`public/i18n.js`、`public/style.css`
- Test: `src/items-page.test.ts`（新，happy-dom）；`src/nav-tabs.test.ts`（追加）

**Interfaces:**
- Consumes: Task 4 的 `GET /api/items` → `{items, bindings, sessions, facets}`
- Produces: 页面标识 `"items"`（`renderHeader("items")`），供 `nav.js` 高亮当前 tab

**卡片的形状**：标题（点进 `/p/jira/?key=…`，仅当来源是 jira）· 来源徽标 · 底下每个会话一小行（名字、状态词、进入）· 「再开一个会话」。底部一个固定分组「未归单」，收所有没有绑定的会话。

**会话行是精简版，不是把 `list.js` 的卡片搬过来。** `list.js` 的卡片有置顶、结束会话、操作浮层、恢复横幅——六百行，为"挑一个会话进去"这件事服务。单卡片下的会话行只回答"它现在什么状态、点进去"。**不要**为此把 `list.js` 拆开重构：那是另一件事，而重复的是十几行，不是六百行。

- [ ] **Step 1: 加 i18n 键**

`public/i18n.js` 的 zh 与 en **两边都加**，且每一条下面都会真的用到（`src/i18n.test.ts` 会因为没人用的键变红）：

```js
// zh
"items.title": "单",
"items.loading": "加载中…",
"items.empty": "还没有单",
"items.emptyHint": "从工单认领一个，或者开会话时新建一张",
"items.count": "{n} 个",
"items.offline": "无法连接到服务",
"items.sessions": "{n} 个会话",
"items.newSession": "再开一个会话",
"items.firstSession": "开一个会话",
"items.open": "进入",
"items.unassigned": "未归单",
"items.agent.waiting": "等你回答",
"items.agent.working": "工作中",
"items.agent.idle": "闲着",
"items.agent.none": "没有会话",
```

```js
// en
"items.title": "Work",
"items.loading": "Loading…",
"items.empty": "No work items yet",
"items.emptyHint": "Claim one from an issue, or create one when you start a session",
"items.count": "{n}",
"items.offline": "Cannot reach the service",
"items.sessions": "{n} session(s)",
"items.newSession": "New session",
"items.firstSession": "Start a session",
"items.open": "Open",
"items.unassigned": "No work item",
"items.agent.waiting": "Waiting on you",
"items.agent.working": "Working",
"items.agent.idle": "Idle",
"items.agent.none": "No sessions",
```

- [ ] **Step 2: 写下会失败的渲染测试**

创建 `src/items-page.test.ts`。**先读 `src/list-page.test.ts`**，照抄它的 happy-dom 脚手架——尤其是 `PATCHED` 那张替换过的全局清单和 `afterEach` 的还原：Bun 在一个进程里跑全部测试，覆盖了 `fetch` 不还原曾经弄红过别的文件里 38 个测试。`PAGE` 必须写成 `new URL("../public/items.js", import.meta.url).pathname`，**绝不能**写死绝对路径（`src/hygiene.test.ts` 会拦，而且写死会让测试悄悄读主仓库那份文件）。

```ts
const NOW = Math.floor(Date.now() / 1000);

function item(over = {}) {
  return { id: "it-1", title: "修登录页", cwd: "/tmp/x", source: null, tags: [], createdAt: NOW, closedAt: null, ...over };
}
function session(over = {}) {
  return { name: "甲", sessionId: "$1", windowWidth: 80, windowHeight: 24, lastActivityEpoch: NOW,
    attached: false, preview: [], pendingInput: null, idle: false, pinned: false, claudeId: null,
    task: null, path: "/tmp/x", lastAction: null, turn: null, agent: null, itemId: null, ...over };
}
const payload = (over = {}) => ({ items: [], bindings: [], sessions: [], facets: {}, ...over });

test("一张单画成一张卡片", async () => {
  const root = await mount(payload({ items: [item()] }));
  expect(root.querySelector(".item-title")?.textContent).toBe("修登录页");
});

test("没有单时给空状态而不是空白页", async () => {
  const root = await mount(payload());
  expect(root.querySelector(".empty")?.textContent).toBeTruthy();
});

test("单下面列出它的会话", async () => {
  const root = await mount(payload({
    items: [item()],
    sessions: [session({ name: "跑测试" })],
    bindings: [{ session: "跑测试", itemId: "it-1", live: true }],
  }));
  expect(root.querySelector(".item-session")?.textContent).toContain("跑测试");
});

// 一张单可以有多个会话，这是整个设计的轴心，不是边角情况。
test("一张单可以挂多个会话", async () => {
  const root = await mount(payload({
    items: [item()],
    sessions: [session({ name: "跑测试" }), session({ name: "改代码", sessionId: "$2" })],
    bindings: [
      { session: "跑测试", itemId: "it-1", live: true },
      { session: "改代码", itemId: "it-1", live: true },
    ],
  }));
  expect(root.querySelectorAll(".item-session").length).toBe(2);
});

test("已经死掉的绑定不画成会话行", async () => {
  const root = await mount(payload({
    items: [item()],
    sessions: [],
    bindings: [{ session: "没了", itemId: "it-1", live: false }],
  }));
  expect(root.querySelectorAll(".item-session").length).toBe(0);
});

// 没有绑定的会话不消失、也不变成假单——它们进「未归单」。
test("没有绑定的会话进未归单分组", async () => {
  const root = await mount(payload({ items: [item()], sessions: [session({ name: "随手开的" })] }));
  const unassigned = root.querySelector(".unassigned");
  expect(unassigned?.textContent).toContain("随手开的");
});

test("没有未归单的会话时不画那个分组", async () => {
  const root = await mount(payload({ items: [item()] }));
  expect(root.querySelector(".unassigned")).toBeNull();
});

test("来源是 jira 的单，标题链到工单页", async () => {
  const root = await mount(payload({
    items: [item({ source: { provider: "jira", ref: "EXAMPLE-1" } })],
  }));
  const link = root.querySelector("a.item-title");
  expect(link?.getAttribute("href")).toContain("EXAMPLE-1");
});

test("没有来源的单，标题不是链接", async () => {
  const root = await mount(payload({ items: [item()] }));
  expect(root.querySelector("a.item-title")).toBeNull();
});

test("服务挂了时给离线提示，不是空白页", async () => {
  const root = await mountFailing();
  expect(root.querySelector(".empty")?.textContent).toBeTruthy();
});

// 后端答了个旧形状（裸数组、缺字段）时不能整页炸掉。
test("响应缺字段时降级而不是抛", async () => {
  const root = await mount({ items: [item()] });
  expect(root.querySelector(".item-title")?.textContent).toBe("修登录页");
});
```

`mount()` 打桩 `url("api/items")`；`mountFailing()` 让那次 `fetch` 抛。两者都照 `list-page.test.ts` 的写法。

- [ ] **Step 3: 跑一次确认它红**

Run: `~/.bun/bin/bun test src/items-page.test.ts`
Expected: FAIL —— 找不到 `public/items.js`

- [ ] **Step 4: 建两个页面外壳**

`public/sessions.html`：把现在的 `public/index.html` 原样复制过来，只把 `<title data-i18n="list.title">` 保留、`<script type="module" src="list.js">` 保留。**`crossorigin="use-credentials"` 那行一个字都不能少**——反代要求登录时，少了它 PWA 安装会无声失败。

`public/index.html` 改成单列表的外壳：`<title data-i18n="items.title">`、`<main id="items">`、`<script type="module" src="items.js">`，其余（视口、manifest 那行、图标、样式表、`<header id="header">`）原样不动。

- [ ] **Step 5: 写 `public/items.js`**

```js
import { initTheme } from "./theme-apply.js";
import { initLang, tr } from "./i18n-apply.js";
import { renderHeader } from "./nav.js";
import { url } from "./root.js";

initTheme();
initLang().then(() => {
  renderHeader("items");
  render();
});

const root = document.getElementById("items");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const setCount = (text) => {
  const node = document.getElementById("count");
  if (node) node.textContent = text;
};

/**
 * 一条会话此刻的状态词。
 *
 * 跟 src/item-facets.ts 的 stateOf 同一套判断：turn 优先（它读的是 transcript 的
 * stop_reason，是记录格式的一部分），读不到才退回屏幕推出来的 idle。两边说法必须
 * 一致——同一个会话在卡片上和在维度里给出不同状态，比没有状态更糟。
 */
function sessionState(session) {
  const state = session.turn ?? (session.idle ? "waiting" : "working");
  return tr(`items.agent.${state}`);
}

/** 一张单下的一行会话：它现在什么状态，点进去。别的动作在会话页上。 */
function sessionRow(session) {
  const row = el("a", "item-session");
  row.href = url(`terminal.html?session=${encodeURIComponent(session.name)}`);
  row.append(el("span", "s-name", session.name));
  row.append(el("span", "s-state", sessionState(session)));
  return row;
}

/**
 * 单卡片。
 *
 * 「再开一个会话」永远在，不是「打开」——一张单多个会话是常态，不是边角情况。
 */
function itemCard(item, sessions) {
  const card = el("article", "item-card");

  const head = el("div", "item-head");
  if (item.source?.provider === "jira") {
    const link = el("a", "item-title", item.title);
    link.href = url(`p/jira/?key=${encodeURIComponent(item.source.ref)}`);
    head.append(link);
  } else {
    head.append(el("h2", "item-title", item.title));
  }
  if (item.source) head.append(el("span", "item-source", item.source.ref));
  card.append(head);

  for (const session of sessions) card.append(sessionRow(session));

  const more = el("a", "item-new", sessions.length ? tr("items.newSession") : tr("items.firstSession"));
  more.href = url(`new.html?item=${encodeURIComponent(item.id)}`);
  card.append(more);
  return card;
}

/** 没有绑定的会话。不变成假单、也不藏起来——一个明确的待归类区。 */
function unassignedGroup(sessions) {
  const group = el("section", "unassigned");
  group.append(el("h2", "group-name", tr("items.unassigned")));
  for (const session of sessions) group.append(sessionRow(session));
  return group;
}

function renderEmpty(message, hint) {
  root.replaceChildren();
  const box = el("p", "empty", message);
  if (hint) box.append(el("span", "hint", hint));
  root.append(box);
}

async function render() {
  let body;
  try {
    const res = await fetch(url("api/items"));
    if (!res.ok) throw new Error(String(res.status));
    body = await res.json();
  } catch {
    renderEmpty(tr("items.offline"));
    return;
  }

  // 后端可能是旧版本，缺字段就当空——半新半旧的服务是常态，不是异常。
  const items = Array.isArray(body?.items) ? body.items : [];
  const sessions = Array.isArray(body?.sessions) ? body.sessions : [];
  const bindings = Array.isArray(body?.bindings) ? body.bindings : [];

  setCount(tr("items.count", { n: items.length }));

  const byName = new Map(sessions.map((s) => [s.name, s]));
  const mine = new Map();
  const bound = new Set();
  for (const b of bindings) {
    if (!b.live) continue;
    const found = byName.get(b.session);
    if (!found) continue;
    bound.add(b.session);
    const list = mine.get(b.itemId);
    if (list) list.push(found);
    else mine.set(b.itemId, [found]);
  }

  const open = items.filter((i) => !i.closedAt);
  const loose = sessions.filter((s) => !bound.has(s.name));

  root.replaceChildren();
  if (!open.length && !loose.length) {
    renderEmpty(tr("items.empty"), tr("items.emptyHint"));
    return;
  }
  for (const item of open) root.append(itemCard(item, mine.get(item.id) ?? []));
  if (loose.length) root.append(unassignedGroup(loose));
}
```

- [ ] **Step 6: 改导航**

`public/nav.js` 的 `tabs` 变成——单在最前（它是首页），会话跟上，插件照旧从清单来：

```js
  const tabs = [
    { page: "items", href: url("./"), key: "items.title", icon: ICONS.items },
    { page: "sessions", href: url("sessions.html"), key: "list.title", icon: ICONS.sessions },
    ...PLUGINS.filter((p) => on.has(p.id)).map((p) => ({
      page: p.id,
      href: url(`p/${p.id}/`),
      key: p.titleKey,
      icon: p.icon,
    })),
  ];
```

`ICONS` 加一个 `items`（24×24 viewBox 的 path 串，跟现有图标同一套 stroke 风格；用一个方框加勾选的形状，跟 `sessions` 那个列表图标分得开）。

**`renderHeader` 里那个 `＋` 按钮跳 `new.html` 保持不动**：新建流程改成先选单是第 3 期的事。

- [ ] **Step 7: 追加导航测试**

`src/nav-tabs.test.ts` 追加：断言第一个 tab 的 `href` 指向应用根、`aria-current` 落在传入的当前页上、会话 tab 指向 `sessions.html`。**先读该文件**，沿用它已有的写法。

- [ ] **Step 8: 加样式**

`public/style.css` 加 `.item-card`、`.item-head`、`.item-title`、`.item-source`、`.item-session`、`.s-name`、`.s-state`、`.item-new`、`.unassigned`。**颜色只能用主题变量**（`var(--fg)`、`var(--dim)`、`var(--card)`、`color-mix`），`src/themes.test.ts` 会拦住任何字面量。长标题要能截断：`min-width: 0` + `overflow: hidden` + `text-overflow: ellipsis`，别把行撑破。

- [ ] **Step 9: 跑测试**

Run: `~/.bun/bin/bun test src/items-page.test.ts src/nav-tabs.test.ts src/i18n.test.ts src/themes.test.ts src/public-parses.test.ts src/list-page.test.ts && ~/.bun/bin/bun run typecheck`
Expected: 全 PASS

- [ ] **Step 10: 跑全量并手工看一眼**

Run: `~/.bun/bin/bun test`

手工验证：**不要用默认端口 7682**，这台机器上很可能正跑着服务用户手机的真实实例；也**不要**用真实状态目录，真 CLI 启动会对 `~/.tmux-next/` 跑迁移。用 scratch 目录 + 端口 17682：

```bash
TMUX_NEXT_ITEMS_PATH=<scratch>/items.json \
TMUX_NEXT_BINDINGS_PATH=<scratch>/bindings.json \
TMUX_NEXT_JIRA_DIR=<scratch>/jira \
~/.bun/bin/bun run src/index.ts --port 17682
```

打开 `http://127.0.0.1:17682/` 看首页、`/sessions.html` 看会话列表，确认两个 tab 都能到。跑完停掉。前后各确认一次 `~/.tmux-next/items.json` 与 `bindings.json` **不存在**，把两次检查贴进报告。**绝不删 `~/.tmux-next/` 下的任何东西**，出现了就停下来报告。

- [ ] **Step 11: 提交**

```bash
git add public/items.js public/index.html public/sessions.html public/nav.js public/i18n.js public/style.css src/items-page.test.ts src/nav-tabs.test.ts
git commit -m "feat: 首页变成单列表，会话列表退成一个 tab"
```

---

### Task 7: 卡片上的 facet chips

**Files:**
- Modify: `public/items.js`、`public/style.css`
- Test: `src/items-page.test.ts`（追加）

**Interfaces:**
- Consumes: Task 4 响应里的 `facets`；`tr(dim)` 查维度名

- [ ] **Step 1: 写下会失败的测试**

```ts
const facets = { "it-1": [
  { dim: "item.agent", value: "waiting", tone: "warn" },
  { dim: "jira.status", value: "In Progress", tone: "ok" },
] };

test("卡片画出 facet chips", async () => {
  const root = await mount(payload({ items: [item()], facets }));
  expect(root.querySelectorAll(".facet").length).toBe(2);
});

// dim 是 i18n 键：内核里没有"哪个插件有哪些维度"的表，维度名跟着数据来。
test("维度名走字典，查不到就显示 dim 本身", async () => {
  const root = await mount(payload({
    items: [item()],
    facets: { "it-1": [{ dim: "some.unknown.dim", value: "x" }] },
  }));
  expect(root.querySelector(".facet")?.textContent).toContain("some.unknown.dim");
});

test("agent 维度的取值走字典而不是显示英文", async () => {
  const root = await mount(payload({ items: [item()], facets }));
  const chip = [...root.querySelectorAll(".facet")].find((n) => n.textContent.includes("waiting"));
  expect(chip).toBeUndefined();
});

test("tone 变成 class，没有 tone 就没有那个 class", async () => {
  const root = await mount(payload({ items: [item()], facets }));
  expect(root.querySelector(".facet.warn")).not.toBeNull();
  expect(root.querySelector(".facet.ok")).not.toBeNull();
});

test("没有 facet 的单不画 chips 区，也不抛", async () => {
  const root = await mount(payload({ items: [item()], facets: {} }));
  expect(root.querySelectorAll(".facet").length).toBe(0);
  expect(root.querySelector(".item-title")?.textContent).toBe("修登录页");
});
```

- [ ] **Step 2: 跑一次确认它红**；**Step 3: 实现**

`items.js` 加：

```js
/**
 * 一个维度 chip。
 *
 * `dim` 是 i18n 键不是显示文本，查不到就退回显示 dim 本身——内核里没有"哪个插件
 * 有哪些维度"的表，维度名跟着数据一起来，这条是这套设计不违反插件界线的关键。
 *
 * `item.agent` 的取值也走字典（waiting/working/idle/none 是内部词，不该给人看）；
 * 别的维度的取值是数据（工单状态、史诗名），原样显示。
 */
function facetChip(facet) {
  const label = tr(facet.dim);
  const value = facet.dim === "item.agent" ? tr(`items.agent.${facet.value}`) : facet.value;
  const chip = el("span", facet.tone ? `facet ${facet.tone}` : "facet");
  chip.append(el("span", "f-dim", label));
  chip.append(el("span", "f-value", value));
  chip.title = `${label}: ${value}`;
  return chip;
}
```

`itemCard` 多接一个 `facets` 参数，在 head 之后插一行 `.facets` 容器（有 facet 才插）。`render()` 里把 `body.facets?.[item.id] ?? []` 传进去。

- [ ] **Step 4: 样式**：`.facets` 一行、可换行；`.facet` 小号圆角；`.facet.ok` / `.facet.warn` / `.facet.dim` 的颜色**只用主题变量**。

- [ ] **Step 5: 跑测试并提交**

Run: `~/.bun/bin/bun test src/items-page.test.ts src/themes.test.ts src/i18n.test.ts && ~/.bun/bin/bun run typecheck`

```bash
git add public/items.js public/style.css src/items-page.test.ts
git commit -m "feat: 单卡片画出维度 chips，维度名与 agent 取值走字典"
```

---

### Task 8: 分组与筛选的控件

**Files:**
- Modify: `public/items.js`、`public/style.css`、`public/i18n.js`
- Test: `src/items-page.test.ts`（追加）

**Interfaces:**
- Consumes: Task 5 的 `dimensionsOf` / `valuesOf` / `groupItems` / `filterItems`

默认 group-by = `item.agent`（手机上第一眼要回答的是"该我动了吗"）。视图选择存 `localStorage`，逐设备——"这块屏怎么看"是设备的事，跟字号同类；主题存机器是另一回事。

- [ ] **Step 1: 加 i18n 键**（zh/en 两边）：`"items.groupBy": "分组" / "Group by"`、`"items.groupNone": "不分组" / "None"`、`"items.filter": "筛选" / "Filter"`、`"items.noneMatch": "没有符合筛选的单" / "No items match the filter"`。

- [ ] **Step 2: 写下会失败的测试**

```ts
test("默认按 agent 状态分组，等你回答的排在最前", async () => {
  const root = await mount(payload({
    items: [item({ id: "it-1", title: "闲的" }), item({ id: "it-2", title: "等你的" })],
    facets: {
      "it-1": [{ dim: "item.agent", value: "idle" }],
      "it-2": [{ dim: "item.agent", value: "waiting" }],
    },
  }));
  const headers = [...root.querySelectorAll(".group-name")].map((n) => n.textContent);
  expect(headers[0]).toBe(tr("items.agent.waiting"));
});

test("分组选择器的选项从数据里现算", async () => {
  const root = await mount(payload({
    items: [item()],
    facets: { "it-1": [{ dim: "item.agent", value: "idle" }, { dim: "jira.status", value: "In Progress" }] },
  }));
  const options = [...root.querySelectorAll("#group-by option")].map((o) => o.value);
  expect(options).toContain("jira.status");
});

test("存下来的分组选择在下次打开时生效", async () => {
  const store = { "tmux-next.items.groupBy": "jira.status" };
  const root = await mount(payload({
    items: [item()],
    facets: { "it-1": [{ dim: "jira.status", value: "In Progress" }] },
  }), store);
  expect(root.querySelector(".group-name")?.textContent).toBe("In Progress");
});

test("存的是一个数据里已经没有的维度时退回默认，不是空页", async () => {
  const store = { "tmux-next.items.groupBy": "gone.dim" };
  const root = await mount(payload({
    items: [item()],
    facets: { "it-1": [{ dim: "item.agent", value: "idle" }] },
  }), store);
  expect(root.querySelectorAll(".item-card").length).toBe(1);
});

test("筛到没有单时说清楚，而不是空白", async () => {
  const store = { "tmux-next.items.filter": JSON.stringify({ "item.agent": ["nope"] }) };
  const root = await mount(payload({
    items: [item()],
    facets: { "it-1": [{ dim: "item.agent", value: "idle" }] },
  }), store);
  expect(root.querySelector(".empty")?.textContent).toContain(tr("items.noneMatch"));
});

test("localStorage 里是坏 JSON 时当作没有筛选", async () => {
  const store = { "tmux-next.items.filter": "{ not json" };
  const root = await mount(payload({ items: [item()] }), store);
  expect(root.querySelectorAll(".item-card").length).toBe(1);
});

// 未归单永远在最后，不参与分组也不被筛掉——它是待归类区，不是一个维度取值。
test("未归单不受分组与筛选影响", async () => {
  const store = { "tmux-next.items.filter": JSON.stringify({ "item.agent": ["nope"] }) };
  const root = await mount(payload({
    items: [item()],
    sessions: [session({ name: "随手开的" })],
    facets: { "it-1": [{ dim: "item.agent", value: "idle" }] },
  }), store);
  expect(root.querySelector(".unassigned")?.textContent).toContain("随手开的");
});
```

- [ ] **Step 3: 实现**

`items.js` 顶部 `import { dimensionsOf, valuesOf, groupItems, filterItems } from "./facet-view.js";`

加一个工具条：`<select id="group-by">` 的选项 = `["", ...dimensionsOf(facets)]`（`""` 是「不分组」），加每个维度的取值 chips 作为筛选开关。读写两个 `localStorage` 键：`tmux-next.items.groupBy`、`tmux-next.items.filter`。

**三条降级**：存的维度在当前数据里不存在 → 退回默认 `item.agent`；筛选 JSON 坏了 → 当作没有筛选；筛完为空 → 显示 `items.noneMatch` 而不是空白。`localStorage` 的读写都包 try/catch——隐私窗口里访问它本身就会抛。

分组标题：`item.agent` 的取值走 `tr("items.agent.<value>")`，别的维度原样显示；`value === ""` 的那组（没有该维度的单）标题用 `tr("items.groupNone")`。

**未归单分组永远在最后，不参与分组也不参与筛选**——它是待归类区，不是某个维度的取值。

- [ ] **Step 4: 样式**：工具条在列表上方、可横向滚动；选中的筛选 chip 有明显态。颜色只用主题变量。

- [ ] **Step 5: 跑测试并提交**

Run: `~/.bun/bin/bun test src/items-page.test.ts src/facet-view.test.ts src/i18n.test.ts src/themes.test.ts && ~/.bun/bin/bun run typecheck`

```bash
git add public/items.js public/style.css public/i18n.js src/items-page.test.ts
git commit -m "feat: 首页支持按任意维度分组与筛选，选择逐设备记住"
```

---

### Task 9: 收尾——全量、文档

**Files:**
- Modify: `CLAUDE.md`、`README.md`、`README.zh-CN.md`

- [ ] **Step 1: 跑 CI 等价物**

Run: `~/.bun/bin/bun run test`
Expected: 全绿。红了就读输出——`server.test.ts`/`reconnect.test.ts` 的孤儿会话断言按 pid 收窄过，红说明是真问题。

- [ ] **Step 2: 更新 `CLAUDE.md`**

这个文件是写成**论证**的，每条规矩都带着它为什么存在、以及没有它出过什么事。照这个语气写，别写成变更日志。要讲的：

- 插件接缝现在是 `enrich`（单 → 维度），不再是 `annotate`（会话 → 文本）。**安全阀原样继承**，加了每单 facet 上限。**`dim` 是 i18n 键**，所以内核里没有"哪个插件有哪些维度"的表——这条要写清楚，它是这套设计不违反插件界线的关键。
- 内核自己也产 facet 走同一条路，于是视图层不需要知道维度是谁产的。
- `/` 是单列表，会话列表在 `sessions.html`。
- 现有那段讲 `annotate` 的文字要**改写**，不是删掉——说明它演化成了什么、为什么。

- [ ] **Step 3: 更新两个 README**

`README.md` 是英文、`README.zh-CN.md` 镜像它，**两边必须同步**。讲清首页现在是单、会话列表在哪、维度从哪来。

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md README.md README.zh-CN.md
git commit -m "docs: 记下 facet 接缝与单驱动的首页"
```

## 第 2 期完成的判据

- [ ] `~/.bun/bin/bun run test` 全绿
- [ ] `/` 是单列表，每张卡片有 facet chips 和它的会话行
- [ ] 分组与筛选可用，选项从当前数据现算，选择逐设备记住
- [ ] 未归单分组收下所有没有绑定的会话
- [ ] `sessions.html` 仍是完整的会话列表
- [ ] 关掉 Jira 插件（`TMUX_NEXT_DISABLE_PLUGINS=jira`）后首页照常出，只是少几个维度
- [ ] 提交历史里没有任何助手署名 trailer

## 不属于第 2 期

- 新建流程改成先选单、「未归单」的「归到…」动作、Jira tab 改成候选单页 —— 第 3 期
- 单详情页、改标题、加标签、归档的 UI —— 第 3 期
- 第 1 期留下的 deferred：`ensureItemForSource` 的并发测试、`tags`/`cwd` 长度上限、`parseSessionRow` 的 null 分支、两条绑定路由严格度不一致、`migrate-items.ts` 的 `newId()` 与 `items.ts` 重复
