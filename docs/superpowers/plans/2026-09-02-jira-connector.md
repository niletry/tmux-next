# 数据源接缝：内核按来源分派，Jira 做第一个实现

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让首页能把外部系统的工单同步成单、能单独刷新其中一张，而内核全程只认识「来源」这个概念，不认识任何具体插件。

**Architecture:** 插件在清单里声明 `provides: ["jira"]`（它认领哪些 `source.provider`），在服务端实现 `sync()` 与 `refreshItem(ref)`。内核加两条泛型路由，查一次清单找到认领者调过去。`start()` 生命周期钩子在 CLI 入口调一次，Jira 用它做启动同步。

**Tech Stack:** Bun（无构建步骤）、TypeScript、`bun:test`、happy-dom、tmux 3.2+ 控制模式。零运行时依赖。

**Spec:** `docs/superpowers/specs/2026-09-02-jira-connector-design.md`

## Global Constraints

- **`bun` 不在 PATH 上，一律用 `~/.bun/bin/bun`。** `node_modules` 在 worktree 里是软链接、显示为未跟踪，**绝不 `git add -A`**，只按显式路径提交。
- **内核绝不点名任何插件。** `src/` 和 `public/` 里不许出现 `jira`、`gallery` 等插件 id；`src/items-page.test.ts` 和 `src/list-page.test.ts` 各有一条断言守着。内核需要知道又不该写死的东西，一律由清单声明（`titleKey`、`legacyPaths`、`facetDims` 都是先例）。
- **`enrich` 的规矩不变**：禁止发网络请求，只读缓存，300ms 硬超时。`sync`/`refreshItem` 是另一条路，有自己的 30 秒预算，不是它的放宽。
- **失败语义唯一**：拿不到就当没有，页面照常出，**绝不因为拉不到就删单**。
- **浏览器永不直连 Jira**，token 会漏、CORS 也不通；**JQL 只来自 `config.json`**，绝不接受浏览器传来的 JQL——那会把这个无认证服务变成任人查询的 Jira 代理。**不透传 Jira 的原始错误体**（里面带账号信息），只返回归类后的原因。
- **每一条磁盘状态路径可用环境变量覆盖，且在函数体里现读**，测试绝不碰用户的 `~/.tmux-next/`。
- **UI 字符串一律进 `public/i18n.js`**（或插件清单的 `i18n`），两种语言都要有且**必须真被引用**——`src/i18n.test.ts` 因缺失、没人用、或只有一种语言而红。动态查的键要么走字面量表（先例 `public/list.js:52`），要么在清单里声明（先例 `facetDims`）。
- **样式里不许有颜色字面量**，只能用主题变量，`src/themes.test.ts` 守着。注意它把 `#abc` 形状的选择器也当颜色——元素 id 别以三个十六进制字符开头（`#field-picker` 就是为此改的名）。
- **会渲染的浏览器模块必须有渲染测试**；测试里的页面路径用 `new URL(..., import.meta.url).pathname`，绝不写死绝对路径（`src/hygiene.test.ts` 会拦，写死会让测试悄悄读主仓库）；DOM shim 必须还原它替换的全局对象，且用 `patched` 标志守住，否则没挂载的测试会误删别处的全局。
- **绝不 `tmux kill-server`，绝不杀不是本轮建的会话。**
- **提交信息不带任何助手署名**：不写 `Co-Authored-By`、`Claude-Session`、`🤖 Generated with`。仓库公开。
- **不引入任何新依赖。**
- 命令：`~/.bun/bin/bun run typecheck`、`~/.bun/bin/bun test`、`~/.bun/bin/bun run test`。

## 环境已知问题（不是你的活）

这台机器的 tmux server 的工作目录被删了，所以**每一个"建会话再跑命令"的测试都会失败**——稳定在 **9 个左右失败 + 1 个 error**，跑两次数量会在 6–9 之间浮动（负载相关）。它们全是 `a session can be created in any real directory`、`the new session starts in the requested directory`、`upload-file saves into the session's working directory` 这一类。

**不要修它们，不要改代码绕开，不要重启或杀 tmux server**——它托着用户的真实工作。判据只有一条：**不新增失败**。

## 文件结构

| 文件 | 职责 |
|---|---|
| `plugins/types.ts` | 改：`Plugin` 加 `provides?: string[]` |
| `plugins/handlers.ts` | 改：`PluginServer` 加 `start?` / `sync?` / `refreshItem?`；新增 `SyncResult`、`runSync()`、`refreshFromSource()`、`startPlugins()` |
| `src/items.ts` | 改：`ensureItemForSource` 加 `{ refreshTitle }` |
| `src/index.ts` | 改：启动时调 `startPlugins()`，不 await |
| `src/server.ts` | 改：`POST /api/items/sync`、`POST /api/items/:id/refresh` |
| `plugins/jira/client.ts` | 改：`Issue` 加 `assignee`，`FIELDS` 多要一个字段 |
| `plugins/jira/sync.ts` | 新：纯函数 `syncIssues(issues, ensure)`，无网络可测 |
| `plugins/jira/server.ts` | 改：导出 `start` / `sync` / `refreshItem`，`facetsFor` 多产 assignee |
| `plugins/jira/plugin.js` | 改：`provides`、`facetDims` 多一条、两份字典各加一条 |
| `public/items.js` | 改：同步按钮、单张刷新按钮、归档动作、显示已归档开关 |

---

### Task 1: 内核认识「来源」——清单声明与分派

**Files:**
- Modify: `plugins/types.ts`、`plugins/handlers.ts`
- Test: `src/plugin-source.test.ts`（新）

**Interfaces:**
- Consumes: 无
- Produces:
  - `Plugin.provides?: string[]`
  - `type SyncResult = { created: number; updated: number; total: number; truncated: boolean }`
  - `PluginServer.sync?: () => Promise<SyncResult>`、`PluginServer.refreshItem?: (ref: string) => Promise<void>`
  - `SOURCE_TIMEOUT_MS = 30_000`
  - `runSync(servers?, plugins?): Promise<SyncResult>` —— 调所有声明了 `sync` 的插件并汇总
  - `refreshFromSource(provider, ref, servers?, plugins?): Promise<boolean>` —— 找到 `provides` 里声明了该 provider 的插件并调它；没人认领返回 `false`

两个函数都把表**作为参数**接收，默认值才是真表。理由跟 `collectFacets` 一模一样：注册表是编译期常量，没有这个参数就没法塞进"会抛的假插件"和"永远卡住的假插件"，而那两条测试是这个口子能存在的唯一证据。

- [ ] **Step 1: 写下会失败的测试**

创建 `src/plugin-source.test.ts`：

```ts
import { test, expect } from "bun:test";
import { runSync, refreshFromSource, SOURCE_TIMEOUT_MS } from "../plugins/handlers";
import type { Plugin } from "../plugins/types";
import type { PluginServer, SyncResult } from "../plugins/handlers";

/**
 * 内核只认识「来源」：它拿到一张单只知道 source.provider，据此查一次**插件自己
 * 声明的** provides，把活派过去。内核里没有任何 provider→插件 的名单。
 *
 * 表作为参数注入，理由同 collectFacets：注册表是编译期常量，不注入就没法证明
 * 超时和 try/catch 真的会兜住。
 */

const ok = (n: number): SyncResult => ({ created: n, updated: 0, total: n, truncated: false });

const fakePlugins = (ids: Record<string, string[]>): Plugin[] =>
  Object.entries(ids).map(([id, provides]) => ({
    id,
    titleKey: `${id}.title`,
    icon: "",
    i18n: { zh: {}, en: {} },
    provides,
  })) as Plugin[];

test("没有插件声明 sync 时，汇总是零", async () => {
  expect(await runSync({}, [])).toEqual({ created: 0, updated: 0, total: 0, truncated: false });
});

test("单个插件的结果原样汇总", async () => {
  const servers: Record<string, PluginServer> = { a: { sync: async () => ok(3) } };
  expect(await runSync(servers, fakePlugins({ a: ["a"] }))).toEqual({
    created: 3, updated: 0, total: 3, truncated: false,
  });
});

test("多个插件的数字相加", async () => {
  const servers: Record<string, PluginServer> = {
    a: { sync: async () => ({ created: 2, updated: 1, total: 3, truncated: false }) },
    b: { sync: async () => ({ created: 0, updated: 4, total: 4, truncated: true }) },
  };
  const got = await runSync(servers, fakePlugins({ a: ["a"], b: ["b"] }));
  expect(got).toEqual({ created: 2, updated: 5, total: 7, truncated: true });
});

// 一个来源挂了不该拖垮别的来源。
test("一个插件抛了，别的照常汇总", async () => {
  const servers: Record<string, PluginServer> = {
    bad: { sync: async () => { throw new Error("boom"); } },
    good: { sync: async () => ok(2) },
  };
  const got = await runSync(servers, fakePlugins({ bad: ["bad"], good: ["good"] }));
  expect(got.total).toBe(2);
});

test("插件卡住时超时返回，不吊死", async () => {
  const servers: Record<string, PluginServer> = { slow: { sync: () => new Promise(() => {}) } };
  const started = Date.now();
  const got = await runSync(servers, fakePlugins({ slow: ["slow"] }));
  expect(got.total).toBe(0);
  expect(Date.now() - started).toBeLessThan(SOURCE_TIMEOUT_MS);
});

test("按 provides 找到认领这个来源的插件", async () => {
  let sawRef = "";
  const servers: Record<string, PluginServer> = {
    a: { refreshItem: async (ref) => { sawRef = ref; } },
  };
  const found = await refreshFromSource("jira", "EXAMPLE-1", servers, fakePlugins({ a: ["jira"] }));
  expect(found).toBe(true);
  expect(sawRef).toBe("EXAMPLE-1");
});

// 没人认领要说得出来，页面据此不画一个必然失败的按钮。
test("没有插件认领这个来源时返回 false", async () => {
  const servers: Record<string, PluginServer> = { a: { refreshItem: async () => {} } };
  expect(await refreshFromSource("github", "12", servers, fakePlugins({ a: ["jira"] }))).toBe(false);
});

test("声明了 provides 但没实现 refreshItem，也算没人认领", async () => {
  const servers: Record<string, PluginServer> = { a: {} };
  expect(await refreshFromSource("jira", "x", servers, fakePlugins({ a: ["jira"] }))).toBe(false);
});

test("refreshItem 抛了当作失败，不外泄异常", async () => {
  const servers: Record<string, PluginServer> = {
    a: { refreshItem: async () => { throw new Error("boom"); } },
  };
  expect(await refreshFromSource("jira", "x", servers, fakePlugins({ a: ["jira"] }))).toBe(false);
});

test("refreshItem 卡住时超时返回 false", async () => {
  const servers: Record<string, PluginServer> = { a: { refreshItem: () => new Promise(() => {}) } };
  const started = Date.now();
  expect(await refreshFromSource("jira", "x", servers, fakePlugins({ a: ["jira"] }))).toBe(false);
  expect(Date.now() - started).toBeLessThan(SOURCE_TIMEOUT_MS);
});
```

**注意超时的两条断言**：它们只证明"在 30 秒之内返回"，不是精确计时——精确计时的测试在负载下会飘，而这里要证明的性质是"不会永远吊着"。若嫌 30 秒让测试太慢，把 `SOURCE_TIMEOUT_MS` 作为可注入参数或在测试里用更小的值，并在报告里说明你选了哪种。

- [ ] **Step 2: 跑一次确认它红**

Run: `~/.bun/bin/bun test src/plugin-source.test.ts`
Expected: FAIL —— `runSync` / `refreshFromSource` 不存在

- [ ] **Step 3: 实现**

`plugins/types.ts` 的 `Plugin` 加：

```ts
  /**
   * 这个插件认领哪些 `WorkItem.source.provider`，例如 `["jira"]`。
   *
   * 内核据此知道"谁负责这个来源"，从而能在首页发起「刷新这一个单」而**不点名任何
   * 插件**——它只做一次查表，而这张表是插件自己声明的数据，不是内核维护的名单。
   * 跟 titleKey、legacyPaths、facetDims 同一步棋：凡是内核需要知道、又不该写死的
   * 东西，都由清单声明。
   */
  provides?: string[];
```

`plugins/handlers.ts` 加类型与两个函数。超时/try-catch 的写法照抄 `collectFacets`，只是预算不同：

```ts
/** 一次同步的结果。多个来源的结果相加，truncated 只要有一个为真就是真。 */
export type SyncResult = { created: number; updated: number; total: number; truncated: boolean };

/**
 * 来源操作的硬超时。
 *
 * 不能沿用 enrich 的 300ms——那条预算是为"每次页面加载都跑"设的。sync 和
 * refreshItem 是显式动作，会真的发网络请求，30 秒是"慢得可以接受"和"卡住了"之间
 * 的线。
 */
export const SOURCE_TIMEOUT_MS = 30_000;

async function withTimeout<T>(work: Promise<T>, fallback: T): Promise<T> {
  const timeout = new Promise<T>((resolve) => setTimeout(() => resolve(fallback), SOURCE_TIMEOUT_MS));
  try {
    return await Promise.race([work, timeout]);
  } catch {
    return fallback;
  }
}
```

`runSync(servers = SERVERS, plugins = PLUGINS)`：按 `enabledPlugins()` 过滤（测试注进来的假插件不在注册表里，一律放行——跟 `collectFacets` 同一条判断），对每个有 `sync` 的插件并发调用、各自超时与 try/catch，把 `created`/`updated`/`total` 相加、`truncated` 取或。

`refreshFromSource(provider, ref, servers = SERVERS, plugins = PLUGINS)`：在 `plugins` 里找 `provides?.includes(provider)` 的那个，取它的 server；没有、或没有 `refreshItem`，返回 `false`；有就调，成功 `true`，抛了或超时 `false`。

- [ ] **Step 4: 跑测试**

Run: `~/.bun/bin/bun test src/plugin-source.test.ts src/plugin-enrich.test.ts plugins/registry.test.ts && ~/.bun/bin/bun run typecheck`
Expected: 全 PASS

- [ ] **Step 5: 提交**

```bash
git add plugins/types.ts plugins/handlers.ts src/plugin-source.test.ts
git commit -m "feat: 内核按来源分派，认领关系由插件清单声明"
```

---

### Task 2: `ensureItemForSource` 能更新标题

**Files:**
- Modify: `src/items.ts`
- Test: `src/items.test.ts`（追加）

**Interfaces:**
- Produces: `ensureItemForSource(provider, ref, title?, opts?: { refreshTitle?: boolean }): Promise<WorkItem>`

- [ ] **Step 1: 写下会失败的测试**

在 `src/items.test.ts` 追加（沿用该文件已有的 env 覆盖脚手架）：

```ts
test("refreshTitle 开着时更新标题", async () => {
  const first = await ensureItemForSource("jira", "EXAMPLE-1", "旧标题");
  const again = await ensureItemForSource("jira", "EXAMPLE-1", "新标题", { refreshTitle: true });
  expect(again.id).toBe(first.id);
  expect(again.title).toBe("新标题");
  expect((await readItems()).length).toBe(1);
});

test("不开 refreshTitle 时标题不动（默认行为不变）", async () => {
  await ensureItemForSource("jira", "EXAMPLE-1", "旧标题");
  const again = await ensureItemForSource("jira", "EXAMPLE-1", "新标题");
  expect(again.title).toBe("旧标题");
});

/**
 * cwd / tags / closedAt 是**本地状态**——你在这个工具里投入的东西。远端的一次
 * 改名不该动它们。这条是测试，不是注释里的承诺。
 */
test("更新标题绝不碰本地状态", async () => {
  const created = await ensureItemForSource("jira", "EXAMPLE-1", "旧标题");
  await updateItem(created.id, { cwd: "/tmp/orbit", tags: ["急"], closedAt: 1787000000 });
  const again = await ensureItemForSource("jira", "EXAMPLE-1", "新标题", { refreshTitle: true });
  expect(again.title).toBe("新标题");
  expect(again.cwd).toBe("/tmp/orbit");
  expect(again.tags).toEqual(["急"]);
  expect(again.closedAt).toBe(1787000000);
});

test("标题为空时不覆盖成空", async () => {
  await ensureItemForSource("jira", "EXAMPLE-1", "旧标题");
  const again = await ensureItemForSource("jira", "EXAMPLE-1", "", { refreshTitle: true });
  expect(again.title).toBe("旧标题");
});
```

- [ ] **Step 2: 跑一次确认它红**

Run: `~/.bun/bin/bun test src/items.test.ts`
Expected: FAIL —— 标题没有被更新

- [ ] **Step 3: 实现**

`ensureItemForSource` 的签名加第四个参数，找到已有单时：若 `opts?.refreshTitle` 且 `title` 非空且与现有不同，就在**同一个 `serialized` 任务里**改 title 并写盘；否则原样返回。

**必须在同一个队列任务里读-改-写**——在队列外面读、进队列写，中间那道缝跟没排队一样。这条是 `src/json-store.ts` 的既有规矩。

加一段注释说明 `refreshTitle` 只碰 title、为什么本地状态不能碰。

- [ ] **Step 4: 跑测试并提交**

Run: `~/.bun/bin/bun test src/items.test.ts && ~/.bun/bin/bun run typecheck`

```bash
git add src/items.ts src/items.test.ts
git commit -m "feat: ensureItemForSource 可刷新标题，本地状态一概不碰"
```

---

### Task 3: `start()` 钩子

**Files:**
- Modify: `plugins/handlers.ts`（`PluginServer.start`、`startPlugins()`）、`src/index.ts`
- Test: `src/plugin-source.test.ts`（追加）、`src/plugin-start-placement.test.ts`（新）

**Interfaces:**
- Produces: `PluginServer.start?: () => void`、`startPlugins(servers?, plugins?): void`

- [ ] **Step 1: 写下会失败的测试**

`src/plugin-source.test.ts` 追加：

```ts
test("start 被调一次", async () => {
  let calls = 0;
  startPlugins({ a: { start: () => { calls += 1; } } }, fakePlugins({ a: ["a"] }));
  expect(calls).toBe(1);
});

// 一个插件的 start 抛了，不能挡住服务器起来。
test("start 抛了不外泄，别的插件照常调到", async () => {
  let good = 0;
  expect(() =>
    startPlugins(
      { bad: { start: () => { throw new Error("boom"); } }, good: { start: () => { good += 1; } } },
      fakePlugins({ bad: ["bad"], good: ["good"] }),
    ),
  ).not.toThrow();
  expect(good).toBe(1);
});

test("没有插件声明 start 时什么都不做", () => {
  expect(() => startPlugins({}, [])).not.toThrow();
});
```

创建 `src/plugin-start-placement.test.ts`：

```ts
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * `startPlugins()` 必须由 CLI 入口调，不能由 startServer() 调。
 *
 * 至少五个测试文件直接调 startServer。钩子挂在那儿，跑一次 `bun test` 就会让插件
 * 拿用户真实的凭据发请求、往用户真实的 ~/.tmux-next/ 写单。一模一样的事在迁移上
 * 发生过一次，migrateJiraBindings() 因此被移到 src/index.ts。
 *
 * 这条钉住落点：不钉的话，一次"顺手收拢启动逻辑"的重构就能把它挪回去，而全套测试
 * 照样绿——只在用户自己机器上、只在他跑测试时出事。
 */
const read = (p: string) => readFileSync(new URL(p, import.meta.url).pathname, "utf8");

test("src/server.ts 不调 startPlugins", () => {
  expect(read("./server.ts")).not.toContain("startPlugins");
});

test("src/index.ts 调 startPlugins", () => {
  expect(read("./index.ts")).toContain("startPlugins");
});
```

- [ ] **Step 2: 跑一次确认它红**；**Step 3: 实现**

`startPlugins(servers = SERVERS, plugins = PLUGINS)`：按启用状态过滤，逐个 `try { s.start?.() } catch {}`。**同步函数，不返回 Promise**——插件想做异步的事，自己在里面 fire-and-forget。

`src/index.ts`：在 `migrateJiraBindings()` 之后、`startServer(...)` 之前调 `startPlugins()`。**不 await**（它本来就是同步的），并写一段注释说明为什么在这里而不在 `startServer`。

- [ ] **Step 4: 跑测试并提交**

Run: `~/.bun/bin/bun test src/plugin-source.test.ts src/plugin-start-placement.test.ts && ~/.bun/bin/bun run typecheck`

```bash
git add plugins/handlers.ts src/index.ts src/plugin-source.test.ts src/plugin-start-placement.test.ts
git commit -m "feat: 插件启动钩子，落点钉在 CLI 入口"
```

---

### Task 4: 两条内核路由

**Files:**
- Modify: `src/server.ts`
- Test: `src/items-api.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `runSync` / `refreshFromSource`
- Produces: `POST /api/items/sync` → `SyncResult`；`POST /api/items/:id/refresh` → `{ ok: true }` 或 404

- [ ] **Step 1: 写下会失败的测试**

在 `src/items-api.test.ts` 追加（沿用已有的 `at()` / `json()` / `makeItem()`）：

```ts
test("同步返回汇总形状", async () => {
  const res = await json("/api/items/sync", "POST", {});
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["created", "total", "truncated", "updated"]);
});

// sync 必须排在 /api/items/:id 之前，否则会被当成一个 item id。
test("sync 不会被当成 item id", async () => {
  const res = await json("/api/items/sync", "POST", {});
  expect(res.status).toBe(200);
});

test("刷新不存在的单给 404", async () => {
  const res = await json("/api/items/it-nope/refresh", "POST", {});
  expect(res.status).toBe(404);
});

// 没有来源就没有可刷的东西。
test("刷新一张没有来源的本地单给 404", async () => {
  const created = await makeItem("本地的活");
  const res = await json(`/api/items/${created.id}/refresh`, "POST", {});
  expect(res.status).toBe(404);
});

test("刷新一张来源无人认领的单给 404", async () => {
  const created = await (
    await json("/api/items", "POST", { title: "外星来源", source: { provider: "nobody", ref: "x" } })
  ).json() as { id: string };
  const res = await json(`/api/items/${created.id}/refresh`, "POST", {});
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: 跑一次确认它红**；**Step 3: 实现**

`src/server.ts`，**`/api/items/sync` 必须写在 `^/api/items/([^/]+)$` 那条之前**（第 1 期 `/api/items/bind` 是同一个坑）：

```ts
      if (url.pathname === "/api/items/sync" && req.method === "POST") {
        return Response.json(await runSync());
      }

      const itemRefresh = url.pathname.match(/^\/api\/items\/([^/]+)\/refresh$/);
      if (itemRefresh && req.method === "POST") {
        const id = decodeURIComponent(itemRefresh[1]!);
        const found = (await readItems()).find((i) => i.id === id);
        // 三种情况都是 404，且都是同一个意思：**没有可刷的东西**。分别是单不存在、
        // 单没有来源、来源没人认领。页面据此不画按钮，而不是画一个必然失败的按钮。
        if (!found?.source) return new Response("no source", { status: 404 });
        const ok = await refreshFromSource(found.source.provider, found.source.ref);
        if (!ok) return new Response("no source", { status: 404 });
        return Response.json({ ok: true });
      }
```

- [ ] **Step 4: 跑测试、全量并提交**

Run: `~/.bun/bin/bun test src/items-api.test.ts && ~/.bun/bin/bun run typecheck && ~/.bun/bin/bun test`

```bash
git add src/server.ts src/items-api.test.ts
git commit -m "feat: /api/items/sync 与单张刷新，按来源分派"
```

---

### Task 5: Jira 的同步循环（纯函数）

**Files:**
- Create: `plugins/jira/sync.ts`、`plugins/jira/sync.test.ts`

**Interfaces:**
- Consumes: `plugins/jira/client.ts` 的 `Issue`；Task 1 的 `SyncResult`；Task 2 的 `ensureItemForSource` 签名
- Produces: `MAX_SYNC_ITEMS = 200`；
  `syncIssues(issues: Issue[], ensure: (ref: string, title: string) => Promise<{ created: boolean }>): Promise<SyncResult>`

`ensure` 作为参数注入，所以这个文件**没有网络、没有磁盘**，可以无头地测。真实调用方在 Task 6 里把它接到 `ensureItemForSource` 上。

- [ ] **Step 1: 写下会失败的测试**

创建 `plugins/jira/sync.test.ts`：

```ts
import { test, expect } from "bun:test";
import { syncIssues, MAX_SYNC_ITEMS } from "./sync";
import type { Issue } from "./client";

const issue = (key: string, summary = `标题 ${key}`): Issue =>
  ({ id: key, key, summary, status: "In Progress", statusCategory: "indeterminate", updated: 0, type: "Task", parent: null }) as Issue;

/** 记下被要求建/更新的东西，并按调用方给的 created 回答。 */
function recorder(createdKeys: string[] = []) {
  const seen: Array<{ ref: string; title: string }> = [];
  return {
    seen,
    ensure: async (ref: string, title: string) => {
      seen.push({ ref, title });
      return { created: createdKeys.includes(ref) };
    },
  };
}

test("空表同步出零", async () => {
  const r = recorder();
  expect(await syncIssues([], r.ensure)).toEqual({ created: 0, updated: 0, total: 0, truncated: false });
});

test("每条工单都过一次 ensure，带上标题", async () => {
  const r = recorder();
  await syncIssues([issue("EXAMPLE-1"), issue("EXAMPLE-2")], r.ensure);
  expect(r.seen).toEqual([
    { ref: "EXAMPLE-1", title: "标题 EXAMPLE-1" },
    { ref: "EXAMPLE-2", title: "标题 EXAMPLE-2" },
  ]);
});

test("新建与更新分开计数", async () => {
  const r = recorder(["EXAMPLE-1"]);
  const got = await syncIssues([issue("EXAMPLE-1"), issue("EXAMPLE-2")], r.ensure);
  expect(got).toEqual({ created: 1, updated: 1, total: 2, truncated: false });
});

// 一条写错的 JQL 能返回几千条，而 items.json 是纯文本全量读写。
test("超过上限就截断", async () => {
  const many = Array.from({ length: MAX_SYNC_ITEMS + 5 }, (_, i) => issue(`E-${i}`));
  const r = recorder();
  const got = await syncIssues(many, r.ensure);
  expect(r.seen.length).toBe(MAX_SYNC_ITEMS);
  expect(got.total).toBe(MAX_SYNC_ITEMS);
  expect(got.truncated).toBe(true);
});

// 静默截断会让页面看起来像"就这么多"——「我们没问到」和「没有」是两回事。
test("没超过上限时 truncated 是 false", async () => {
  const r = recorder();
  expect((await syncIssues([issue("E-1")], r.ensure)).truncated).toBe(false);
});

test("某一条 ensure 抛了，其余照常同步", async () => {
  const seen: string[] = [];
  const ensure = async (ref: string) => {
    if (ref === "BAD") throw new Error("boom");
    seen.push(ref);
    return { created: true };
  };
  const got = await syncIssues([issue("E-1"), issue("BAD"), issue("E-2")], ensure);
  expect(seen).toEqual(["E-1", "E-2"]);
  expect(got.total).toBe(2);
});
```

- [ ] **Step 2: 跑一次确认它红**；**Step 3: 实现**

创建 `plugins/jira/sync.ts`。**串行**（`for` + `await`），不是 `Promise.all`——`ensureItemForSource` 内部靠一条进程内队列串行化，并发只会把它排满，且真实调用方要写同一份 `items.json`。单条失败 `try/catch` 跳过，不中断整轮。

- [ ] **Step 4: 跑测试并提交**

Run: `~/.bun/bin/bun test plugins/jira/sync.test.ts && ~/.bun/bin/bun run typecheck`

```bash
git add plugins/jira/sync.ts plugins/jira/sync.test.ts
git commit -m "feat: Jira 同步循环，纯函数、有上限、截断会报出来"
```

---

### Task 6: Jira 接上接缝

**Files:**
- Modify: `plugins/jira/server.ts`、`plugins/jira/plugin.js`、`plugins/handlers.ts`（注册）
- Test: `plugins/jira/connector.test.ts`（新）

**Interfaces:**
- Consumes: Task 1（`SyncResult`）、Task 2（`refreshTitle`）、Task 5（`syncIssues`）
- Produces: `plugins/jira/server.ts` 导出 `start`、`sync`、`refreshItem`；`plugin.js` 加 `provides: ["jira"]`

- [ ] **Step 1: 写下会失败的测试**

创建 `plugins/jira/connector.test.ts`，覆盖**能无头验证的那部分**：

```ts
import { test, expect } from "bun:test";
import jira from "./plugin.js";
import { devTargets } from "./server";

test("清单声明认领 jira 这个来源", () => {
  expect(jira.provides).toEqual(["jira"]);
});

/**
 * PR/检查只给**有活跃会话**的单拉。
 *
 * 全量拉是一个单一次 dev-status、每个 PR 再一次 Bitbucket——四十个单就是上百次
 * 请求。而你真正盯着 CI 的那个 PR，一定是你正开着会话在做的那个；请求数因此从
 * "你有多少工单"变成"你开着几个会话"。
 */
test("只挑有活跃绑定的单去拉 PR", () => {
  const items = [
    { id: "it-1", source: { provider: "jira", ref: "E-1" } },
    { id: "it-2", source: { provider: "jira", ref: "E-2" } },
    { id: "it-3", source: null },
  ];
  const bindings = [
    { session: "甲", itemId: "it-1", live: true },
    { session: "乙", itemId: "it-2", live: false },
  ];
  expect(devTargets(items as never, bindings as never)).toEqual(["E-1"]);
});

test("没有活跃会话时一个都不拉", () => {
  const items = [{ id: "it-1", source: { provider: "jira", ref: "E-1" } }];
  expect(devTargets(items as never, [] as never)).toEqual([]);
});
```

`devTargets(items, bindings)` 是为此抽出来的纯函数——它是这段逻辑里唯一有判断的地方，而带网络的那部分无法无头测。

- [ ] **Step 2: 跑一次确认它红**；**Step 3: 实现**

`plugins/jira/plugin.js` 加 `provides: ["jira"]`。

`plugins/jira/server.ts`：

- `devTargets(items, bindings)`：挑出 `source.provider === "jira"` 且有 `live: true` 绑定的单的 `ref`。
- `sync()`：`fetchIssues` → 写 `cache` → `syncIssues(issues, (ref, title) => ensureItemForSource("jira", ref, title, { refreshTitle: true }).then(...))` → 对 `devTargets(...)` 拉 dev 并写 `devCache`。**PR 那一步失败不影响同步结果**，单独 try/catch。未配置时返回零结果，不抛。
- `refreshItem(ref)`：调已有的 `refreshIssue(ref)`，再刷这一个单的 dev（**不受"只给有会话的单"限制**——你明确点了这一个）。
- `start()`：`void sync().catch(() => {})` —— 发出去就不管，手机不该等 Jira。

`plugins/handlers.ts` 注册：`jira: { handle: jira, enrich: jiraEnrich, start: jiraStart, sync: jiraSync, refreshItem: jiraRefreshItem }`。

`ensureItemForSource` 返回的是 `WorkItem`，而 `syncIssues` 的 `ensure` 要 `{ created: boolean }`。**怎么判断"是新建的"由调用方决定**：同步之前先读一次 `readItems()` 记下已有的 `(provider, ref)` 集合，之后据此判断。写清楚为什么不让 `ensureItemForSource` 返回这个标志——那会为一个调用方改内核签名。

- [ ] **Step 4: 跑测试、全量并提交**

Run: `~/.bun/bin/bun test plugins/ src/i18n.test.ts && ~/.bun/bin/bun run typecheck && ~/.bun/bin/bun test`

```bash
git add plugins/jira/server.ts plugins/jira/plugin.js plugins/handlers.ts plugins/jira/connector.test.ts
git commit -m "feat: Jira 实现同步与单张刷新，PR 只给有会话的单拉"
```

---

### Task 7: assignee 维度

**Files:**
- Modify: `plugins/jira/client.ts`、`plugins/jira/server.ts`、`plugins/jira/plugin.js`
- Test: `plugins/jira/enrich.test.ts`（追加）、`plugins/jira/client.test.ts`（追加）

- [ ] **Step 1: 写下会失败的测试**

`client.test.ts` 追加：断言 `FIELDS` 里含 `assignee`，且一行搜索结果里的 `fields.assignee.displayName` 被解析进 `Issue.assignee`；`assignee` 为 null（未分配）时解析成 `null` 而不是抛。

`enrich.test.ts` 追加：

```ts
test("有 assignee 就给一个维度", () => {
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue({ assignee: "李雷" } as Partial<Issue>)]]), new Map());
  expect(dims(got)["jira.assignee"]).toBe("李雷");
});

test("没有 assignee 就不给这个维度", () => {
  const got = facetsFor(jiraItem, new Map([["EXAMPLE-1", issue({ assignee: null } as Partial<Issue>)]]), new Map());
  expect(dims(got)["jira.assignee"]).toBeUndefined();
});
```

- [ ] **Step 2: 跑一次确认它红**；**Step 3: 实现**

`client.ts`：`FIELDS` 改成 `"summary,status,updated,issuetype,parent,assignee"`；`Issue` 加 `assignee: string | null`；**在那个共用的解析函数里**加解析（该文件注释已经写明为什么两条路必须共用一份解析：各写一份迟早在某个字段上飘，而飘的那一刻没有任何测试会红）。

`server.ts` 的 `facetsFor` 在有 `assignee` 时 push `{ dim: "jira.assignee", value: issue.assignee }`。

`plugin.js`：`facetDims` 加 `"jira.assignee"`，`i18n.zh` 加 `"jira.assignee": "负责人"`，`i18n.en` 加 `"jira.assignee": "Assignee"`。

- [ ] **Step 4: 跑测试并提交**

Run: `~/.bun/bin/bun test plugins/ src/i18n.test.ts && ~/.bun/bin/bun run typecheck`

```bash
git add plugins/jira/client.ts plugins/jira/server.ts plugins/jira/plugin.js plugins/jira/enrich.test.ts plugins/jira/client.test.ts
git commit -m "feat: 负责人成为一个维度"
```

---

### Task 8: 首页的三个动作——同步、刷新单张、归档

**Files:**
- Modify: `public/items.js`、`public/i18n.js`、`public/style.css`
- Test: `src/items-page.test.ts`（追加）

**Interfaces:**
- Consumes: Task 4 的两条路由；`PATCH /api/items/:id`（第 1 期已有）

- [ ] **Step 1: 加 i18n 键**（zh/en 两边，且每条都会被引用）

```
items.sync / items.syncing / items.syncDone / items.syncFailed / items.syncTruncated
items.refresh / items.archive / items.unarchive / items.showArchived
```

zh：`"同步"` / `"同步中…"` / `"新增 {created}，更新 {updated}"` / `"同步失败"` / `"只同步了前 {n} 条"` / `"刷新这一个单"` / `"归档"` / `"取消归档"` / `"显示已归档"`。en 对应。

**若某个键最后没有调用点，不要发明一个消费者——停下来报告。**

- [ ] **Step 2: 写下会失败的测试**

`src/items-page.test.ts` 的 `mount()` 目前只应答 GET。**先扩它的 fetch shim 记录写请求**，并让它按 URL 分别应答——已有测试的调用形状不要变（`body`/`store` 仍是前两个参数）：

```ts
/** 页面发出去的写请求，供断言用。每次 mount 清空。 */
let posted: Array<{ url: string; method: string; body: string }> = [];

// mount() 的 fetch shim 里，在现有分支之前加：
    fetch: (async (u: unknown, init?: RequestInit) => {
      const href = String(u);
      if (init?.method && init.method !== "GET") {
        posted.push({ url: href, method: init.method, body: String(init.body ?? "") });
        if (href.includes("/refresh")) return new Response(JSON.stringify({ ok: true }));
        if (href.includes("api/items/sync")) return new Response(JSON.stringify(syncReply));
        return new Response(JSON.stringify({}));
      }
      if (href.includes("api/items")) return new Response(JSON.stringify(body));
      if (href.includes("api/plugins")) return new Response(JSON.stringify([]));
      if (href.includes("api/language")) return new Response(JSON.stringify({ lang: "en" }));
      return new Response("{}");
    }) as typeof fetch,
```

`syncReply` 是模块级的一个可改变量，默认 `{ created: 0, updated: 0, total: 0, truncated: false }`，个别测试改它。`posted` 在 `mount()` 开头清空。

`/refresh` 那条分支必须排在 `api/items/sync` 之前判断——两者都含 `api/items`，顺序反了就会互相截胡。

然后追加：

```ts
const withSource = () => item({ source: { provider: "jira", ref: "EXAMPLE-1" } });
const clickable = (root: Element, sel: string) =>
  root.querySelector(sel)?.dispatchEvent(new (globalThis as any).window.Event("click", { bubbles: true }));

test("顶栏有同步按钮", async () => {
  await mount(payload({ items: [item()] }));
  expect(document.getElementById("sync-items")).not.toBeNull();
});

test("点同步会 POST /api/items/sync", async () => {
  await mount(payload({ items: [item()] }));
  document.getElementById("sync-items")?.dispatchEvent(
    new (globalThis as any).window.Event("click", { bubbles: true }),
  );
  await new Promise((r) => setTimeout(r, 60));
  expect(posted.some((p) => p.url.includes("api/items/sync") && p.method === "POST")).toBe(true);
});

// 静默截断会让页面看起来像"就这么多"——「我们没问到」和「没有」是两回事。
test("同步返回 truncated 时说出来", async () => {
  syncReply = { created: 0, updated: 200, total: 200, truncated: true };
  const root = await mount(payload({ items: [item()] }));
  document.getElementById("sync-items")?.dispatchEvent(
    new (globalThis as any).window.Event("click", { bubbles: true }),
  );
  await new Promise((r) => setTimeout(r, 60));
  expect(root.parentElement?.textContent ?? "").toContain(tr("items.syncTruncated", { n: 200 }));
  syncReply = { created: 0, updated: 0, total: 0, truncated: false };
});

test("有来源的单画刷新按钮", async () => {
  const root = await mount(payload({ items: [withSource()] }));
  expect(root.querySelector(".item-refresh")).not.toBeNull();
});

// 没有来源就没有可刷的东西——画一个必然失败的按钮比不画更糟。
test("没有来源的本地单不画刷新按钮", async () => {
  const root = await mount(payload({ items: [item()] }));
  expect(root.querySelector(".item-refresh")).toBeNull();
});

test("点刷新会 POST 到那张单的 refresh 路由", async () => {
  const root = await mount(payload({ items: [withSource()] }));
  clickable(root, ".item-refresh");
  await new Promise((r) => setTimeout(r, 60));
  expect(posted.some((p) => p.url.includes("api/items/it-1/refresh") && p.method === "POST")).toBe(true);
});

test("点归档会 PATCH 一个 closedAt", async () => {
  const root = await mount(payload({ items: [item()] }));
  clickable(root, ".item-archive");
  await new Promise((r) => setTimeout(r, 60));
  const patch = posted.find((p) => p.method === "PATCH");
  expect(patch?.url).toContain("api/items/it-1");
  expect(typeof JSON.parse(patch?.body ?? "{}").closedAt).toBe("number");
});

test("已归档的单默认不画", async () => {
  const root = await mount(payload({ items: [item({ closedAt: 1787000000 })] }));
  expect(root.querySelectorAll(".item-card").length).toBe(0);
});

test("打开显示已归档后画出来", async () => {
  const store = { "tmux-next.items.showArchived": "1" };
  const root = await mount(payload({ items: [item({ closedAt: 1787000000 })] }), store);
  expect(root.querySelectorAll(".item-card").length).toBe(1);
});

// 归档不是删除：取消归档要能把它拿回来。
test("已归档的单上是取消归档，PATCH 的 closedAt 为 null", async () => {
  const store = { "tmux-next.items.showArchived": "1" };
  const root = await mount(payload({ items: [item({ closedAt: 1787000000 })] }), store);
  clickable(root, ".item-archive");
  await new Promise((r) => setTimeout(r, 60));
  const patch = posted.find((p) => p.method === "PATCH");
  expect(JSON.parse(patch?.body ?? "{}").closedAt).toBeNull();
});
```

- [ ] **Step 3: 跑一次确认它红**；**Step 4: 实现**

- 顶栏一个同步按钮：进行中禁用并显示 `items.syncing`；成功显示新增/更新数；`truncated` 为真时**额外显示** `items.syncTruncated`；失败显示 `items.syncFailed`。完成后重新 `render()`。
- 卡片上：`item.source` 非空时画刷新按钮，POST `api/items/<id>/refresh`，完成后 `render()`；404 时提示一次并**不再重画**（那张单没有可刷的东西）。
- 卡片上：归档按钮，`PATCH api/items/<id>` 带 `{ closedAt: <秒级时间戳> }`；已归档的显示"取消归档"，带 `{ closedAt: null }`。
- 工具栏：`items.showArchived` 开关，存 `tmux-next.items.showArchived`，读写都包 try/catch。关着时 `open` 仍然过滤掉 `closedAt`；开着时不过滤。
- 样式只用主题变量；元素 id 别以三个十六进制字符开头。

- [ ] **Step 5: 跑测试、全量并提交**

Run: `~/.bun/bin/bun test src/items-page.test.ts src/i18n.test.ts src/themes.test.ts src/public-parses.test.ts src/hygiene.test.ts && ~/.bun/bin/bun run typecheck && ~/.bun/bin/bun test`

```bash
git add public/items.js public/i18n.js public/style.css src/items-page.test.ts
git commit -m "feat: 首页可同步、可刷新单张、可归档"
```

---

### Task 9: 收尾——手工验证与文档

**Files:**
- Modify: `CLAUDE.md`、`README.md`、`README.zh-CN.md`

- [ ] **Step 1: 跑 CI 等价物**

Run: `~/.bun/bin/bun run test`。失败集合应与开工前一致（那 9 个左右的环境问题），**不新增**。

- [ ] **Step 2: 手工验证**

**不要用默认端口 7682**（那儿跑着服务用户手机的真实实例），**不要拿真实 `~/.tmux-next/` 跑真 CLI**。用 scratch 目录 + 端口 17682：

```bash
TMUX_NEXT_ITEMS_PATH=<scratch>/items.json \
TMUX_NEXT_BINDINGS_PATH=<scratch>/bindings.json \
TMUX_NEXT_JIRA_DIR=<scratch>/jira \
~/.bun/bin/bun run src/index.ts --port 17682
```

scratch 的 jira 目录里**不要放真凭据**——没有配置时 `sync` 应当返回零结果而不抛，这本身就是要验的一条。验证：首页出得来、同步按钮点了有反馈、没有来源的单不画刷新按钮。跑完停掉。前后各确认一次 `~/.tmux-next/items.json` 的修改时间没变。

- [ ] **Step 3: 文档**

`CLAUDE.md` 写成**论证**，不是变更日志。要讲的：内核只认识来源、认领关系由清单声明（与 `titleKey`/`facetDims` 同源）；`sync`/`refreshItem` 为什么不能沿用 `enrich` 的 300ms；`start()` 为什么必须在 CLI 入口；以及**当初否掉 provider 契约、后来又做的那段判断变化**——它不是反复，是前提变了（首页要发起来源操作，而首页不能点名插件）。

两个 README 保持同步：说明首页可以同步、单张可刷新、已归档可切换显示。

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md README.md README.zh-CN.md
git commit -m "docs: 记下数据源接缝与它的两次判断变化"
```

## 完成判据

- [ ] `~/.bun/bin/bun run test` 的失败集合与开工前一致，不新增
- [ ] `src/` 与 `public/` 里搜不到任何插件 id
- [ ] 关掉 Jira 插件（`TMUX_NEXT_DISABLE_PLUGINS=jira`）后首页照常出，同步返回零结果，刷新按钮不画
- [ ] 提交历史里没有任何助手署名 trailer

## 不属于本期

- 后台定时轮询
- 写回 Jira、配置 UI
- 第二个数据源
