# 会话模板 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从一张单开会话时，选一个模板把会话名和首条输入一起填好，可改，然后一次建出来。

**Architecture:** 模板存在内核的一份全局清单里；占位符读一张平表 —— 内核字段占 `item.*`
命名空间，插件通过新的 `fields(item)` 往里贴自己的键。渲染是服务端的纯函数（页面只负责编辑），
会话建完之后等 agent 的 `readyMarker` 命中再把首条输入敲进去，超时就放弃不发。

**Tech Stack:** Bun（无构建步骤）、TypeScript（`src/`）、原生 ES 模块（`public/`）、
happy-dom（页面测试）、真实 tmux（integration）。

**Spec:** `docs/superpowers/specs/2026-09-03-session-templates-design.md`

## Global Constraints

- **Bun only.** 跑测试是 `bun test`，类型检查是 `bun run typecheck`。没有打包步骤。
- **提交信息不带任何助手署名。** 不写 `Co-Authored-By: Claude …`、不写 `Claude-Session:`、
  不写 `🤖 Generated with …`。仓库是公开的，这些 trailer 会变成每个提交上的额外贡献者。
  正文里提 Claude Code 没问题 —— 规则针对的是署名 trailer，不是产品名。
- **提交必须列具体文件**（`git add <路径>`），**绝不用 `git add -A`/`git add .`**：同一个
  仓库上常有多个会话并行，通配会扫走别人的在途改动。
- **每一处新的磁盘状态都要有 env 覆盖**，本计划里是 `TMUX_NEXT_TEMPLATES_PATH`。路径在
  **函数体里现读**，不在模块加载时捕获 —— 测试要能先设 env 再调用。
- **每一次 tmux 调用都走 `tmux(argv)`（`src/tmux/run.ts`），绝不用 `Bun.$`。**
- **目标 tmux 会话一律写 `=<name>`**（`send-keys` 的 `-t` 要 `=<name>:`，末尾那个冒号不能少）。
  裸名字会按前缀匹配，`web` 能命中 `webmux`。
- **绝不 `tmux kill-server`，绝不 kill 不是本次测试自己建的会话。** 清理只按精确名字
  `kill-session -t '=<name>'`，且名字必须是本次运行自己生成并记下的。
- **测试里用 `-c <dir>` 建的会话，跑完不许删那个目录。** tmux 服务器会把它记成自己的工作
  目录，删掉之后这台机器上**之后建的每一个 pane** 都起不来。用仓库里已经存在的目录。
- **UI 文案一律走 `public/i18n.js`，两份字典都要有。** `src/i18n.test.ts` 会因为"某个键只在
  一份字典里"而变红，这正是它存在的理由。
- **`public/` 里会渲染的模块必须有渲染它的测试**（happy-dom）。DOM shim 必须还原它替换掉的
  全局对象 —— Bun 一个进程跑所有测试文件，覆盖 `fetch` 不还原会连累别的文件。
- 现有的红：这套测试有一条稳定的 9 失败 / 1 错误的尾巴，来自历史上某次测试删掉了 tmux
  服务器的工作目录（见 CLAUDE.md）。**它跟本计划无关，不要去追**。判断"我有没有弄红"的
  办法是跟改动前的失败数比，不是跟 0 比。

---

## 文件结构

新建：

| 文件 | 职责 |
|---|---|
| `src/template.ts` | 纯函数：占位符渲染 `render()`、会话名净化 `sanitiseName()` |
| `src/item-fields.ts` | 纯函数：一张单的内核字段 `kernelFields()` + `KERNEL_FIELD_KEYS` |
| `src/templates.ts` | `templates.json` 的读写与净化 |
| `src/tmux/prime.ts` | `waitForReady()`（纯、可注入）+ `primeSession()`（外壳） |
| `plugins/jira/adf.ts` | Jira 的 ADF 富文本 → 纯文本 |
| `src/template.test.ts` / `src/item-fields.test.ts` / `src/templates-api.test.ts` / `src/plugin-fields.test.ts` / `src/prime.test.ts` / `src/prime.integration.test.ts` / `plugins/jira/adf.test.ts` | 各自对应 |

修改：

| 文件 | 改什么 |
|---|---|
| `plugins/types.ts` | 加 `PluginFieldSource` 类型、`Plugin.fieldKeys?` |
| `plugins/handlers.ts` | `PluginServer.fields?`、`FIELD_SOURCES`、`collectFields()`、三个常数 |
| `src/agents/index.ts` | `Agent.screen.readyMarker`，三个 agent 各填一条 |
| `src/server.ts` | 三条新路由 + `createSessionResponse` 收 `initialInput` |
| `public/new.js` | 模板 chips、首条输入 textarea、创建时带上 `initialInput` |
| `public/settings.js` | 模板管理一节 |
| `public/i18n.js` | 新键，中英各一份 |
| `plugins/jira/client.ts` | `fetchIssueDescription()` |
| `plugins/jira/server.ts` | `export async function fields()` |
| `plugins/jira/plugin.js` | `fieldKeys: [...]` |
| `src/new-page.test.ts` / `src/settings-page.test.ts` / `src/agents/agents.test.ts` | 扩测试 |
| `CLAUDE.md` / `README.md` / `README.zh-CN.md` | 文档 |

依赖顺序：1 → 2 → 3 → 4 是四个互不依赖的叶子；5 用到 1–4；6 → 7 → 8 是 prime 这一路；
9 用到 5、7；10 用到 4、5；11 用到 3；12 收尾。

---

### Task 1: `src/template.ts` —— 渲染与会话名净化

**Files:**
- Create: `src/template.ts`
- Test: `src/template.test.ts`

**Interfaces:**
- Consumes: `WEB_SESSION_PREFIX`（`src/tmux/session-manager.ts` 已有的导出常量，值是 `"web-"`）
- Produces:
  - `render(template: string, fields: Record<string, string>): string`
  - `sanitiseName(raw: string): string | null`
  - `MAX_RENDERED: number`（2000）

- [ ] **Step 1: 写失败的测试**

创建 `src/template.test.ts`：

```ts
import { test, expect } from "bun:test";
import { render, sanitiseName, MAX_RENDERED } from "./template";

test("占位符换成字段值", () => {
  expect(render("修 {item.ref}", { "item.ref": "EXAMPLE-1" })).toBe("修 EXAMPLE-1");
});

test("不认识的键渲染成空，不留大括号", () => {
  expect(render("a{nope}b", {})).toBe("ab");
});

// 这条是"删行"规则要解决的那个问题本身：没挂史诗时不该留下"史诗："这半句话。
test("一行的占位符全空，整行删掉", () => {
  expect(render("标题\n史诗：{jira.epic}\n结尾", { "jira.epic": "" })).toBe("标题\n结尾");
});

// 反面：规则是按行全有全无，部分为空时这一行仍然保留。
test("同一行里只有一部分为空，这行保留", () => {
  expect(render("{item.ref}：{jira.summary}", { "item.ref": "E-1", "jira.summary": "" })).toBe(
    "E-1：",
  );
});

test("没有占位符的行永远保留，哪怕只有标点", () => {
  expect(render("---\n{x}", {})).toBe("---");
});

test("渲染结果截到 MAX_RENDERED", () => {
  const long = "x".repeat(MAX_RENDERED + 500);
  expect(render("{a}", { a: long }).length).toBe(MAX_RENDERED);
});

test("空白折叠成连字符", () => {
  expect(sanitiseName("  修 登录  页 ")).toBe("修-登录-页");
});

// tmux 把 . 和 : 当 session:window.pane 的分隔符，带上就是一个连 kill 都 kill 不掉的会话。
test("点号和冒号被剔除", () => {
  expect(sanitiseName("a.b:c")).toBe("abc");
});

test("截到 64 字且不以连字符结尾", () => {
  const got = sanitiseName("a".repeat(70))!;
  expect(got.length).toBe(64);
  expect(got.endsWith("-")).toBe(false);
});

test("净化后为空退回 null，等于没提供名字", () => {
  expect(sanitiseName("  ...  ")).toBeNull();
});

test("撞上挂载会话保留前缀的退回 null", () => {
  expect(sanitiseName("web-123")).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `bun test src/template.test.ts`
Expected: FAIL —— `Cannot find module './template'`

- [ ] **Step 3: 写实现**

创建 `src/template.ts`：

```ts
import { WEB_SESSION_PREFIX } from "./tmux/session-manager";

/**
 * 模板渲染。纯函数，不碰磁盘、不认识任何一个具体字段。
 *
 * 字段表是**平的**：内核的键占 `item.*`，插件的键由插件自己命名（collectFields 挡住
 * 了它们冒充 `item.*`）。这里不区分谁产的——跟 Facet.dim 同源的设计。
 */

/** 渲染结果的上限，跟 send-text.ts 的 MAX_TEXT 对齐。 */
export const MAX_RENDERED = 2000;

/** 会话名的上限。tmux 本身不限，但更长的名字在手机上一行放不下。 */
const MAX_NAME_LEN = 64;

const PLACEHOLDER = /\{([A-Za-z0-9._-]+)\}/g;

/**
 * 一行里的占位符**全部**渲染成空时，整行删掉；没有占位符的行永远保留。
 *
 * 规则是按行全有全无，不是"把剩下的标点清掉"：要判断"剩下的算不算半句话"就得让内核去
 * 理解标点和语言。想让某一行在缺字段时消失，就把它单独写成一行——这条规则一句话说得清，
 * 也测得住。
 */
export function render(template: string, fields: Record<string, string>): string {
  const lines: string[] = [];
  for (const line of template.split("\n")) {
    let seen = 0;
    let filled = 0;
    const out = line.replace(PLACEHOLDER, (_match, key: string) => {
      seen++;
      const value = fields[key] ?? "";
      if (value) filled++;
      return value;
    });
    if (seen > 0 && filled === 0) continue;
    lines.push(out);
  }
  // 截断发生在这里而不是发送时：创建页框里那段文字必须就是最终会敲进去的那段，
  // 否则预览会撒谎。
  return lines.join("\n").slice(0, MAX_RENDERED);
}

/**
 * 渲染结果 → 一个能当会话名用的字符串，用不了就是 null（等于"没提供名字"，
 * 服务端按目录生成，跟今天的默认路径一致）。
 *
 * **必须在服务端做。** `.` 和 `:` 是 tmux 的 `session:window.pane` 分隔符：带上它们
 * 建出来的会话之后每一次 `-t` 查找都会失败，连 kill 都 kill 不掉（见
 * src/tmux/session-create.ts 的 UNTARGETABLE）。`web-` 是本应用挂载会话的保留前缀。
 * 两件事都是服务端的事实，浏览器不该复述。
 */
export function sanitiseName(raw: string): string | null {
  const name = raw
    .trim()
    .replace(/[.:]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_NAME_LEN)
    .replace(/-+$/, "");
  if (!name) return null;
  if (name.startsWith(WEB_SESSION_PREFIX)) return null;
  return name;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/template.test.ts`
Expected: PASS，11 条全绿

Run: `bun run typecheck`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add src/template.ts src/template.test.ts
git commit -m "模板渲染：占位符替换与会话名净化

占位符全空的行整行删掉，否则「史诗：{jira.epic}」在没挂史诗的单上会留下半句话。
会话名的净化必须在服务端：. 和 : 是 tmux 的 session:window.pane 分隔符，带上就是
一个连 kill 都 kill 不掉的会话。"
```

---

### Task 2: `src/item-fields.ts` —— 内核字段

**Files:**
- Create: `src/item-fields.ts`
- Test: `src/item-fields.test.ts`

**Interfaces:**
- Consumes: `WorkItem`（`src/items.ts` 已有的导出类型：
  `{ id, title, source: { provider, ref, url? } | null, tags: string[], createdAt, closedAt }`）
- Produces:
  - `kernelFields(item: WorkItem): Record<string, string>`
  - `KERNEL_FIELD_KEYS: readonly string[]`

- [ ] **Step 1: 写失败的测试**

创建 `src/item-fields.test.ts`：

```ts
import { test, expect } from "bun:test";
import { kernelFields, KERNEL_FIELD_KEYS } from "./item-fields";
import type { WorkItem } from "./items";

const item = (extra: Partial<WorkItem> = {}): WorkItem => ({
  id: "it-1",
  title: "修登录页",
  source: { provider: "jira", ref: "EXAMPLE-1", url: "https://x.example/EXAMPLE-1" },
  tags: ["前端", "紧急"],
  createdAt: 0,
  closedAt: null,
  ...extra,
});

test("挂了来源的单，六个字段都有值", () => {
  expect(kernelFields(item())).toEqual({
    "item.id": "it-1",
    "item.title": "修登录页",
    "item.provider": "jira",
    "item.ref": "EXAMPLE-1",
    "item.url": "https://x.example/EXAMPLE-1",
    "item.tags": "前端, 紧急",
  });
});

// 本地单跟挂了工单的单是同一种东西，只是来源那三格是空字符串——不是 undefined，
// 否则 render 里的 `fields[key] ?? ""` 和"这一行全空"的判断会走两条路。
test("本地单的来源三格是空字符串", () => {
  const got = kernelFields(item({ source: null, tags: [] }));
  expect(got["item.provider"]).toBe("");
  expect(got["item.ref"]).toBe("");
  expect(got["item.url"]).toBe("");
  expect(got["item.tags"]).toBe("");
});

test("来源没带 url 时那一格是空字符串", () => {
  const got = kernelFields(item({ source: { provider: "jira", ref: "E-1" } }));
  expect(got["item.url"]).toBe("");
});

// 设置页要把可用字段列给用户看，键名从服务端来（GET /api/templates），
// 所以这张表必须跟 kernelFields 真正产出的键完全一致。
test("KERNEL_FIELD_KEYS 跟实际产出的键一一对应", () => {
  expect([...KERNEL_FIELD_KEYS].sort()).toEqual(Object.keys(kernelFields(item())).sort());
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `bun test src/item-fields.test.ts`
Expected: FAIL —— `Cannot find module './item-fields'`

- [ ] **Step 3: 写实现**

创建 `src/item-fields.ts`：

```ts
import type { WorkItem } from "./items";

/**
 * 一张单的内核字段，喂给模板渲染。
 *
 * 纯函数：不碰磁盘、不碰 tmux、不发请求。要什么由调用方查好了传进来，于是能无头测。
 *
 * 全部占用 `item.` 这个命名空间，而 collectFields 挡住插件的键用这个前缀——两条规则
 * 合起来是一句干净的话：**内核的字段在这里，插件不许进来**。这跟 collectFacets 里那条
 * `dim.startsWith("item.")` 是同一个命名空间、同一个理由，区别只在这次内核真的往里放
 * 东西。模板语法因此不需要知道哪个键是谁产的。
 *
 * 单上**没有 cwd**，这里也不会凭空造一个：目录是"手段"的属性，不是"单"的属性
 * （见 CLAUDE.md）。要知道这单在哪个仓库，看它绑着的会话的 path。
 */

/** 取不到的一律是空字符串，不是 undefined——render 的"这一行是否全空"要靠这个判断。 */
export function kernelFields(item: WorkItem): Record<string, string> {
  return {
    "item.id": item.id,
    "item.title": item.title,
    "item.provider": item.source?.provider ?? "",
    "item.ref": item.source?.ref ?? "",
    "item.url": item.source?.url ?? "",
    "item.tags": item.tags.join(", "),
  };
}

/**
 * 设置页列给用户看的内核字段名。
 *
 * 走服务端（GET /api/templates 把它带上）而不是在 settings.js 里再抄一份：抄一份就有
 * 两处会飘，而飘了之后页面上列出的键名依然长得很像真的，没有任何东西会红。
 */
export const KERNEL_FIELD_KEYS: readonly string[] = [
  "item.title",
  "item.ref",
  "item.url",
  "item.provider",
  "item.tags",
  "item.id",
];
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/item-fields.test.ts`
Expected: PASS，4 条全绿

- [ ] **Step 5: 提交**

```bash
git add src/item-fields.ts src/item-fields.test.ts
git commit -m "内核字段：一张单喂给模板的那六格

全部占 item.* 命名空间，跟 collectFields 挡住插件用这个前缀是同一条规则的两半。
键名清单走服务端下发，不在设置页里再抄一份。"
```

---

### Task 3: `fields(item)` 插件契约与 `collectFields`

**Files:**
- Modify: `plugins/types.ts`（文件末尾追加 `PluginFieldSource`；`Plugin` 类型里加 `fieldKeys?`）
- Modify: `plugins/handlers.ts`（`PluginServer` 加 `fields?`；新增 `FIELD_SOURCES`、
  `collectFields`、三个常数）
- Test: `src/plugin-fields.test.ts`

**Interfaces:**
- Consumes: `ItemRef`、`enabledPlugins()`、`isConsidered()`（`plugins/handlers.ts` 里已有的
  私有函数，签名 `(id: string, enabled: Set<string>) => boolean`）
- Produces:
  - `PluginFieldSource = (item: ItemRef) => Promise<Record<string, string>>`
  - `collectFields(item: ItemRef, sources?: Record<string, PluginFieldSource>): Promise<Record<string, string>>`
  - `FIELD_TIMEOUT_MS = 5_000`、`MAX_FIELD_LEN = 4000`、`MAX_FIELDS_PER_ITEM = 12`
  - `Plugin.fieldKeys?: string[]`

- [ ] **Step 1: 写失败的测试**

创建 `src/plugin-fields.test.ts`：

```ts
import { test, expect } from "bun:test";
import {
  collectFields,
  FIELD_TIMEOUT_MS,
  MAX_FIELD_LEN,
  MAX_FIELDS_PER_ITEM,
} from "../plugins/handlers";
import type { ItemRef, PluginFieldSource } from "../plugins/types";

/**
 * 跟 src/plugin-enrich.test.ts 同一条道理：这个口子的失败语义只有一种——**拿不到就当
 * 没有**，占位符渲染成空。sources 是参数而不是直接用 FIELD_SOURCES，正是为了能在这里
 * 塞进会抛、会卡住的假插件；注册表是编译期常量，没有这个参数就没法证明安全阀会触发。
 */

const item: ItemRef = { id: "it-1", source: { provider: "jira", ref: "EXAMPLE-1" } };

const ok: PluginFieldSource = async () => ({ "jira.summary": "修登录页" });
const throws: PluginFieldSource = async () => {
  throw new Error("boom");
};
const hangs: PluginFieldSource = () => new Promise(() => {});

test("没有插件时给空表", async () => {
  expect(await collectFields(item, {})).toEqual({});
});

test("正常插件的字段收得到", async () => {
  expect(await collectFields(item, { p: ok })).toEqual({ "jira.summary": "修登录页" });
});

test("插件抛了，只是这一轮没有字段", async () => {
  expect(await collectFields(item, { bad: throws })).toEqual({});
});

test("一个插件抛了不影响另一个", async () => {
  expect(await collectFields(item, { bad: throws, good: ok })).toEqual({
    "jira.summary": "修登录页",
  });
});

test("插件卡住时超时返回，不吊死调用方", async () => {
  const started = Date.now();
  expect(await collectFields(item, { slow: hangs })).toEqual({});
  expect(Date.now() - started).toBeLessThan(FIELD_TIMEOUT_MS * 2);
});

test("返回不是对象时当作没有", async () => {
  const weird = (async () => ["nope"]) as unknown as PluginFieldSource;
  expect(await collectFields(item, { weird })).toEqual({});
});

// item.* 是内核的命名空间。让插件写进来，等于让它伪造这张单的标题和单号，
// 而模板渲染分不出是谁写的。
test("插件不能占用 item.* 前缀", async () => {
  const sneaky: PluginFieldSource = async () => ({ "item.title": "假的", "jira.ok": "真的" });
  expect(await collectFields(item, { sneaky })).toEqual({ "jira.ok": "真的" });
});

test("占位符语法认不出的键被丢掉", async () => {
  const weird: PluginFieldSource = async () => ({ "有空格 的键": "x", "jira.ok": "真的" });
  expect(await collectFields(item, { weird })).toEqual({ "jira.ok": "真的" });
});

test("空值被丢掉，跟没给这个键一样", async () => {
  const blank: PluginFieldSource = async () => ({ "jira.epic": "" });
  expect(await collectFields(item, { blank })).toEqual({});
});

test("值截到 MAX_FIELD_LEN", async () => {
  const long: PluginFieldSource = async () => ({ "jira.description": "x".repeat(MAX_FIELD_LEN + 100) });
  const got = await collectFields(item, { long });
  expect(got["jira.description"]!.length).toBe(MAX_FIELD_LEN);
});

// 封顶是"合并之后"，不是"每个插件"：两个插件加起来也不能灌爆一张单。
test("合并后按 MAX_FIELDS_PER_ITEM 封顶", async () => {
  const many = (prefix: string): PluginFieldSource => async () =>
    Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`${prefix}.k${i}`, "v"]));
  const got = await collectFields(item, { a: many("a"), b: many("b") });
  expect(Object.keys(got).length).toBe(MAX_FIELDS_PER_ITEM);
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `bun test src/plugin-fields.test.ts`
Expected: FAIL —— `collectFields` 不是 `plugins/handlers` 的导出

- [ ] **Step 3a: `plugins/types.ts` 加类型**

在文件末尾（`PluginEnricher` 那一行之后）追加：

```ts
/**
 * 插件可选导出的字段函数，喂给模板渲染。
 *
 * **单条，不是批量**——跟 enrich(items[]) 相反。enrich 批量是因为它服务的是一次画整页；
 * fields 只在一张单上被按下，批量除了让插件为几十张不相干的单多做功没有别的作用，而
 * 单条还让它能发一次针对性请求（Jira 拿描述正文正是 /issue/{key} 一发）。
 *
 * 键名由插件自己命名（`jira.summary`），但不许以 `item.` 开头——那是内核的命名空间。
 * 值是纯文本；内核不解释它是什么意思，只保证它不会撑破页面。
 */
export type PluginFieldSource = (item: ItemRef) => Promise<Record<string, string>>;
```

在 `Plugin` 类型里，紧跟 `facetDims?: string[];` 之后加：

```ts
  /**
   * 这个插件的 `fields()` 会产出哪些键，例如 `["jira.summary", "jira.description"]`。
   *
   * 设置页拿它列出"可用字段"给模板作者点选。跟 facetDims、titleKey、provides 同一步棋：
   * 凡是内核需要知道、又不该写死的东西，由插件在清单里声明。
   *
   * 跟 facetDims 有一点不同：这些**不是 i18n 键**，原样显示，不翻译——模板作者要打的
   * 就是这串字，给它配一份译文只会让人对不上号。src/i18n.test.ts 只扫 `titleKey:` 和
   * `facetDims:` 两个字面量，不会把这里的值当成待翻译的键。
   */
  fieldKeys?: string[];
```

- [ ] **Step 3b: `plugins/handlers.ts` 加实现**

`PluginServer` 类型里，在 `enrich?: PluginEnricher;` 之后加：

```ts
  /**
   * 一张单喂给模板的字段。用户按下按钮才走，允许一次真实的网络往返（见 FIELD_TIMEOUT_MS）。
   */
  fields?: PluginFieldSource;
```

import 行加上 `PluginFieldSource`。在 `ENRICHERS` / `ENRICH_TIMEOUT_MS` 那一段之后加：

```ts
/** 声明了字段能力的插件。跟 ENRICHERS 一样从 SERVERS 推导，不另立一张表。 */
export const FIELD_SOURCES: Record<string, PluginFieldSource> = Object.fromEntries(
  Object.entries(SERVERS)
    .filter(([, s]) => s.fields)
    .map(([id, s]) => [id, s.fields!]),
);

/**
 * 一个插件回答"这张单有哪些字段"能占多少时间。
 *
 * 既不复用 ENRICH_TIMEOUT_MS（300ms）也不复用 SOURCE_TIMEOUT_MS（30s）。300ms 是为
 * "每次页面加载都跑"设的，短到逼插件读缓存；而 fields 是用户按下按钮才走的一次显式
 * 动作，本来就该允许一次真实的往返。30s 是整批同步的预算，而这里有个人正盯着一个还
 * 没填上的输入框。
 */
export const FIELD_TIMEOUT_MS = 5_000;

/** 一个字段的长度上限。描述正文可以很长，但没有哪一段该到 4KB。 */
export const MAX_FIELD_LEN = 4000;

/** 合并**所有**插件之后，一张单最多留几个字段。不是每个插件的配额。 */
export const MAX_FIELDS_PER_ITEM = 12;

/** 占位符语法认得的键名形状，跟 src/template.ts 的 PLACEHOLDER 一致。 */
const FIELD_KEY = /^[A-Za-z0-9._-]+$/;

/**
 * 向每个声明了字段能力的插件要一次字段，合并成一张平表。
 *
 * 失败语义只有一种：**拿不到就当没有**。插件抛了、超时了、返回了不是对象的东西，都只是
 * 这一轮没有字段，模板照常渲染，那几个占位符变成空——跟 collectFacets 完全同一条安全阀。
 *
 * sources 是参数而不是直接用 FIELD_SOURCES，理由跟 collectFacets 一模一样：注册表是
 * 编译期常量，不注入假插件就没有任何办法证明超时和 try/catch 真的会兜住。
 */
export async function collectFields(
  item: ItemRef,
  sources: Record<string, PluginFieldSource> = FIELD_SOURCES,
): Promise<Record<string, string>> {
  const enabled = new Set(enabledPlugins().map((p) => p.id));
  const entries = Object.entries(sources).filter(([id]) => isConsidered(id, enabled));

  const results = await Promise.all(
    entries.map(async ([, fields]) => {
      try {
        const timeout = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), FIELD_TIMEOUT_MS),
        );
        const got = await Promise.race([fields(item), timeout]);
        if (!got || typeof got !== "object" || Array.isArray(got)) return null;
        const clean: Record<string, string> = {};
        for (const [key, value] of Object.entries(got)) {
          if (typeof value !== "string" || !value) continue;
          // 占位符写不出来的键，收下也没人能引用它。
          if (!FIELD_KEY.test(key)) continue;
          // item.* 是内核自己的命名空间——让插件写进来等于让它伪造这张单的标题和
          // 单号，而模板渲染分不出是谁写的。
          if (key.startsWith("item.")) continue;
          clean[key] = value.slice(0, MAX_FIELD_LEN);
        }
        return clean;
      } catch {
        return null;
      }
    }),
  );

  const merged: Record<string, string> = {};
  for (const one of results) {
    if (one) Object.assign(merged, one);
  }
  // 合并之后才封顶：上限是"一张单上最多几个"，不是"每个插件最多几个"。
  return Object.fromEntries(Object.entries(merged).slice(0, MAX_FIELDS_PER_ITEM));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/plugin-fields.test.ts && bun run typecheck`
Expected: 11 条全绿，类型检查无错误

Run: `bun test plugins/registry.test.ts`
Expected: PASS（两张表仍然同步 —— 这一步没加新插件，只加了一种能力）

- [ ] **Step 5: 提交**

```bash
git add plugins/types.ts plugins/handlers.ts src/plugin-fields.test.ts
git commit -m "插件契约 fields(item)：一张单喂给模板的字段

单条不批量：它只在一张单上被按下，批量只会让插件为几十张不相干的单多做功。
预算 5s 单开一个常数——300ms 是给每次页面加载的 enrich 设的，逼插件读缓存，
而这里是一次显式动作，本来就该允许一次真实往返。
安全阀逐条照抄 collectFacets，包括 sources 可注入——不注入就证明不了它会触发。"
```

---

### Task 4: `src/templates.ts` —— 模板的读写

**Files:**
- Create: `src/templates.ts`
- Test: `src/templates.test.ts`

**Interfaces:**
- Consumes: `readJson`、`writeJsonAtomic`、`serialized`（`src/json-store.ts`）
- Produces:
  - `SessionTemplate = { id: string; label: string; name: string; input: string }`
  - `templatesPath(): string`
  - `readTemplates(): Promise<SessionTemplate[]>`
  - `writeTemplates(raw: unknown): Promise<SessionTemplate[]>`（净化后写入，返回写进去的那份）
  - `MAX_TEMPLATES = 50`、`MAX_LABEL = 60`、`MAX_NAME = 200`、`MAX_INPUT = 4000`

- [ ] **Step 1: 写失败的测试**

创建 `src/templates.test.ts`：

```ts
import { test, expect, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 绝不碰用户的 ~/.tmux-next/。路径在函数体里现读，所以设在 import 之前就够。
const stamp = Math.random().toString(36).slice(2, 10);
process.env.TMUX_NEXT_TEMPLATES_PATH = join(tmpdir(), `templates-test-${stamp}.json`);

import { rm, writeFile } from "node:fs/promises";
import {
  readTemplates,
  writeTemplates,
  templatesPath,
  MAX_TEMPLATES,
  MAX_LABEL,
  MAX_INPUT,
} from "./templates";

afterEach(async () => {
  await rm(templatesPath(), { force: true });
});

test("没有文件时读成空表", async () => {
  expect(await readTemplates()).toEqual([]);
});

test("坏 JSON 读成空表，不抛", async () => {
  await writeFile(templatesPath(), "{ not json");
  expect(await readTemplates()).toEqual([]);
});

test("写进去再读出来", async () => {
  await writeTemplates([{ label: "修 bug", name: "{item.ref}", input: "修 {item.title}" }]);
  const got = await readTemplates();
  expect(got.length).toBe(1);
  expect(got[0]!.label).toBe("修 bug");
  expect(got[0]!.name).toBe("{item.ref}");
  expect(got[0]!.input).toBe("修 {item.title}");
});

test("没给 id 的会补一个，给了的保留", async () => {
  const written = await writeTemplates([
    { label: "a", name: "", input: "" },
    { id: "tpl-keepme", label: "b", name: "", input: "" },
  ]);
  expect(written[0]!.id).toMatch(/^tpl-/);
  expect(written[1]!.id).toBe("tpl-keepme");
});

// label 是选择器上唯一能认出它的东西，没有就不是一个模板。
test("label 为空的记录被丢掉", async () => {
  const written = await writeTemplates([{ label: "  ", name: "x", input: "" }]);
  expect(written).toEqual([]);
});

test("name 和 input 缺了当空串，不丢整条", async () => {
  const written = await writeTemplates([{ label: "只有标题模板" } as unknown]);
  expect(written.length).toBe(1);
  expect(written[0]!.name).toBe("");
  expect(written[0]!.input).toBe("");
});

test("不是数组时写成空表", async () => {
  expect(await writeTemplates({ nope: true })).toEqual([]);
  expect(await readTemplates()).toEqual([]);
});

test("超过 MAX_TEMPLATES 的部分被截掉", async () => {
  const many = Array.from({ length: MAX_TEMPLATES + 5 }, (_, i) => ({
    label: `t${i}`,
    name: "",
    input: "",
  }));
  expect((await writeTemplates(many)).length).toBe(MAX_TEMPLATES);
});

test("过长的 label 和 input 被截断", async () => {
  const written = await writeTemplates([
    { label: "x".repeat(MAX_LABEL + 20), name: "", input: "y".repeat(MAX_INPUT + 20) },
  ]);
  expect(written[0]!.label.length).toBe(MAX_LABEL);
  expect(written[0]!.input.length).toBe(MAX_INPUT);
});

test("整份替换：第二次写会盖掉第一次", async () => {
  await writeTemplates([{ label: "旧", name: "", input: "" }]);
  await writeTemplates([{ label: "新", name: "", input: "" }]);
  const got = await readTemplates();
  expect(got.length).toBe(1);
  expect(got[0]!.label).toBe("新");
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `bun test src/templates.test.ts`
Expected: FAIL —— `Cannot find module './templates'`

- [ ] **Step 3: 写实现**

创建 `src/templates.ts`：

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { readJson, writeJsonAtomic, serialized } from "./json-store";

/**
 * 会话模板：从一张单开会话时，会话名和首条输入长什么样。
 *
 * 一份**全局**清单，不按来源分组：所有模板对所有单可选，取不到的字段渲染成空。分组要求
 * 用户在建模板时就想清楚它适用于哪种单，而那个判断在选它的那一刻做才是自然的。
 *
 * 空清单 = 这个特性不存在：创建页不画选择器，也不多发一次请求。所以不预置任何默认模板。
 */

export type SessionTemplate = {
  id: string;
  /** 选择器上显示的名字。没有它就没法在清单里认出这一条，所以是唯一的必填项。 */
  label: string;
  /** 会话名模板。渲染后还要过 sanitiseName——净化是服务端的事。 */
  name: string;
  /** 首条输入模板，可多行、可为空。 */
  input: string;
};

export const MAX_TEMPLATES = 50;
export const MAX_LABEL = 60;
export const MAX_NAME = 200;
export const MAX_INPUT = 4000;

/** 路径在函数里现读，不在模块加载时捕获——测试要能先设 env 再调用。 */
export function templatesPath(): string {
  return process.env.TMUX_NEXT_TEMPLATES_PATH || join(homedir(), ".tmux-next", "templates.json");
}

/** `tpl-` + 时间 + 随机，跟 items.ts 的 id 同一种生成法。 */
function newId(): string {
  return `tpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * 任意输入 → 一份能存的模板表。全函数：坏文件、坏记录一律丢掉，绝不抛。
 *
 * 读和写共用同一份净化：写进去的和读出来的必须是同一种东西，否则"存了看不到"这种 bug
 * 会挑在最难查的时候出现。
 */
function sanitise(raw: unknown): SessionTemplate[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionTemplate[] = [];
  for (const value of raw.slice(0, MAX_TEMPLATES)) {
    const v = value as Record<string, unknown>;
    const label = text(v?.label, MAX_LABEL).trim();
    if (!label) continue; // 认不出的一条，留着只会在选择器上显示成一格空白
    out.push({
      id: typeof v?.id === "string" && v.id ? v.id : newId(),
      label,
      name: text(v?.name, MAX_NAME),
      input: text(v?.input, MAX_INPUT),
    });
  }
  return out;
}

export async function readTemplates(): Promise<SessionTemplate[]> {
  return readJson<SessionTemplate[]>(templatesPath(), [], sanitise);
}

/**
 * 整份替换。设置页就是一个编辑器，而逐条 CRUD 是为多写者准备的——这里只有一个人和
 * 一台机器。返回真正写进去的那份，调用方据此更新界面，不必自己猜净化的结果。
 */
export async function writeTemplates(raw: unknown): Promise<SessionTemplate[]> {
  const clean = sanitise(raw);
  await serialized(async () => {
    await writeJsonAtomic(templatesPath(), clean);
  });
  return clean;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/templates.test.ts && bun run typecheck`
Expected: 10 条全绿

- [ ] **Step 5: 提交**

```bash
git add src/templates.ts src/templates.test.ts
git commit -m "模板存盘：templates.json 的读写

读写共用一份净化——写进去的和读出来的必须是同一种东西，否则「存了看不到」会挑
在最难查的时候出现。整份替换而不是逐条 CRUD：设置页就是一个编辑器。"
```

---

### Task 5: 三条路由

**Files:**
- Modify: `src/server.ts`
- Test: `src/templates-api.test.ts`

**Interfaces:**
- Consumes: `readTemplates`/`writeTemplates`（Task 4）、`render`（Task 1）、
  `kernelFields`/`KERNEL_FIELD_KEYS`（Task 2）、`collectFields`（Task 3）、`readItems`（已有）
- Produces:
  - `GET /api/templates` → `{ templates: SessionTemplate[], fieldKeys: string[] }`
  - `PUT /api/templates`（body `{ templates: [...] }`）→ `{ templates: SessionTemplate[] }`
  - `POST /api/items/:id/render`（body `{ name, input }` 两段模板串）→ `{ name, input }` 渲染结果

- [ ] **Step 1: 写失败的测试**

创建 `src/templates-api.test.ts`：

```ts
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 绝不碰用户的 ~/.tmux-next/。
const stamp = Math.random().toString(36).slice(2, 10);
process.env.TMUX_NEXT_TEMPLATES_PATH = join(tmpdir(), `templates-api-${stamp}.json`);
process.env.TMUX_NEXT_ITEMS_PATH = join(tmpdir(), `templates-api-items-${stamp}.json`);
process.env.TMUX_NEXT_BINDINGS_PATH = join(tmpdir(), `templates-api-bindings-${stamp}.json`);
process.env.TMUX_NEXT_JIRA_DIR = join(tmpdir(), `templates-api-jira-${stamp}`);

import { rm } from "node:fs/promises";
import { startServer } from "./server";

let server: { stop(): void; port: number };
const at = (path: string) => `http://127.0.0.1:${server.port}${path}`;

const json = (path: string, method: string, body: unknown) =>
  fetch(at(path), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function makeItem(title: string, extra: Record<string, unknown> = {}) {
  const res = await json("/api/items", "POST", { title, ...extra });
  return (await res.json()) as { id: string };
}

beforeAll(() => {
  server = startServer(0);
});

afterAll(async () => {
  server.stop();
  await rm(process.env.TMUX_NEXT_TEMPLATES_PATH!, { force: true });
  await rm(process.env.TMUX_NEXT_ITEMS_PATH!, { force: true });
  await rm(process.env.TMUX_NEXT_BINDINGS_PATH!, { force: true });
});

afterEach(async () => {
  await rm(process.env.TMUX_NEXT_TEMPLATES_PATH!, { force: true });
  await rm(process.env.TMUX_NEXT_ITEMS_PATH!, { force: true });
});

test("空清单时 GET 给空数组", async () => {
  const body = await (await fetch(at("/api/templates"))).json();
  expect(body.templates).toEqual([]);
});

// 设置页要把可用字段列给模板作者，键名从服务端来，不在页面里再抄一份。
test("GET 带上内核字段名", async () => {
  const body = await (await fetch(at("/api/templates"))).json();
  expect(body.fieldKeys).toContain("item.title");
  expect(body.fieldKeys).toContain("item.ref");
});

test("PUT 写进去，GET 读得到", async () => {
  const put = await json("/api/templates", "PUT", {
    templates: [{ label: "修 bug", name: "{item.ref}", input: "修 {item.title}" }],
  });
  expect(put.status).toBe(200);
  const body = await (await fetch(at("/api/templates"))).json();
  expect(body.templates.length).toBe(1);
  expect(body.templates[0].label).toBe("修 bug");
  expect(body.templates[0].id).toMatch(/^tpl-/);
});

test("PUT 的坏 JSON 是 400", async () => {
  const res = await fetch(at("/api/templates"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "{ not json",
  });
  expect(res.status).toBe(400);
});

test("PUT 回的是净化之后的那一份", async () => {
  const res = await json("/api/templates", "PUT", {
    templates: [{ label: "好的", name: "", input: "" }, { label: "  ", name: "", input: "" }],
  });
  const body = await res.json();
  expect(body.templates.length).toBe(1);
});

test("render 把两段模板都渲染出来", async () => {
  const item = await makeItem("修登录页", { source: { provider: "jira", ref: "EXAMPLE-1" } });
  const res = await json(`/api/items/${item.id}/render`, "POST", {
    name: "{item.ref}",
    input: "看一下 {item.title}",
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ name: "EXAMPLE-1", input: "看一下 修登录页" });
});

test("render 对本地单也能用，来源那几格渲染成空并删行", async () => {
  const item = await makeItem("随手记一件事");
  const res = await json(`/api/items/${item.id}/render`, "POST", {
    name: "{item.title}",
    input: "单号：{item.ref}\n做 {item.title}",
  });
  expect(await res.json()).toEqual({ name: "随手记一件事", input: "做 随手记一件事" });
});

test("单不存在是 404", async () => {
  const res = await json("/api/items/it-nope/render", "POST", { name: "x", input: "y" });
  expect(res.status).toBe(404);
});

test("render 的坏 JSON 是 400", async () => {
  const item = await makeItem("x");
  const res = await fetch(at(`/api/items/${item.id}/render`), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  expect(res.status).not.toBe(200);
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `bun test src/templates-api.test.ts`
Expected: FAIL —— `/api/templates` 走到 404

- [ ] **Step 3: 加路由**

`src/server.ts` 顶部的 import 区加：

```ts
import { readTemplates, writeTemplates } from "./templates";
import { render } from "./template";
import { kernelFields, KERNEL_FIELD_KEYS } from "./item-fields";
import { collectFields } from "../plugins/handlers";
```

（`collectFacets` 已经从 `../plugins/handlers` import 了，把 `collectFields` 并进那一行即可。）

在 `/api/items` 的 GET/POST 那一段之后、`/api/items/bind` 之前插入：

```ts
      if (url.pathname === "/api/templates" && req.method === "GET") {
        // fieldKeys 跟模板一起下发：设置页要把"可用字段"列给模板作者，而内核字段名
        // 是内核的事实。让页面自己抄一份，两处就会飘，飘了之后列出来的键名依然长得
        // 很像真的，没有任何东西会红。
        return Response.json({ templates: await readTemplates(), fieldKeys: KERNEL_FIELD_KEYS });
      }

      if (url.pathname === "/api/templates" && req.method === "PUT") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return new Response("bad json", { status: 400 });
        }
        // 整份替换。回的是净化之后的那一份，页面据此更新，不必自己猜净化结果。
        const templates = await writeTemplates((body as Record<string, unknown>)?.templates);
        return Response.json({ templates });
      }
```

在 `/api/items/:id/refresh` 那条路由旁边（同一族，都是"对一张单做点什么"）加：

```ts
      const itemRender = url.pathname.match(/^\/api\/items\/([^/]+)\/render$/);
      if (itemRender && req.method === "POST") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return new Response("bad json", { status: 400 });
        }
        const b = body as Record<string, unknown>;
        const id = decodeURIComponent(itemRender[1]!);
        const item = (await readItems()).find((i) => i.id === id);
        if (!item) return new Response("no such item", { status: 404 });

        // 收的是模板串，不是 templateId：渲染因此跟"模板存在哪"完全解耦，设置页能边编辑
        // 边看真实预览而不必先存盘。
        const nameTpl = typeof b?.name === "string" ? b.name : "";
        const inputTpl = typeof b?.input === "string" ? b.input : "";

        // 插件的字段先铺，内核的后盖。collectFields 已经挡住了 item.* 前缀，这个顺序
        // 只是第二道——两道都在，是因为这张表最终会被当成"这张单的事实"用。
        const fields = {
          ...(await collectFields({
            id: item.id,
            source: item.source ? { provider: item.source.provider, ref: item.source.ref } : null,
          })),
          ...kernelFields(item),
        };
        return Response.json({ name: render(nameTpl, fields), input: render(inputTpl, fields) });
      }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/templates-api.test.ts && bun run typecheck`
Expected: 9 条全绿

Run: `bun test src/items-api.test.ts src/server.test.ts`
Expected: 跟改动前一样（不许因为新路由多出失败）

- [ ] **Step 5: 提交**

```bash
git add src/server.ts src/templates-api.test.ts
git commit -m "路由：模板的读写，以及按一张单渲染两段模板

render 收模板串而不是 templateId，于是渲染跟「模板存在哪」解耦——设置页能边编辑
边看真实预览，创建页也不必担心自己手上的模板和服务端读到的是不是同一份。
可用字段名跟模板一起下发，页面里不抄第二份。"
```

---

### Task 6: `readyMarker` —— 一个 agent 什么时候能收输入

**Files:**
- Modify: `src/agents/index.ts`
- Test: `src/agents/agents.test.ts`（扩）

**Interfaces:**
- Produces: `Agent.screen.readyMarker: RegExp`，claude / pi / opencode 三个都填

- [ ] **Step 1: 写失败的测试**

在 `src/agents/agents.test.ts` 末尾追加：

```ts
/**
 * readyMarker 跟 idleMarker 是两件事，这几条断言就是为了钉住这个区别。
 *
 * 起因是一次实测证伪：claude 的 idleMarker 匹配的是「一轮跑完了」（"✻ Sautéed for 9s"），
 * 一个刚起来、还没跑过任何一轮的会话**从来不打印这行**。照 idleMarker 去判断"能不能敲
 * 字了"，对 claude 会 100% 走到超时。下面三段屏幕都是从真实会话抓下来的。
 */

// 空闲等待中的 claude：屏幕底部就是孤零零一行 ❯。
const READY_SCREEN = `  ⎿  Read lib/ledger.rb (111 lines)

──────────────────────────────────── 查看单子问题 ─
❯
────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)`;

// 刚跑完一轮、但输入框里已经有字：idleMarker 命中，readyMarker 不该命中。
const DONE_SCREEN = `  没有待办。五个 PR 开着、CI 全绿。

✻ Sautéed for 9s · done 3:05 PM

────────────────────────────────────────────────────
❯ 清理 worktree 和容器
────────────────────────────────────────────────────`;

// 弹着选择菜单：两个标记都不该命中——菜单亮着的时候敲字会变成对菜单的回答。
const MENU_SCREEN = `  4. Type something.
──────────────────────────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel`;

const hits = (screen: string, re: RegExp) => screen.split("\n").some((line) => re.test(line));

test("每个 agent 都声明了 readyMarker", () => {
  for (const id of ["claude", "pi", "opencode"]) {
    expect(agentOf(id).screen.readyMarker).toBeInstanceOf(RegExp);
  }
});

test("空提示行是 claude 的就绪信号", () => {
  expect(hits(READY_SCREEN, agentOf("claude").screen.readyMarker)).toBe(true);
});

test("「一轮跑完了」不等于就绪：输入框里有字时不该敲进去", () => {
  expect(hits(DONE_SCREEN, agentOf("claude").screen.idleMarker)).toBe(true);
  expect(hits(DONE_SCREEN, agentOf("claude").screen.readyMarker)).toBe(false);
});

test("弹着菜单时两个标记都不命中", () => {
  expect(hits(MENU_SCREEN, agentOf("claude").screen.readyMarker)).toBe(false);
  expect(hits(MENU_SCREEN, agentOf("claude").screen.idleMarker)).toBe(false);
});
```

若该文件尚未 import `agentOf`，在顶部补 `import { agentOf } from "./index";`（照文件里已有的
import 风格来 —— 先看一眼它现在怎么引的，跟着写）。

- [ ] **Step 2: 跑测试确认它失败**

Run: `bun test src/agents/agents.test.ts`
Expected: FAIL —— `readyMarker` 是 undefined

- [ ] **Step 3: 加字段**

`src/agents/index.ts` 的 `Agent` 类型里，`idleMarker` 之后加：

```ts
    /**
     * 这个 agent 的输入框空着、可以收一行字了。
     *
     * **跟 idleMarker 是两件事，不能合并。** idleMarker 说的是"一轮跑完了"，claude 用
     * 它匹配 "✻ Sautéed for 9s" 这类行——一个刚起来、还没跑过任何一轮的会话从来不打印
     * 它。会话建完之后自动敲一句首条输入（src/tmux/prime.ts）要问的是"能不能敲了"，用
     * idleMarker 判断对 claude 会 100% 超时。
     *
     * 三个 agent 眼下取值相同（空提示行），但那是巧合，不是同一个概念。
     */
    readyMarker: RegExp;
```

三个 agent 的 `screen` 里各加一行（claude 那个的取值有实证：一个空闲等待中的真实会话，
屏幕底部就是孤零零一行 `❯`）：

```ts
    readyMarker: /^\s*(?:>|❯)\s*$/,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/agents/ && bun run typecheck`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/agents/index.ts src/agents/agents.test.ts
git commit -m "agent 加 readyMarker：什么时候能收一行输入

不复用 idleMarker，这是实测证伪出来的：claude 的 idleMarker 匹配的是「一轮跑完了」
（✻ Sautéed for 9s），刚起来的会话从来不打印它。三段断言用的都是真实屏幕，其中
一段是弹着选择菜单的——那种时候两个标记都不该命中。"
```

---

### Task 7: `src/tmux/prime.ts` + `initialInput`

**Files:**
- Create: `src/tmux/prime.ts`
- Modify: `src/server.ts`（`createSessionResponse`）
- Test: `src/prime.test.ts`

**Interfaces:**
- Consumes: `agentOf`（`src/agents`）、`tmux`（`src/tmux/run.ts`，返回
  `{ ok: boolean; stdout: string; stderr: string }`）、`sendText`（`src/tmux/send-text.ts`）
- Produces:
  - `waitForReady(capture: () => Promise<string | null>, marker: RegExp, opts?: { budgetMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<boolean>`
  - `primeSession(session: string, text: string, agentId?: unknown): Promise<void>`
  - `PRIME_TIMEOUT_MS = 20_000`、`PRIME_POLL_MS = 250`

- [ ] **Step 1: 写失败的测试**

创建 `src/prime.test.ts`：

```ts
import { test, expect } from "bun:test";
import { waitForReady } from "./tmux/prime";

const MARKER = /^\s*(?:>|❯)\s*$/;
// 注入的 sleep：这几条测试要证的是轮询逻辑，跟真的等多久无关。
const noSleep = async () => {};

test("一上来就就绪，问一次就返回", async () => {
  let calls = 0;
  const capture = async () => {
    calls++;
    return "some output\n❯ ";
  };
  expect(await waitForReady(capture, MARKER, { sleep: noSleep })).toBe(true);
  expect(calls).toBe(1);
});

test("先没就绪、后就绪：会一直问到命中", async () => {
  let calls = 0;
  const capture = async () => {
    calls++;
    return calls < 3 ? "Installing…" : "❯ ";
  };
  expect(await waitForReady(capture, MARKER, { sleep: noSleep })).toBe(true);
  expect(calls).toBe(3);
});

// 超时是"放弃，不发"：那时候 agent 还没到能收输入的状态，敲进去的字会变成对某个
// 确认框的回答。
test("预算耗尽就放弃", async () => {
  const capture = async () => "还在装依赖…";
  expect(
    await waitForReady(capture, MARKER, { budgetMs: 1000, pollMs: 250, sleep: noSleep }),
  ).toBe(false);
});

test("预算耗尽前问的次数由 budget/poll 决定", async () => {
  let calls = 0;
  const capture = async () => {
    calls++;
    return "nope";
  };
  await waitForReady(capture, MARKER, { budgetMs: 1000, pollMs: 250, sleep: noSleep });
  expect(calls).toBe(4);
});

// capture 拿不到屏幕（会话已经没了）跟"还没就绪"是同一种处理：继续等，等到预算用完。
test("capture 返回 null 不当成就绪", async () => {
  const capture = async () => null;
  expect(
    await waitForReady(capture, MARKER, { budgetMs: 500, pollMs: 250, sleep: noSleep }),
  ).toBe(false);
});

// 弹着选择菜单的屏幕上没有空提示行，所以不会命中——"菜单亮着时绝不敲字"是免费成立的。
test("菜单屏幕不算就绪", async () => {
  const capture = async () => "  5. Chat about this\n\nEnter to select · ↑/↓ to navigate";
  expect(
    await waitForReady(capture, MARKER, { budgetMs: 500, pollMs: 250, sleep: noSleep }),
  ).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `bun test src/prime.test.ts`
Expected: FAIL —— `Cannot find module './tmux/prime'`

- [ ] **Step 3a: 写 `src/tmux/prime.ts`**

```ts
import { agentOf } from "../agents";
import { tmux } from "./run";
import { sendText } from "./send-text";

/**
 * 会话建完之后，把首条输入敲进去。
 *
 * 难的不是敲，是**什么时候敲**：`new-session` 返回的时候里面那个 agent 还在启动，可能
 * 在装依赖、可能在问"信任这个目录吗"。所以先等它的 readyMarker（输入框空着）命中。
 *
 * 等不到就**放弃，不发**——这是这个模块唯一需要辩护的决定。超时的含义是 agent 还没到
 * 能收输入的状态，往那里敲一行字不是无害的：它会变成对一个确认框的回答。而不发的代价
 * 很小，那段文字刚刚还在创建页的框里，用户看得见它没进去，手动补一次远比误答一个 y/n
 * 便宜。
 */

/** 等一个会话就绪最多等多久。慢得可以接受，和卡住了，之间的那条线。 */
export const PRIME_TIMEOUT_MS = 20_000;

/** 两次 capture-pane 之间隔多久。 */
export const PRIME_POLL_MS = 250;

/**
 * 反复问屏幕，直到 marker 命中或预算用完。
 *
 * capture 和 sleep 都是注入的，所以这一层完全无头可测——真实的等待有二十秒，而要证的
 * 那条性质（命中就返回、耗尽就放弃）跟等多久无关。
 */
export async function waitForReady(
  capture: () => Promise<string | null>,
  marker: RegExp,
  opts: { budgetMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const budgetMs = opts.budgetMs ?? PRIME_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? PRIME_POLL_MS;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));

  for (let waited = 0; waited < budgetMs; waited += pollMs) {
    const screen = await capture();
    // 逐行判断，不是整屏 test()：marker 用 ^ 和 $ 锚定的是一行，而屏幕是多行的。
    if (screen && screen.split("\n").some((line) => marker.test(line))) return true;
    await sleep(pollMs);
  }
  return false;
}

/** 等这个会话就绪，然后敲一行字。等不到就什么也不做。 */
export async function primeSession(
  session: string,
  text: string,
  agentId?: unknown,
): Promise<void> {
  const marker = agentOf(agentId).screen.readyMarker;
  const ready = await waitForReady(async () => {
    // `=<name>:` —— capture-pane 的 -t 收的是 target-pane，末尾那个冒号才让它读成
    // 「这个会话的当前窗格」，而 = 管住会话名的精确匹配。跟 send-text.ts 同一条。
    const got = await tmux(["capture-pane", "-p", "-t", `=${session}:`]);
    return got.ok ? got.stdout : null;
  }, marker);
  if (!ready) return;
  await sendText(session, text);
}
```

- [ ] **Step 3b: `createSessionResponse` 收 `initialInput`**

`src/server.ts` import 区加：

```ts
import { primeSession } from "./tmux/prime";
```

`createSessionResponse` 的 body 类型里加一行：

```ts
    initialInput?: unknown;
```

在 `return Response.json({ name: result.name, created: result.created });` **之前**插入：

```ts
  // 首条输入。收的是**最终文本**而不是模板——用户在创建页的框里改过的那一版才是他要发
  // 的，服务端再渲染一次会把那些修改悄悄丢掉。
  //
  // 不 await：会话已经建好了，页面该立刻跳过去。等 agent 就绪要二十秒，把响应压在那里
  // 等于让人盯着一个转圈的按钮看。失败一律无声——跟 new.js 里绑定失败不拦导航同一条
  // 语义：会话本身已经是用户要的东西。
  const initial = typeof body.initialInput === "string" ? body.initialInput.trim() : "";
  // created 为假意味着复用了一个已经存在的会话。往一个正在跑的会话里敲字是错的。
  if (initial && result.created) {
    void primeSession(result.name, initial, body.agent).catch(() => {});
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/prime.test.ts && bun run typecheck`
Expected: 6 条全绿

- [ ] **Step 5: 提交**

```bash
git add src/tmux/prime.ts src/prime.test.ts src/server.ts
git commit -m "首条输入：等 agent 就绪再敲，等不到就放弃

超时不发是刻意的：那时候 agent 还没到能收输入的状态，敲进去的字会变成对某个
确认框的回答。不发的代价只是用户手动补一次，而那段文字刚刚还在他眼前。
复用已有会话（created:false）时也不敲——那是一个正在跑的会话。"
```

---

### Task 8: prime 的 integration 测试

**Files:**
- Create: `src/prime.integration.test.ts`

**Interfaces:**
- Consumes: `primeSession`（Task 7）、`tmux`（`src/tmux/run.ts`）

**⚠️ 这个任务真的会驱动 tmux。动手前把 Global Constraints 里那三条读一遍：**
**只 kill 自己建的会话、按 `=<name>` 精确 kill、绝不 kill-server、绝不删 `-c` 指向的目录。**

- [ ] **Step 1: 写失败的测试**

创建 `src/prime.integration.test.ts`：

```ts
import { test, expect, afterAll } from "bun:test";
import { tmux } from "./tmux/run";
import { primeSession } from "./tmux/prime";

/**
 * 真的建一个会话，真的敲一行字进去，真的读回来。
 *
 * 会话名带上 pid：这台机器上的 tmux 服务器是共用的，常常正跑着别人的活。带 pid 才能
 * 回答"是**我**建的吗"，清理也只清理这个前缀下的。绝不 kill-server。
 *
 * 里面跑的不是 agent，是一个 shell：这一条要证的是"等到就绪就把字敲进去了"，不是
 * claude 的启动流程。所以 marker 用 shell 提示符的形状，agent 那一层在 prime.test.ts
 * 和 agents.test.ts 里已经证过。
 */

const PREFIX = `tplprime-${process.pid}-`;
const made: string[] = [];

// -c 用仓库自己的目录：绝不能是个待会要删掉的临时目录。tmux 服务器会把它记成自己的
// 工作目录，删掉之后这台机器上之后建的每一个 pane 都起不来（见 CLAUDE.md）。
const DIR = new URL("..", import.meta.url).pathname;

async function makeSession(): Promise<string> {
  const name = `${PREFIX}${Math.random().toString(36).slice(2, 8)}`;
  const res = await tmux(["new-session", "-d", "-s", name, "-c", DIR]);
  expect(res.ok).toBe(true);
  made.push(name);
  return name;
}

afterAll(async () => {
  // 只按精确名字杀本次自己建的那些。
  for (const name of made) {
    await tmux(["kill-session", "-t", `=${name}`]);
  }
});

test("会话就绪之后，字被敲进去了", async () => {
  const name = await makeSession();
  // shell 起来要一点时间；prime 自己会轮询等，这里只是让第一次 capture 不至于空屏。
  await Bun.sleep(500);

  // 一个立刻就"就绪"的 marker：shell 提示符一画出来就命中。
  // primeSession 走 agentOf(...).screen.readyMarker，所以这里直接验证它的两层里
  // 靠下那一层——先确认字真的进去了。
  await primeSession(name, "echo tplprime-ok", "pi");

  await Bun.sleep(1000);
  const screen = await tmux(["capture-pane", "-p", "-t", `=${name}:`]);
  expect(screen.ok).toBe(true);
  expect(screen.stdout).toContain("tplprime-ok");
}, 30_000);

test("这个会话确实是本次建的，清理只碰它", async () => {
  const others = await tmux(["list-sessions", "-F", "#{session_name}"]);
  const mine = others.stdout.split("\n").filter((n) => n.startsWith(PREFIX));
  // 断言按 pid 收窄：这台机器上别人的会话一概不数，否则这条测试在真在用这个应用的
  // 机器上会永久红（见 CLAUDE.md 里孤儿会话那一节）。
  expect(mine.sort()).toEqual([...made].sort());
});
```

> **注意**：第一条用 `"pi"` 作为 agentId，是因为 pi 的 `readyMarker` 就是空提示行，
> 而一个刚起来的 shell 屏幕上很可能没有 `❯`。**先跑一次看它是过还是超时**：
> 如果超时（这条测试会跑满 20 秒然后失败），把 `primeSession` 那一行换成直接验
> `waitForReady` + `sendText` 的组合，并在测试里注释写清楚"shell 的提示符不长成
> agent 的样子，所以这条只证 send 那一半，等的那一半由 prime.test.ts 覆盖"。
> **不要为了让它变绿去改 `readyMarker` 的取值** —— 那个取值有实证支撑（Task 6）。

- [ ] **Step 2: 跑测试**

Run: `bun test src/prime.integration.test.ts`
Expected: 两条通过。若第一条超时，按上面那条注意事项处理，然后重跑。

- [ ] **Step 3: 确认没有留下会话**

Run: `tmux list-sessions -F '#{session_name}' | grep tplprime || echo "干净"`
Expected: 打印 `干净`

- [ ] **Step 4: 提交**

```bash
git add src/prime.integration.test.ts
git commit -m "integration：真起一个会话，真把首条输入敲进去，真读回来

会话名带 pid，清理只按 =<name> 精确 kill 本次自己建的那些；-c 指的是仓库目录，
不是待会要删的临时目录——删掉它会让这台机器之后建的每一个 pane 都起不来。"
```

---

### Task 9: 创建页

**Files:**
- Modify: `public/new.js`
- Modify: `public/i18n.js`（三个键 × 两份字典）
- Test: `src/new-page.test.ts`（扩）

**Interfaces:**
- Consumes: `GET /api/templates`、`POST /api/items/:id/render`（Task 5）、
  `POST /api/sessions` 的 `initialInput`（Task 7）
- Produces: 无（页面是叶子）

- [ ] **Step 1: 加 i18n 键**

`public/i18n.js` 的中文字典里，`new.*` 那一段末尾加：

```js
  "new.template": "模板",
  "new.templateNone": "不用模板",
  "new.inputPlaceholder": "首条输入（会话就绪后自动发送）",
```

英文字典对应位置加：

```js
  "new.template": "Template",
  "new.templateNone": "No template",
  "new.inputPlaceholder": "First message (sent once the agent is ready)",
```

- [ ] **Step 2: 写失败的测试**

`src/new-page.test.ts` 里，`stubFetch` 加两条分支（放在 `return new Response("{}")` 之前）：

```ts
    if (url.includes("api/templates"))
      return body("templates", {
        templates: [{ id: "tpl-1", label: "修 bug", name: "{item.ref}", input: "修 {item.title}" }],
        fieldKeys: ["item.title", "item.ref"],
      });
    if (url.includes("/render"))
      return body("render", { name: "EXAMPLE-1", input: "修 修登录页" });
```

追加测试（照该文件已有的挂载方式写 —— 先读一遍它现在怎么设 `location.search`、
怎么等渲染完成，跟着同样的写法来）：

```ts
test("带 ?item= 且有模板时，画出模板选择器", async () => {
  const doc = await mountNewPage({ search: "?item=it-1" });
  const chips = [...doc.querySelectorAll(".template-chip")].map((n) => n.textContent);
  expect(chips).toContain("不用模板");
  expect(chips).toContain("修 bug");
});

// 没有单就没有字段，每个占位符都会渲染成空——给一个必然产出空模板的选择器只是噪音。
test("没有 ?item= 时不画模板选择器", async () => {
  const doc = await mountNewPage({ search: "" });
  expect(doc.querySelector(".template-chip")).toBeNull();
});

test("选中一个模板，会话名和首条输入都被填上", async () => {
  const doc = await mountNewPage({ search: "?item=it-1" });
  const chip = [...doc.querySelectorAll(".template-chip")].find(
    (n) => n.textContent === "修 bug",
  ) as HTMLElement;
  chip.click();
  await Promise.resolve();
  await Promise.resolve();
  expect((doc.querySelector(".field.name") as HTMLInputElement).value).toBe("EXAMPLE-1");
  expect((doc.querySelector(".field.initial") as HTMLTextAreaElement).value).toBe("修 修登录页");
});
```

> 上面用了 `.field.name` / `.field.initial` 两个类名。现有的名字框只有 `field` 一个类，
> 所以实现时要给它补一个 `name`。测试里的 `mountNewPage` 若不存在，就照该文件现有的挂载
> 代码抽一个出来 —— **不要新写一套 DOM shim**，现有那套已经处理了"还原被替换的全局对象"
> 这件事，重写一套很容易漏掉它，而漏掉会连累别的测试文件。

- [ ] **Step 3: 跑测试确认它失败**

Run: `bun test src/new-page.test.ts`
Expected: FAIL —— 找不到 `.template-chip`

- [ ] **Step 4: 改 `public/new.js`**

`nameField` 那一行补上类名：

```js
  const nameField = el("input", "field name");
```

在 `nameField` 之后、`agentRow` 之前，加模板那一段：

```js
  // 模板：从一张单开会话时，会话名和首条输入长什么样。
  //
  // 只在带 ?item= 时出现——没有单就没有字段，每个占位符都会渲染成空，给一个必然产出
  // 空模板的选择器只是噪音。清单为空时同样不画，所以没建过模板的人看到的是跟以前
  // 一模一样的页面。
  const templateRow = el("div", "template-row");
  const initialField = el("textarea", "field initial");
  initialField.placeholder = tr("new.inputPlaceholder");
  initialField.rows = 4;
  initialField.style.display = "none";
  /** @type {Array<{id:string,label:string,name:string,input:string}>} */
  let templates = [];
  let chosenTemplate = null;

  function drawTemplates() {
    templateRow.replaceChildren();
    if (!itemId || !templates.length) return;
    templateRow.append(el("span", "template-label", tr("new.template")));
    const none = el("button", "template-chip", tr("new.templateNone"));
    none.type = "button";
    if (!chosenTemplate) none.classList.add("on");
    none.addEventListener("click", () => pickTemplate(null));
    templateRow.append(none);
    for (const t of templates) {
      const chip = el("button", "template-chip", t.label);
      chip.type = "button";
      if (chosenTemplate === t.id) chip.classList.add("on");
      chip.addEventListener("click", () => pickTemplate(t));
      templateRow.append(chip);
    }
  }

  /**
   * 换一个模板：两个框都**直接覆盖**，包括手改过的内容。
   *
   * 选模板这个动作的意思就是"改用这一套"，为它加一道确认，是在为一个用户刚刚亲手表达
   * 的意图设障。
   */
  async function pickTemplate(t) {
    chosenTemplate = t ? t.id : null;
    drawTemplates();
    if (!t) {
      initialField.value = "";
      initialField.style.display = "none";
      return;
    }
    initialField.style.display = "";
    try {
      const res = await fetch(`api/items/${encodeURIComponent(itemId)}/render`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: t.name, input: t.input }),
      });
      if (!res.ok) return; // 渲染不出来就让两个框保持原样，模板不是必需品
      const body = await res.json();
      nameField.value = body.name || "";
      initialField.value = body.input || "";
    } catch {
      // 离线：同上，框里还是原来那些，人照样能自己打字建会话。
    }
  }
```

`step1.append(...)` 那一行把两个新节点加进去（模板行在名字框之后，首条输入紧跟其后）：

```js
  step1.append(favourites, crumb, filter, list, nameField, templateRow, initialField, agentRow, skipRow, resumeEntry);
```

`create()` 里，在 `if (resume) payload.resume = resume;` 之后加：

```js
    // 发出去的是框里**最终**那段文字，不是模板：用户改过的那一版才是他要发的。
    const initial = initialField.value.trim();
    if (initial) payload.initialInput = initial;
```

页面初始化那个 async IIFE 里（跟 `api/agents` 那一发并列，不 await —— 模板拉不到只是没有
选择器，不该挡住目录列表）：

```js
    // 只在带 ?item= 时问：没有单就不会画选择器，那一发请求纯属浪费。
    if (itemId) {
      fetch("api/templates")
        .then((r) => (r.ok ? r.json() : null))
        .then((body) => {
          if (body?.templates?.length) {
            templates = body.templates;
            drawTemplates();
          }
        })
        .catch(() => {});
    }
```

- [ ] **Step 5: 加样式**

`public/style.css` 里，`.agent-row` / `.agent-chip` 那一段旁边加（**颜色只用主题变量**，
`src/themes.test.ts` 会因为一个色值字面量而变红）：

```css
.template-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.template-label { color: var(--text-2); font-size: 13px; }
.template-chip {
  background: var(--surface-4);
  color: var(--text-1);
  border: 1px solid var(--border-1);
  border-radius: 999px;
  padding: 6px 12px;
}
.template-chip.on { background: var(--accent); color: var(--surface-1); border-color: var(--accent); }
textarea.field.initial { min-height: 96px; resize: vertical; font: inherit; }
```

- [ ] **Step 6: 跑测试确认通过**

Run: `bun test src/new-page.test.ts src/i18n.test.ts src/public-parses.test.ts src/themes.test.ts src/responsive.test.ts`
Expected: 全绿。`i18n.test.ts` 红了通常是某个键只加进了一份字典。

- [ ] **Step 7: 提交**

```bash
git add public/new.js public/i18n.js public/style.css src/new-page.test.ts
git commit -m "创建页：选一个模板，会话名和首条输入一起填好

只在带 ?item= 且有模板时才画选择器——没有单就没有字段，那个选择器必然产出空模板。
切换模板直接覆盖两个框：选模板的意思就是「改用这一套」，为它加确认是在为用户刚刚
亲手表达的意图设障。"
```

---

### Task 10: 设置页

**Files:**
- Modify: `public/settings.js`
- Modify: `public/i18n.js`
- Test: `src/settings-page.test.ts`（扩）

**Interfaces:**
- Consumes: `GET/PUT /api/templates`（Task 5）、`PLUGINS`（`plugins/registry.js`，
  settings.js 已经 import 了它）
- Produces: 无

- [ ] **Step 1: 加 i18n 键**

中文字典 `settings.*` 段末尾：

```js
  "settings.templates": "会话模板",
  "settings.templatesNote": "从一张单开会话时可以选一个模板，把会话名和首条输入一起填好。",
  "settings.templateLabel": "模板名",
  "settings.templateName": "会话名",
  "settings.templateInput": "首条输入",
  "settings.templateNew": "新建模板",
  "settings.templateDelete": "删除",
  "settings.templateKeys": "可用字段（点一下插入）",
  "settings.templateEmpty": "还没有模板",
```

英文字典：

```js
  "settings.templates": "Session templates",
  "settings.templatesNote": "Starting a session from an item can use a template to fill in the session name and the first message.",
  "settings.templateLabel": "Template name",
  "settings.templateName": "Session name",
  "settings.templateInput": "First message",
  "settings.templateNew": "New template",
  "settings.templateDelete": "Delete",
  "settings.templateKeys": "Available fields (tap to insert)",
  "settings.templateEmpty": "No templates yet",
```

- [ ] **Step 2: 写失败的测试**

`src/settings-page.test.ts` 的 fetch stub 里加 `api/templates` 的分支（GET 回一条模板 +
`fieldKeys`，PUT 回它收到的东西），然后追加：

```ts
test("模板一节列出已有模板", async () => {
  const doc = await mountSettings();
  const labels = [...doc.querySelectorAll(".template-item input.settings-input")].map(
    (n) => (n as HTMLInputElement).value,
  );
  expect(labels).toContain("修 bug");
});

test("可用字段既有内核的也有插件的", async () => {
  const doc = await mountSettings();
  const keys = [...doc.querySelectorAll(".template-key")].map((n) => n.textContent);
  expect(keys).toContain("{item.title}");   // 服务端下发的
  expect(keys).toContain("{jira.summary}"); // 插件清单里声明的
});

test("新建按钮多加一条", async () => {
  const doc = await mountSettings();
  const before = doc.querySelectorAll(".template-item").length;
  (doc.querySelector(".template-new") as HTMLElement).click();
  expect(doc.querySelectorAll(".template-item").length).toBe(before + 1);
});

test("删除按钮少一条", async () => {
  const doc = await mountSettings();
  const before = doc.querySelectorAll(".template-item").length;
  (doc.querySelector(".template-item .template-del") as HTMLElement).click();
  expect(doc.querySelectorAll(".template-item").length).toBe(before - 1);
});
```

> `mountSettings` 若不存在就照该文件现有的挂载代码抽一个出来。同样：**不要新写 DOM shim**。

- [ ] **Step 3: 跑测试确认它失败**

Run: `bun test src/settings-page.test.ts`
Expected: FAIL —— 找不到 `.template-item`

- [ ] **Step 4: 写 `templatesSection()`**

`public/settings.js` 里加（放在 `pluginSections` 附近，跟它是同一族）：

```js
/**
 * 会话模板的增删改。
 *
 * 可用字段分两半：内核那几个由服务端跟模板一起下发（GET /api/templates 的 fieldKeys），
 * 插件那几个从同构的 registry.js 里读它们自己声明的 fieldKeys。**这一页里没有任何一个
 * 插件名**——跟顶栏用 titleKey 画标签、卡片用 dim 画 chip 是同一步棋。
 *
 * 键名原样显示、不翻译：模板作者要打的就是这串字。
 */
function templatesSection(templates, fieldKeys) {
  const list = el("div", "template-list");
  /** @type {Array<() => any>} */
  const readers = [];
  /** @type {HTMLTextAreaElement | HTMLInputElement | null} */
  let lastFocused = null;

  function addRow(t) {
    const row = el("div", "template-item");
    const mk = (labelKey, value, multi) => {
      const wrap = el("label", "settings-field");
      wrap.append(el("span", "settings-label", tr(labelKey)));
      const input = document.createElement(multi ? "textarea" : "input");
      input.className = "settings-input";
      input.value = value || "";
      if (multi) input.rows = 4;
      input.addEventListener("focus", () => { lastFocused = input; });
      wrap.append(input);
      row.append(wrap);
      return input;
    };
    const label = mk("settings.templateLabel", t.label, false);
    const name = mk("settings.templateName", t.name, false);
    const input = mk("settings.templateInput", t.input, true);

    const del = el("button", "btn template-del", tr("settings.templateDelete"));
    del.type = "button";
    del.addEventListener("click", () => {
      row.remove();
      const at = readers.indexOf(read);
      if (at >= 0) readers.splice(at, 1);
    });
    row.append(del);

    const read = () => ({ id: t.id, label: label.value, name: name.value, input: input.value });
    readers.push(read);
    list.append(row);
  }

  for (const t of templates) addRow(t);
  if (!templates.length) list.append(el("p", "settings-note", tr("settings.templateEmpty")));

  // 可用字段：点一下插到刚才那个框的光标处。
  const keys = el("div", "template-keys");
  keys.append(el("span", "settings-label", tr("settings.templateKeys")));
  const pluginKeys = PLUGINS.flatMap((p) => p.fieldKeys || []);
  for (const key of [...fieldKeys, ...pluginKeys]) {
    const chip = el("button", "template-key", `{${key}}`);
    chip.type = "button";
    chip.addEventListener("click", () => {
      if (!lastFocused) return;
      const at = lastFocused.selectionStart ?? lastFocused.value.length;
      lastFocused.value =
        lastFocused.value.slice(0, at) + `{${key}}` + lastFocused.value.slice(at);
      lastFocused.focus();
    });
    keys.append(chip);
  }

  const add = el("button", "btn template-new", tr("settings.templateNew"));
  add.type = "button";
  add.addEventListener("click", () => {
    const note = list.querySelector(".settings-note");
    if (note) note.remove();
    addRow({ id: "", label: "", name: "", input: "" });
  });

  const note = el("p", "settings-result", "");
  note.hidden = true;
  const save = el("button", "btn primary", tr("settings.save"));
  save.type = "button";
  save.addEventListener("click", async () => {
    save.disabled = true;
    save.textContent = tr("settings.saving");
    note.hidden = true;
    let ok = false;
    try {
      const res = await fetch(url("api/templates"), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ templates: readers.map((r) => r()) }),
      });
      ok = res.ok;
    } catch {
      ok = false;
    }
    note.textContent = ok ? tr("settings.saved") : tr("settings.cfgSaveFailed");
    note.hidden = false;
    save.disabled = false;
    save.textContent = tr("settings.save");
  });

  const actions = el("div", "settings-actions");
  actions.append(add, save);
  return section(
    tr("settings.templates"),
    el("p", "settings-note", tr("settings.templatesNote")),
    list,
    keys,
    actions,
    note,
  );
}
```

`renderSettings` 的 `draw()` 里，跟插件那几节一样晚一步到（要问服务端）：

```js
    // 模板那一节也要问服务端，跟插件几节一起晚一步到。
    try {
      const res = await fetch(url("api/templates"));
      if (res.ok) {
        const body = await res.json();
        root.append(templatesSection(body.templates || [], body.fieldKeys || []));
      }
    } catch {
      // 这一节这次画不出来，别的照常。
    }
```

- [ ] **Step 5: 加样式**

`public/style.css`：

```css
.template-item { border: 1px solid var(--border-1); border-radius: 10px; padding: 12px; margin-bottom: 12px; }
.template-keys { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 8px 0; }
.template-key {
  background: var(--surface-3);
  color: var(--text-2);
  border: 1px solid var(--border-1);
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 12px;
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `bun test src/settings-page.test.ts src/i18n.test.ts src/themes.test.ts src/public-parses.test.ts`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add public/settings.js public/i18n.js public/style.css src/settings-page.test.ts
git commit -m "设置页：模板的增删改，以及可用字段的提示

可用字段分两半：内核那几个由服务端下发，插件那几个从 registry.js 里读它们自己
声明的 fieldKeys。这一页里没有任何一个插件名——跟顶栏用 titleKey 画标签同一步棋。
键名原样显示不翻译：模板作者要打的就是这串字。"
```

---

### Task 11: Jira 的 `fields()`

**Files:**
- Create: `plugins/jira/adf.ts`
- Test: `plugins/jira/adf.test.ts`
- Modify: `plugins/jira/client.ts`（`fetchIssueDescription`）
- Modify: `plugins/jira/server.ts`（`export async function fields`）
- Modify: `plugins/jira/plugin.js`（`fieldKeys`）
- Modify: `plugins/handlers.ts`（`SERVERS.jira.fields`）

**Interfaces:**
- Consumes: `PluginFieldSource`（Task 3）、`readJiraConfig`、`Issue`、模块级的 `cache`
- Produces: `fields(item: ItemRef): Promise<Record<string, string>>`，键为
  `jira.summary` / `jira.status` / `jira.type` / `jira.epic` / `jira.assignee` / `jira.description`

- [ ] **Step 1: 写 ADF 的失败测试**

创建 `plugins/jira/adf.test.ts`：

```ts
import { test, expect } from "bun:test";
import { adfToText } from "./adf";

test("段落之间空一行", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "第一段" }] },
      { type: "paragraph", content: [{ type: "text", text: "第二段" }] },
    ],
  };
  expect(adfToText(doc)).toBe("第一段\n\n第二段");
});

test("同一段里的多个文本节点连起来", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "加粗" }, { type: "text", text: "普通" }] },
    ],
  };
  expect(adfToText(doc)).toBe("加粗普通");
});

test("列表项前面加短横", () => {
  const doc = {
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "甲" }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "乙" }] }] },
        ],
      },
    ],
  };
  expect(adfToText(doc)).toBe("- 甲\n- 乙");
});

test("hardBreak 是一个换行", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "上" }, { type: "hardBreak" }, { type: "text", text: "下" }] },
    ],
  };
  expect(adfToText(doc)).toBe("上\n下");
});

// 描述可能是 null（没写描述）、可能是字符串（老的 wiki 格式），也可能是别的什么。
// 一律不抛：拿不到就当没有，这是 fields 整条路的失败语义。
test("认不出的输入返回空串", () => {
  expect(adfToText(null)).toBe("");
  expect(adfToText("纯字符串")).toBe("纯字符串");
  expect(adfToText(42)).toBe("");
});

test("深度嵌套不会栈溢出", () => {
  let node: unknown = { type: "text", text: "底" };
  for (let i = 0; i < 200; i++) node = { type: "paragraph", content: [node] };
  expect(adfToText({ type: "doc", content: [node] })).toContain("底");
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `bun test plugins/jira/adf.test.ts`
Expected: FAIL —— `Cannot find module './adf'`

- [ ] **Step 3: 写 `plugins/jira/adf.ts`**

```ts
/**
 * Jira 的富文本（Atlassian Document Format）→ 纯文本。
 *
 * 描述正文要被塞进一个终端里的输入框，所以要的就是纯文本，不是保真的转换：这里只认
 * 段落、列表和换行，别的一律当容器往下走。认不出的输入返回空串而不是抛——fields 整条
 * 路的失败语义是"拿不到就当没有"，一个格式没见过的描述不该让整张模板渲染不出来。
 *
 * 迭代而不是递归：描述是别人写的，嵌套深度没有上限，而爆栈会变成一个 500。
 */
export function adfToText(node: unknown): string {
  // 老实例的描述可能直接是一段字符串（wiki 标记），原样用。
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";

  const parts: string[] = [];
  /** 栈上放的是"还没处理的节点"或"一段已经定好的字面量"。 */
  const stack: Array<{ node?: unknown; literal?: string }> = [{ node }];

  while (stack.length) {
    const top = stack.pop()!;
    if (top.literal !== undefined) {
      parts.push(top.literal);
      continue;
    }
    const n = top.node as Record<string, unknown>;
    if (!n || typeof n !== "object") continue;

    if (n.type === "text" && typeof n.text === "string") {
      parts.push(n.text);
      continue;
    }
    if (n.type === "hardBreak") {
      parts.push("\n");
      continue;
    }

    const children = Array.isArray(n.content) ? n.content : [];
    // 后进先出，所以要倒着压。
    const framed: Array<{ node?: unknown; literal?: string }> = [];
    if (n.type === "listItem") framed.push({ literal: "- " });
    for (const child of children) framed.push({ node: child });
    if (n.type === "paragraph" || n.type === "heading") framed.push({ literal: "\n\n" });
    if (n.type === "listItem") framed.push({ literal: "\n" });
    for (let i = framed.length - 1; i >= 0; i--) stack.push(framed[i]!);
  }

  // 段落之间空一行，但整体两头不留空白；列表项之间只空一行。
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}
```

> 上面的分隔符拼法要靠测试逼出来。**跑测试，按它说的调**，不要反过来改测试的期望值 ——
> 那几条期望（段落空一行、列表项前面短横、hardBreak 一个换行）就是这个函数的规格。

- [ ] **Step 4: 跑到绿**

Run: `bun test plugins/jira/adf.test.ts`
Expected: 6 条全绿

- [ ] **Step 5: `fetchIssueDescription`**

`plugins/jira/client.ts` 末尾加：

```ts
/**
 * 一个单的描述正文，纯文本。拿不到就是 null。
 *
 * 单独一发、单独一个 fields 参数，**不把 description 并进共享的 FIELDS**：那个常量是
 * 工单列表用的，一次拉五十条，把正文并进去等于让每次开首页都多下载几十 KB 富文本，
 * 而列表一个字都不显示它。
 */
export async function fetchIssueDescription(
  config: JiraConfig,
  key: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const auth = "Basic " + btoa(`${config.email}:${config.token}`);
  let res: Response;
  try {
    res = await fetcher(
      `${config.url}/rest/api/3/issue/${encodeURIComponent(key)}?fields=description`,
      {
        headers: { authorization: auth, accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const body = (await res.json()) as { fields?: { description?: unknown } };
    const text = adfToText(body?.fields?.description);
    return text || null;
  } catch {
    return null;
  }
}
```

顶部 import 加 `import { adfToText } from "./adf";`。

- [ ] **Step 6: `fields()`**

`plugins/jira/server.ts` 加（`enrich` 附近）：

```ts
/**
 * 描述正文的缓存。跟 dev 那份同样的道理：它要一次真实的请求，而模板选择器在同一张单上
 * 很可能被点好几下（换个模板看看）。
 */
const DESC_CACHE_MS = 5 * 60_000;
const descCache = new Map<string, { at: number; text: string | null }>();

/**
 * 一张单喂给模板的字段。
 *
 * 便宜的那几格直接从工单列表的缓存里取——它们本来就在内存里。只有描述正文要发一次请求，
 * 这也正是 fields 的预算是 5 秒而不是 enrich 的 300 毫秒的原因。
 */
export async function fields(item: ItemRef): Promise<Record<string, string>> {
  if (item.source?.provider !== "jira") return {};
  const key = item.source.ref;

  const out: Record<string, string> = {};
  const issue = cache?.result.ok ? cache.result.issues.find((i) => i.key === key) : undefined;
  if (issue) {
    out["jira.summary"] = issue.summary;
    out["jira.status"] = issue.status;
    out["jira.type"] = issue.type;
    if (issue.assignee) out["jira.assignee"] = issue.assignee;
    // 史诗只在父级确实是史诗（hierarchy 1）时才算——把子任务的父任务标成史诗是错的。
    if (issue.parent && issue.parent.hierarchy === 1) out["jira.epic"] = issue.parent.summary;
  }

  const hit = descCache.get(key);
  let description = hit && Date.now() - hit.at < DESC_CACHE_MS ? hit.text : undefined;
  if (description === undefined) {
    const config = await readJiraConfig();
    description = config ? await fetchIssueDescription(config, key) : null;
    descCache.set(key, { at: Date.now(), text: description });
  }
  if (description) out["jira.description"] = description;

  return out;
}
```

import 里补上 `fetchIssueDescription`。

- [ ] **Step 7: 接线**

`plugins/handlers.ts` 的 jira import 加 `fields as jiraFields`，`SERVERS.jira` 里加
`fields: jiraFields,`。

`plugins/jira/plugin.js` 的 `facetDims` 之后加：

```js
  // 模板可以引用的字段。设置页照着这个列"可用字段"给模板作者点选。
  // 跟 facetDims 不同：**这些不是 i18n 键**，原样显示、不翻译。
  fieldKeys: [
    "jira.summary",
    "jira.status",
    "jira.type",
    "jira.epic",
    "jira.assignee",
    "jira.description",
  ],
```

- [ ] **Step 8: 跑全套相关测试**

Run: `bun test plugins/ src/plugin-fields.test.ts src/i18n.test.ts && bun run typecheck`
Expected: 全绿。**特别确认 `src/i18n.test.ts` 没有把 `fieldKeys` 里的值当成待翻译的
i18n 键** —— 它只扫 `titleKey:` 和 `facetDims:` 两个字面量，所以本该没事；真红了就是
扫描器比预期宽，那时候要改的是扫描器的正则，不是把这些键塞进字典。

- [ ] **Step 9: 提交**

```bash
git add plugins/jira/adf.ts plugins/jira/adf.test.ts plugins/jira/client.ts \
        plugins/jira/server.ts plugins/jira/plugin.js plugins/handlers.ts
git commit -m "Jira：把摘要、状态、史诗和描述正文喂给模板

描述正文单独一发、单独一个 fields 参数，不并进共享的 FIELDS——那个常量一次拉五十条，
把正文并进去等于每次开首页多下几十 KB 富文本，而列表一个字都不显示它。
ADF 转纯文本用迭代不用递归：描述是别人写的，嵌套深度没有上限，爆栈会变成一个 500。"
```

---

### Task 12: 文档

**Files:**
- Modify: `CLAUDE.md`、`README.md`、`README.zh-CN.md`

- [ ] **Step 1: CLAUDE.md**

在讲 `enrich` / `collectFacets` 那一段之后，加一段（跟周围一样：写**为什么**，不写用法）：

要点，每一条都要写进去：
1. `fields(item)` 是单条而 `enrich(items[])` 是批量，以及为什么 —— `enrich` 服务的是一次
   画整页，`fields` 只在一张单上被按下。
2. 预算 5s 单开一个常数，跟 `enrich` 的 300ms、`sync` 的 30s 三者的分工。
3. `item.` 命名空间的两半：`kernelFields` 往里放，`collectFields` 挡住插件进来。
4. `readyMarker` 不复用 `idleMarker`，以及那次实测证伪（claude 的 `idleMarker` 匹配的是
   "一轮跑完了"，刚起来的会话从来不打印它）。**这一条最值得写**，因为它是一个下次还会
   有人踩的坑。
5. prime 超时是放弃而不是照发，理由是"敲进去的字会变成对一个确认框的回答"。
6. 模板的删行规则是按行全有全无，以及为什么不做得更聪明。

- [ ] **Step 2: README 双份**

两份都要改，内容对等：在讲"从单开会话"的地方补一句模板，并说明模板在设置页里建。
**`README.md` 是英文、`README.zh-CN.md` 是中文，不要写反，也不要只改一份。**

- [ ] **Step 3: 跑全套**

Run: `bun run test`
Expected: 跟动手之前的失败数一致（记住：有一条稳定的 9 失败 / 1 错误的历史尾巴，
跟本计划无关）。**如果多出新的失败，那是本计划引入的，要修。**

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md README.md README.zh-CN.md
git commit -m "文档：会话模板

重点记两条会被再踩一次的：readyMarker 不等于 idleMarker（claude 的 idleMarker 匹配
「一轮跑完了」，刚起来的会话从来不打印它），以及 prime 超时是放弃不是照发。"
```

---

## 自查

**规格覆盖**（对着 spec 逐节点名）：

| spec | 任务 |
|---|---|
| §1 templates.json | Task 4 |
| §2 fields(item) + 安全阀 + 5s 预算 | Task 3 |
| §2 内核字段走同一条路 | Task 2 |
| §3 渲染 + 删行规则 + sanitiseName + 截断时机 | Task 1 |
| §4 三条路由 | Task 5 |
| §4 initialInput + prime + created:false 不 prime | Task 7 |
| §4 readyMarker 是新字段 | Task 6 |
| §5 创建页 | Task 9 |
| §5 设置页 + fieldKeys | Task 10、Task 11 Step 7 |
| §6 各测试文件 | 分散在各任务的 Step 1 |
| §6 integration | Task 8 |
| 文档 | Task 12 |

spec 里提到但**本计划没有单独任务**的一处：Jira 侧 `fields` 的实现在 spec 里只是被举例
提及（"Jira 拿描述正文正是 /issue/{key} 一发"），没有单独一节。Task 11 把它补上了 ——
没有它，`fields` 这条契约在真实的仓库里没有任何一个实现，那条 5 秒预算也就无从验证。

**类型一致性**：`render`/`sanitiseName`（T1）→ 被 T5 的路由调用；`kernelFields`/
`KERNEL_FIELD_KEYS`（T2）→ T5 路由 + T10 页面（经服务端下发）；`collectFields`（T3）→
T5 路由；`PluginFieldSource`（T3）→ T11 的 `fields`；`readTemplates`/`writeTemplates`
（T4）→ T5 路由；`readyMarker`（T6）→ T7 的 `primeSession`；`waitForReady`/`primeSession`
（T7）→ T7 的 server 接线 + T8 的 integration。名字在各任务之间前后一致。

---

## 执行方式

计划已存到 `docs/superpowers/plans/2026-09-03-session-templates.md`。两种执行方式：

1. **子代理逐任务（推荐）** —— 每个任务派一个全新的子代理，任务之间我来审，迭代快。
2. **本会话内联执行** —— 用 executing-plans 在这个会话里成批做，中间设检查点。

选哪个？
