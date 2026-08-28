# 插件接缝 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把制品库和通知页从内核里拔成两个内置插件，让"加一个页面级功能"等于"加一个目录"。

**Architecture:** 每个插件是 `plugins/<id>/` 一个目录，含同构清单 `plugin.js`（id / 图标 / 标题键 / i18n）、服务端 `server.ts`（`handle(req, url)`）、以及 `public/` 页面。内核从写死的 `plugins/registry.js` 取清单，把 `/api/<id>/*` 分发给对应 handler，把 `/p/<id>/*` 映射到插件的 `public/`。清单与 handler 分两张表——`registry.js` 被浏览器加载，引到 `.ts` 就会把服务端代码拖进浏览器包。

**Tech Stack:** Bun（无构建步骤）、TypeScript（`tsc --noEmit` 只做类型检查）、`public/` 下是浏览器直接加载的纯 ES 模块、`bun test`、happy-dom 用于 DOM 渲染测试。

**Spec:** `docs/superpowers/specs/2026-08-28-plugin-seam-design.md`

## Global Constraints

- **不做运行时动态加载。** 注册表写死在 `plugins/registry.js`，不扫描任何用户目录。
- **清单与 handler 分两张表。** `plugins/registry.js`（同构，浏览器 import）绝不能 import 任何 `.ts`。
- **全站不用绝对路径。** 会弄断反代子路径部署。共享模块用 `public/root.js` 的 `url()` 从 `import.meta.url` 推根。
- **每个 tmux 调用走 `tmux(argv)`，永不用 `Bun.$`。** 本计划不新增 tmux 调用，但搬动的代码里若有，原样保留。
- **状态路径在函数里惰性读 env，不在模块加载时捕获。** 测试要能先设 env 再调用。
- **提交信息不带任何助手署名。** 没有 `Co-Authored-By:`、没有 `Claude-Session:`、没有 `🤖 Generated with`。提交信息用中文，格式跟 `git log` 里现有的一致（`feat:` / `fix:` / `refactor:` / `docs:`）。
- **每个任务结束跑 `bun run test`**（= `tsc --noEmit && bun test`）。`src/server.test.ts` 与 `src/reconnect.test.ts` 的孤儿会话断言在并行下偶发飘红，单独重跑该文件再判断是不是回归。
- **插件 id 必须匹配 `^[a-z][a-z0-9-]*$`**，全仓唯一，且不得是 `plugins`（会跟 `/api/plugins` 撞）。

---

### Task 1: 根路径助手 `public/root.js`

页面搬到 `/p/<id>/` 之后，所有页面相对的 `fetch("api/…")` 和 `location.href = "new.html"` 都会解析到错的地方。而共享模块（`i18n-apply.js`、`nav.js`）的相对 URL 是按**页面**解析的，不是按模块，所以问题不能靠"在插件脚本里多写几个 `../..`"解决。

**Files:**
- Create: `public/root.js`
- Create: `src/root-url.test.ts`
- Modify: `public/i18n-apply.js:79`、`public/i18n-apply.js:109`（两处 `fetch("api/language")`）

**Interfaces:**
- Produces: `resolve(base: string, path: string): string` — 纯函数，把 `path` 按 `base` 解析成绝对 href
- Produces: `url(path: string): string` — 把 `path` 按**应用根**解析；应用根从 `root.js` 自己的 `import.meta.url` 推出

- [ ] **Step 1: 写失败的测试**

创建 `src/root-url.test.ts`：

```ts
import { test, expect } from "bun:test";
import { resolve } from "../public/root.js";

/**
 * 页面搬进 /p/<id>/ 之后，页面相对的 URL 会解析到插件目录底下。
 * 这个模块的整个存在理由，就是让共享代码按「应用根」解析而不是按页面。
 *
 * base 永远是 root.js 自己的 URL —— 它总在根上，所以从它推根是可靠的；
 * 而它在哪个前缀下被服务，推出来的根就在哪个前缀下，子路径部署因此不破。
 */

test("从根上的模块解析，指回根", () => {
  expect(resolve("https://h/root.js", "api/gallery")).toBe("https://h/api/gallery");
  expect(resolve("https://h/root.js", "new.html")).toBe("https://h/new.html");
});

test("页面在 /p/<id>/ 时仍指回根，而不是插件目录", () => {
  // 这正是 fetch("api/gallery") 会踩的坑：它会打到 /p/gallery/api/gallery。
  // resolve 的 base 是模块的 URL，不是页面的，所以不受页面深度影响。
  expect(resolve("https://h/root.js", "api/gallery")).toBe("https://h/api/gallery");
});

test("挂在反代子路径下时，根跟着前缀走", () => {
  // 绝对路径会写死成 /api/gallery，在 /tmux/ 前缀下直接 404。
  expect(resolve("https://h/tmux/root.js", "api/gallery")).toBe("https://h/tmux/api/gallery");
  expect(resolve("https://h/tmux/root.js", "p/gallery/")).toBe("https://h/tmux/p/gallery/");
});

test("查询串和片段原样带过去", () => {
  expect(resolve("https://h/root.js", "terminal.html?target=a%20b")).toBe(
    "https://h/terminal.html?target=a%20b",
  );
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
bun test src/root-url.test.ts
```

预期：FAIL，`Cannot find module '../public/root.js'`。

- [ ] **Step 3: 写实现**

创建 `public/root.js`：

```js
// @ts-check
/**
 * 应用根，以及按它解析路径。
 *
 * 全站的 URL 都是相对的，为的是能挂在反代的子路径下——绝对路径会把这个能力
 * 弄断。但相对 URL 是按**页面**解析的，而插件页面在 /p/<id>/ 下：共享模块里
 * 一句 fetch("api/language") 从列表页打到 /api/language，从制品页打到
 * /p/gallery/api/language。
 *
 * 所以根从这个模块自己的 URL 推——它永远在根上，且它在哪个前缀下被服务，推出
 * 来的根就在哪个前缀下。两个性质都要，缺一不可。
 */

/** 纯粹的一层，好在 src/root-url.test.ts 里不带 DOM 地测。 */
export function resolve(/** @type {string} */ base, /** @type {string} */ path) {
  return new URL(path, base).href;
}

const ROOT = import.meta.url;

/** 把一个根相对的路径解析成能用的 URL。 */
export function url(/** @type {string} */ path) {
  return resolve(ROOT, path);
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
bun test src/root-url.test.ts
```

预期：4 个测试全 PASS。

- [ ] **Step 5: 让 `i18n-apply.js` 用上它**

`public/i18n-apply.js` 顶部加 import：

```js
import { url } from "./root.js";
```

把两处 `fetch("api/language")` 改成 `fetch(url("api/language"))`（第 79 行是 GET，第 109 行是带 `method: "POST"` 的那次，只改第一个参数，其余不动）。

- [ ] **Step 6: 跑全量**

```bash
bun run test
```

预期：全绿。`public-parses.test.ts` 会把 `root.js` 一并纳入检查。

- [ ] **Step 7: 提交**

```bash
git add public/root.js public/i18n-apply.js src/root-url.test.ts
git commit -m "feat: 加根路径助手，共享模块不再按页面解析 URL"
```

---

### Task 2: 插件类型与注册表，制品库的清单搬进去

先只搬**声明**：id、图标、标题键、那 17 个 `gallery.*` 文案。路由和页面都不动，行为零变化。

**Files:**
- Create: `plugins/types.ts`
- Create: `plugins/registry.js`
- Create: `plugins/gallery/plugin.js`
- Create: `plugins/registry.test.ts`
- Modify: `public/i18n.js`（删 `gallery.*` 键，加合并循环）
- Modify: `src/server.ts`（加 `/plugins/registry.js` 与 `/plugins/<id>/plugin.js` 两条路由）
- Modify: `tsconfig.json`（`include` 加 `plugins`）
- Modify: `package.json`（`files` 加 `plugins`）

**Interfaces:**
- Produces: `Plugin = { id: string; titleKey: string; icon: string; i18n: { zh: Record<string,string>; en: Record<string,string> } }`
- Produces: `PluginHandler = (req: Request, url: URL) => Promise<Response | null>`
- Produces: `PLUGINS: Plugin[]`（`plugins/registry.js` 具名导出）

- [ ] **Step 1: 写失败的测试**

创建 `plugins/registry.test.ts`：

```ts
import { test, expect } from "bun:test";
import { PLUGINS } from "./registry.js";

/**
 * 注册表是写死的，所以这里检的不是"扫描对不对"，而是清单本身自洽——
 * 尤其是最后那条 import 图断言：registry.js 被浏览器加载，里面只要引到一个
 * .ts，服务端代码就被拖进浏览器包，而这种事只有构建器看得见。
 */

test("有插件可查", () => {
  expect(PLUGINS.length).toBeGreaterThan(0);
});

test("每个 id 合法、唯一，且不撞内核路由", () => {
  const ids = PLUGINS.map((p) => p.id);
  for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  expect(ids).toEqual([...new Set(ids)]);
  // /api/plugins 是内核的，一个叫 plugins 的插件会把它盖掉。
  expect(ids).not.toContain("plugins");
});

test("每个清单字段齐全", () => {
  for (const p of PLUGINS) {
    expect(typeof p.titleKey).toBe("string");
    expect(p.titleKey.length).toBeGreaterThan(0);
    expect(typeof p.icon).toBe("string");
    expect(p.icon.length).toBeGreaterThan(0);
  }
});

test("每个插件的两本字典键集一致", () => {
  for (const p of PLUGINS) {
    const zh = Object.keys(p.i18n.zh).sort();
    const en = Object.keys(p.i18n.en).sort();
    // 报成 diff 而不是布尔，失败时能直接看见是哪个键。
    expect({ id: p.id, zhOnly: zh.filter((k) => !en.includes(k)) })
      .toEqual({ id: p.id, zhOnly: [] });
    expect({ id: p.id, enOnly: en.filter((k) => !zh.includes(k)) })
      .toEqual({ id: p.id, enOnly: [] });
  }
});

test("清单里的标题键在它自己的字典里", () => {
  for (const p of PLUGINS) expect(p.i18n.en[p.titleKey]).toBeDefined();
});

test("registry.js 的 import 图里没有 .ts", async () => {
  // 浏览器要加载它。引到一个 .ts 就等于把服务端代码打进浏览器包——
  // 这是这套两张表设计唯一防的东西，所以由测试守着。
  const built = await Bun.build({
    entrypoints: [new URL("./registry.js", import.meta.url).pathname],
    target: "browser",
  });
  expect(built.logs.map(String)).toEqual([]);
  expect(built.success).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
bun test plugins/registry.test.ts
```

预期：FAIL，`Cannot find module './registry.js'`。

- [ ] **Step 3: 写类型**

创建 `plugins/types.ts`：

```ts
/**
 * 一个插件对内核声明的东西。纯数据，没有行为——行为在 handlers.ts 那张表里，
 * 分开是因为这份清单要被浏览器 import。
 */
export type Plugin = {
  /** 同时决定 /api/<id>/*、/p/<id>/*、以及状态目录名。^[a-z][a-z0-9-]*$ */
  id: string;
  /** 顶栏 title/aria-label 用的 i18n 键。 */
  titleKey: string;
  /** 24×24 viewBox 里的 path 串，格式跟 nav.js 现有图标一致。 */
  icon: string;
  i18n: { zh: Record<string, string>; en: Record<string, string> };
};

/**
 * 插件的服务端入口。只在路径命中 /api/<id> 或 /api/<id>/* 时被调用，
 * 前缀由内核校验。返回 null 表示"这个子路径我不认"，内核继续往下走到 404。
 */
export type PluginHandler = (req: Request, url: URL) => Promise<Response | null>;
```

- [ ] **Step 4: 写制品库清单**

创建 `plugins/gallery/plugin.js`。图标从 `public/nav.js` 的 `ICONS.gallery` 原样搬来；文案从 `public/i18n.js` 里那 17 个 `gallery.*` 键原样搬来（两本都搬，一字不改）：

```js
// @ts-check
/**
 * 制品库的清单。纯数据——服务端在 plugins/gallery/server.ts。
 *
 * 浏览器会 import 这个文件（i18n.js 和 nav.js 都要），所以这里不能引任何 .ts。
 */

/** @type {import("../types").Plugin} */
export default {
  id: "gallery",
  titleKey: "gallery.title",
  icon:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>' +
    '<rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  i18n: {
    zh: {
      "gallery.title": "制品",
      "gallery.loadFailed": "加载失败",
      "gallery.count": "{n} 项",
      "gallery.empty": "还没有制品",
      "gallery.emptyHint": "把图片 / HTML / SVG 放进",
      "gallery.prev": "上一个",
      "gallery.next": "下一个",
      "gallery.close": "‹ 关闭",
      "gallery.download": "下载",
      "gallery.noPreview": "这个类型不支持预览，点右上「下载」查看。",
      "gallery.file": "文件",
      "gallery.upload": "上传",
      "gallery.uploading": "正在上传 {n} 个文件…",
      "gallery.uploaded": "已上传 {n} 个文件",
      "gallery.uploadPartial": "已上传 {n} 个，部分失败",
      "gallery.uploadTooBig": "文件太大，单个不能超过 {mb}MB",
      "gallery.uploadFailed": "上传失败",
    },
    en: {
      "gallery.title": "Artifacts",
      "gallery.loadFailed": "Could not load",
      "gallery.count": "{n}",
      "gallery.empty": "No artifacts yet",
      "gallery.emptyHint": "Drop images / HTML / SVG into",
      "gallery.prev": "Previous",
      "gallery.next": "Next",
      "gallery.close": "‹ Close",
      "gallery.download": "Download",
      "gallery.noPreview": "This type cannot be previewed — use Download at the top right.",
      "gallery.file": "file",
      "gallery.upload": "Upload",
      "gallery.uploading": "Uploading {n} files…",
      "gallery.uploaded": "Uploaded {n} files",
      "gallery.uploadPartial": "Uploaded {n}, some failed",
      "gallery.uploadTooBig": "File too large — max {mb}MB each",
      "gallery.uploadFailed": "Upload failed",
    },
  },
};
```

**核对**：搬完后 `public/i18n.js` 里 `gallery.` 开头的键必须一个不剩，且这里 zh/en 各 17 个。用 `grep -c '"gallery\.' public/i18n.js` 确认是 0。

- [ ] **Step 5: 写注册表**

创建 `plugins/registry.js`：

```js
// @ts-check
/**
 * 内置插件，写死的一张表。
 *
 * 不扫目录、不做运行时加载：这是个无认证的 loopback 服务，动态 import 等于在
 * 里面跑任意第三方代码。加插件 = 加目录 + 在这里加一行。
 *
 * 同构：服务端和浏览器都 import 它，所以这里只能有清单，不能引任何 .ts。
 * 服务端那半在 plugins/handlers.ts。
 */

import gallery from "./gallery/plugin.js";

/** @type {import("./types").Plugin[]} */
export const PLUGINS = [gallery];
```

- [ ] **Step 6: 跑测试确认通过**

```bash
bun test plugins/registry.test.ts
```

预期：6 个测试全 PASS。

- [ ] **Step 7: 把插件字典合进 i18n**

`public/i18n.js`：删掉那 17 个 `gallery.*` 键（zh 和 en 两处），文件顶部加 import，并在 `export const DICTS = { zh, en };` **之前**加合并循环：

```js
import { PLUGINS } from "../plugins/registry.js";
```

```js
// 插件的文案。合并的是**全部**插件，不按启用过滤——禁用一个插件不该让它的
// 文案在 i18n.test.ts 里变成"缺失键"，那个测试的价值恰恰在于它是全量的。
for (const p of PLUGINS) {
  Object.assign(zh, p.i18n.zh);
  Object.assign(en, p.i18n.en);
}

export const DICTS = { zh, en };
```

- [ ] **Step 8: 让浏览器取得到这两个文件**

`src/server.ts`：在静态资源那段（`const name = url.pathname === "/" ? ...` 那几行）**之前**插入：

```ts
      // 同构清单：i18n.js 和 nav.js 都要 import 它，而静态资源只从 public/ 出。
      // 只放这两种精确形状，不是把 plugins/ 整个目录挂出去。
      // 不按启用过滤：字典是全量合并的，禁用的插件也得取得到清单。
      if (url.pathname === "/plugins/registry.js") {
        return new Response(Bun.file(PLUGINS_DIR + "registry.js"), {
          headers: { "content-type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" },
        });
      }
      const manifest = url.pathname.match(/^\/plugins\/([a-z][a-z0-9-]*)\/plugin\.js$/);
      if (manifest) {
        const file = Bun.file(`${PLUGINS_DIR}${manifest[1]}/plugin.js`);
        if (await file.exists()) {
          return new Response(file, {
            headers: {
              "content-type": "text/javascript; charset=utf-8",
              "Cache-Control": "no-cache",
            },
          });
        }
      }
```

并在 `const PUBLIC_DIR = ...` 旁边加：

```ts
const PLUGINS_DIR = new URL("../plugins/", import.meta.url).pathname;
```

- [ ] **Step 9: 加服务端测试**

在 `src/server.test.ts` 末尾追加：

```ts
test("插件清单能被浏览器取到，别的 plugins 路径取不到", async () => {
  const base = `http://127.0.0.1:${server.port}`;
  for (const path of ["/plugins/registry.js", "/plugins/gallery/plugin.js"]) {
    const res = await fetch(base + path);
    expect({ path, status: res.status }).toEqual({ path, status: 200 });
    expect(res.headers.get("content-type")).toContain("javascript");
  }
  // 只开这两种形状，不是把目录挂出去。
  for (const path of ["/plugins/handlers.ts", "/plugins/gallery/server.ts", "/plugins/"]) {
    const res = await fetch(base + path);
    expect({ path, status: res.status }).toEqual({ path, status: 404 });
  }
});
```

- [ ] **Step 10: 把 plugins 纳入 typecheck 和发布包**

`tsconfig.json`：

```json
  "include": ["src/**/*.ts", "public/**/*.js", "plugins/**/*.ts", "plugins/**/*.js"]
```

`package.json` 的 `files`，在 `"extensions"` 后面加 `"plugins"`：

```json
  "files": ["src", "public", "plugins", "hooks", "extensions", "README.md", "LICENSE", "SECURITY.md", "!**/*.test.ts", "!**/*.integration.test.ts"]
```

漏了前者插件代码不过 typecheck，漏了后者发到 npm 的包里没有插件目录，装完是个空壳。

- [ ] **Step 11: 跑全量**

```bash
bun run test
```

预期：全绿。特别确认 `src/i18n.test.ts` 的四个断言仍过——`gallery.*` 从主字典搬走后，经合并循环仍应在 `DICTS` 里，且 `gallery.html`/`gallery.js` 里对它们的引用仍算"已使用"。

- [ ] **Step 12: 提交**

```bash
git add plugins/types.ts plugins/registry.js plugins/gallery/plugin.js plugins/registry.test.ts \
        public/i18n.js src/server.ts src/server.test.ts tsconfig.json package.json
git commit -m "feat: 插件注册表与类型，制品库的清单和文案搬进插件目录"
```

---

### Task 3: 服务端搬家——状态目录、handler 表、前缀分发

**Files:**
- Create: `plugins/state.ts`
- Create: `plugins/handlers.ts`
- Create: `plugins/gallery/server.ts`
- Create: `src/plugin-routing.test.ts`
- Move: `src/gallery.ts` → `plugins/gallery/gallery.ts`
- Move: `src/gallery.test.ts` → `plugins/gallery/gallery.test.ts`
- Modify: `src/server.ts`（删三段 gallery 路由，加分发循环与 `/api/plugins`）

**Interfaces:**
- Consumes: `PLUGINS`（Task 2）、`Plugin` / `PluginHandler`（Task 2）
- Produces: `pluginStateDir(id: string): string`
- Produces: `enabledPlugins(): Plugin[]`
- Produces: `HANDLERS: Record<string, PluginHandler>`
- Produces: `plugins/gallery/server.ts` 的 `handle: PluginHandler`

- [ ] **Step 1: 写失败的测试**

创建 `src/plugin-routing.test.ts`。它自己起一个 server，不蹭 `server.test.ts` 的：

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TMUX_NEXT_GALLERY_DIR = join(
  tmpdir(),
  `plugroute-test-${Math.random().toString(36).slice(2, 10)}`,
);

import { mkdirSync, writeFileSync } from "node:fs";
import { startServer } from "./server";
import { pluginStateDir } from "../plugins/state";
import { enabledPlugins } from "../plugins/handlers";

let server: { stop(): void; port: number };
const base = () => `http://127.0.0.1:${server.port}`;

beforeAll(() => {
  mkdirSync(process.env.TMUX_NEXT_GALLERY_DIR!, { recursive: true });
  writeFileSync(join(process.env.TMUX_NEXT_GALLERY_DIR!, "a.png"), "png");
  server = startServer(0);
});
afterAll(() => server.stop());

test("/api/plugins 报出启用的插件", async () => {
  const ids = (await (await fetch(`${base()}/api/plugins`)).json()) as string[];
  expect(ids).toContain("gallery");
});

test("插件的路由挂在自己的前缀下", async () => {
  const res = await fetch(`${base()}/api/gallery`);
  expect(res.status).toBe(200);
  const items = (await res.json()) as { name: string }[];
  expect(items.map((i) => i.name)).toContain("a.png");
});

test("插件不认的子路径落到 404，而不是被它吞掉", async () => {
  const res = await fetch(`${base()}/api/gallery/nonesuch`);
  expect(res.status).toBe(404);
});

test("状态目录可以用 env 顶掉，且惰性读取", () => {
  // 惰性：这个 env 是在文件顶部、import 之前设的，模块加载时若捕获了值，
  // 下面这两行就会读到 home 底下的真实目录——正是 CLAUDE.md 里那条规矩。
  expect(pluginStateDir("gallery")).toBe(process.env.TMUX_NEXT_GALLERY_DIR!);
  process.env.TMUX_NEXT_DEMO_DIR = "/tmp/demo-state";
  expect(pluginStateDir("demo")).toBe("/tmp/demo-state");
  delete process.env.TMUX_NEXT_DEMO_DIR;
});

test("带连字符的 id 映射成带下划线的 env 名", () => {
  process.env.TMUX_NEXT_TWO_WORDS_DIR = "/tmp/two-words";
  expect(pluginStateDir("two-words")).toBe("/tmp/two-words");
  delete process.env.TMUX_NEXT_TWO_WORDS_DIR;
});

test("禁用一个插件，它的 API 就不在了", () => {
  const before = enabledPlugins().map((p) => p.id);
  expect(before).toContain("gallery");
  process.env.TMUX_NEXT_DISABLE_PLUGINS = "gallery";
  try {
    expect(enabledPlugins().map((p) => p.id)).not.toContain("gallery");
  } finally {
    delete process.env.TMUX_NEXT_DISABLE_PLUGINS;
  }
  // env 清掉就回来——说明它是每次调用现读的，不是加载时定死的。
  expect(enabledPlugins().map((p) => p.id)).toContain("gallery");
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
bun test src/plugin-routing.test.ts
```

预期：FAIL，`Cannot find module '../plugins/state'`。

- [ ] **Step 3: 写状态目录**

创建 `plugins/state.ts`：

```ts
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 一个插件的磁盘状态放哪。
 *
 * 路径在函数里现读，不在模块加载时捕获——测试要能先设 env 再调用，这是仓库
 * 里每条状态路径都守的规矩。
 *
 * 制品库正好落在 TMUX_NEXT_GALLERY_DIR 和 ~/.tmux-next/gallery 上，跟搬家前
 * 一模一样：零迁移，tmux-next-gallery 那个 skill 一个字都不用改。
 */
export function pluginStateDir(id: string): string {
  const env = `TMUX_NEXT_${id.toUpperCase().replace(/-/g, "_")}_DIR`;
  return process.env[env] || join(homedir(), ".tmux-next", id);
}
```

- [ ] **Step 4: 搬制品库存储**

```bash
git mv src/gallery.ts plugins/gallery/gallery.ts
git mv src/gallery.test.ts plugins/gallery/gallery.test.ts
```

`plugins/gallery/gallery.ts` 里把 `galleryDir()` 换成走共用助手，其余一字不动：

```ts
import { pluginStateDir } from "../state";

export function galleryDir(): string {
  return pluginStateDir("gallery");
}
```

删掉它原来的 `homedir` / `join` import 中已不再使用的部分（`join` 还在别处用，`homedir` 大概率可以删——以 `tsc --noEmit` 的报错为准）。

`plugins/gallery/gallery.test.ts` 里的 import 路径 `./gallery` 不变（同目录），确认无误即可。

- [ ] **Step 5: 写插件的服务端入口**

创建 `plugins/gallery/server.ts`，内容是从 `src/server.ts` 原样搬来的三段路由，一行逻辑都不改：

```ts
import {
  listGallery,
  galleryFilePath,
  saveGalleryUpload,
  MAX_GALLERY_UPLOAD_BYTES,
} from "./gallery";

/**
 * 放文件的那个抽屉：里面有什么，以及一个个把文件取出来。名字被收窄成制品库内
 * 的 basename，所以它永远够不到磁盘上别的地方。content-type 由 Bun.file 按扩展
 * 名给，这才让客户端能直接渲染图片和 HTML。
 */
export async function handle(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/gallery" && req.method === "GET") {
    return Response.json(await listGallery());
  }
  if (url.pathname === "/api/gallery/file" && req.method === "GET") {
    const path = galleryFilePath(url.searchParams.get("name") ?? "");
    if (!path) return new Response("bad name", { status: 400 });
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file);
  }
  if (url.pathname === "/api/gallery/file" && req.method === "POST") {
    // 先按声明的长度拒掉，超大的 body 根本到不了 formData()；解析后那道检查仍然守着。
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_GALLERY_UPLOAD_BYTES) {
      return new Response("too big", { status: 413 });
    }
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return new Response("bad form", { status: 400 });
    }
    const file = form.get("file");
    if (!(file instanceof File)) return new Response("missing file", { status: 400 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength === 0) return new Response("empty", { status: 400 });
    if (bytes.byteLength > MAX_GALLERY_UPLOAD_BYTES) {
      return new Response("too big", { status: 413 });
    }
    const name = await saveGalleryUpload(file.name, bytes);
    if (!name) return new Response("bad name", { status: 400 });
    return Response.json({ name });
  }
  return null;
}
```

- [ ] **Step 6: 写 handler 表**

创建 `plugins/handlers.ts`：

```ts
import { PLUGINS } from "./registry.js";
import type { Plugin, PluginHandler } from "./types";
import { handle as gallery } from "./gallery/server";

/**
 * 插件的服务端那一半。
 *
 * 跟 registry.js 分开，是因为那张表要被浏览器 import：清单里只要引到一个 .ts，
 * 服务端代码就被打进浏览器包。plugins/registry.test.ts 有一条断言专守这个。
 */
export const HANDLERS: Record<string, PluginHandler> = { gallery };

/**
 * 启用的插件。env 在这里现读——读 env 是服务端的事，放进同构的 registry.js 等于
 * 埋一个只在浏览器炸的调用。前端要知道启用了什么，走 GET /api/plugins。
 */
export function enabledPlugins(): Plugin[] {
  const off = new Set(
    (process.env.TMUX_NEXT_DISABLE_PLUGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return PLUGINS.filter((p) => !off.has(p.id));
}
```

- [ ] **Step 7: 内核换成分发**

`src/server.ts`：

1. 删掉 `import { listGallery, galleryFilePath, saveGalleryUpload, MAX_GALLERY_UPLOAD_BYTES } from "./gallery";`，加：

```ts
import { HANDLERS, enabledPlugins } from "../plugins/handlers";
```

2. 删掉那三段 gallery 路由（连同它们上方那段注释——注释跟着代码走进了 `plugins/gallery/server.ts`）。

3. 在核心路由都判完之后、`/node_modules/` 那段之前，插入：

```ts
      // 前端要知道启用了哪些插件才能画顶栏。必须在插件分发**之前**判，
      // 否则一个叫 plugins 的插件能把它盖掉（registry.test.ts 禁掉了这个 id）。
      if (url.pathname === "/api/plugins" && req.method === "GET") {
        return Response.json(enabledPlugins().map((p) => p.id));
      }

      // 插件的 API，各自挂在自己的前缀下。前缀由这里校验，插件只管自己认的
      // 子路径；返回 null 就继续往下走到 404，而不是被它吞掉。
      for (const p of enabledPlugins()) {
        if (url.pathname === `/api/${p.id}` || url.pathname.startsWith(`/api/${p.id}/`)) {
          const res = await HANDLERS[p.id]?.(req, url);
          if (res) return res;
        }
      }
```

- [ ] **Step 8: 跑测试**

```bash
bun test src/plugin-routing.test.ts plugins/gallery/gallery.test.ts
```

预期：全 PASS。

- [ ] **Step 9: 跑全量——真正的证据在这里**

```bash
bun run test
```

`src/server.test.ts` 里那 8 个 gallery 测试（第 334–430 行一带）**一个字都没改**，URL 也没变。它们全绿，就是"搬家没改行为"的证明。任何一个红了都说明搬漏了东西，不要改测试去迁就。

- [ ] **Step 10: 提交**

```bash
git add -A plugins src/server.ts src/plugin-routing.test.ts
git commit -m "refactor: 制品库的服务端搬进插件，内核改走前缀分发"
```

---

### Task 4: 页面搬家——`/p/<id>/*` 映射、旧地址 301、扫描测试跟上

**Files:**
- Create: `plugins/gallery/public/index.html`（由 `public/gallery.html` 搬来）
- Create: `plugins/gallery/public/gallery.js`（由 `public/gallery.js` 搬来）
- Delete: `public/gallery.html`、`public/gallery.js`
- Modify: `src/server.ts`（`/p/<id>/*` 静态映射、`/gallery.html` 301）
- Modify: `src/public-parses.test.ts`、`src/i18n.test.ts`（扫描目录扩到插件）
- Modify: `src/plugin-routing.test.ts`（加页面断言）

**Interfaces:**
- Consumes: `enabledPlugins()`（Task 3）、`url()`（Task 1）

- [ ] **Step 1: 先扩扫描测试——不然搬走的一刻覆盖就断了**

`src/public-parses.test.ts`：把取文件的那两行换成同时收插件的 public：

```ts
import { readdirSync, existsSync } from "node:fs";

const dir = new URL("../public/", import.meta.url).pathname;
const pluginsDir = new URL("../plugins/", import.meta.url).pathname;

/**
 * public/ 和每个插件的 public/。插件页面同样只有浏览器加载，语法错误同样会
 * 静悄悄发布——这个文件存在的理由一字不差地适用于它们。
 */
const modules = [
  ...readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => dir + f),
  ...readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const pub = `${pluginsDir}${d.name}/public/`;
      if (!existsSync(pub)) return [];
      return readdirSync(pub).filter((f) => f.endsWith(".js")).map((f) => pub + f);
    }),
  ...readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(`${pluginsDir}${d.name}/plugin.js`))
    .map((d) => `${pluginsDir}${d.name}/plugin.js`),
];
```

两处 `test.each(modules)` 的标题里 `%s` 现在是全路径，可读性还行；`Bun.build({ entrypoints: [dir + file] })` 要改成 `entrypoints: [file]`（`modules` 已是全路径）。

`src/i18n.test.ts` 的 `usedKeys()` 里那个 `files` 数组，追加插件的 public 和清单：

```ts
  const pluginsDir = new URL("../plugins/", import.meta.url).pathname;
  const pluginFiles = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const out = [`${pluginsDir}${d.name}/plugin.js`];
      const pub = `${pluginsDir}${d.name}/public/`;
      if (existsSync(pub)) {
        out.push(...readdirSync(pub).filter((f) => /\.(js|html)$/.test(f)).map((f) => pub + f));
      }
      return out.filter((f) => existsSync(f));
    });
```

把 `pluginFiles` 并进 `files`。顶部 import 加 `existsSync`。

**注意**：清单文件里的键是以 `"gallery.title": "制品"` 这种**定义**形式出现的，不是 `t("…")` 调用，所以扫描器不会把它们算成"已使用"——`titleKey: "gallery.title"` 也不匹配任何模式。这是对的：`gallery.title` 的真正使用点在 `nav.js`（Task 5 会让它从清单取），在那之前由 `plugins/gallery/public/index.html` 的 `data-i18n="gallery.title"` 撑着。跑完这一步确认"no dictionary entry is unreferenced"仍绿；若红了，红的是哪个键就去看它的使用点是不是随搬家丢了。

- [ ] **Step 2: 跑一次，确认扩完仍绿**

```bash
bun test src/public-parses.test.ts src/i18n.test.ts
```

预期：PASS（此刻插件还没有 public 目录，新增的扫描是空集）。

- [ ] **Step 3: 写页面路由的失败测试**

`src/plugin-routing.test.ts` 追加：

```ts
test("插件页面从 /p/<id>/ 出", async () => {
  const res = await fetch(`${base()}/p/gallery/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("html");
  expect(await res.text()).toContain('data-i18n="gallery.title"');
});

test("插件页面的脚本也出得来", async () => {
  const res = await fetch(`${base()}/p/gallery/gallery.js`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("javascript");
});

test("爬不出插件的 public 目录", async () => {
  // 浏览器会先把 ../ 规范化掉，但裸客户端不会——服务端自己得拒。
  for (const evil of [
    "/p/gallery/../../src/server.ts",
    "/p/gallery/..%2F..%2Fsrc%2Fserver.ts",
    "/p/gallery/.env",
  ]) {
    const res = await fetch(base() + evil);
    expect({ evil, ok: res.status === 200 }).toEqual({ evil, ok: false });
  }
});

test("不存在的插件 id 是 404", async () => {
  expect((await fetch(`${base()}/p/nosuch/`)).status).toBe(404);
});

test("旧地址 301 到新地址", async () => {
  const res = await fetch(`${base()}/gallery.html`, { redirect: "manual" });
  expect(res.status).toBe(301);
  expect(res.headers.get("location")).toBe("p/gallery/");
});
```

- [ ] **Step 4: 跑测试确认失败**

```bash
bun test src/plugin-routing.test.ts
```

预期：新加的 5 个 FAIL（404 / 没有重定向）。

- [ ] **Step 5: 搬页面**

```bash
mkdir -p plugins/gallery/public
git mv public/gallery.html plugins/gallery/public/index.html
git mv public/gallery.js plugins/gallery/public/gallery.js
```

`plugins/gallery/public/index.html` 里改三处相对路径（`<head>` 里的图标、manifest、样式表，以及底部的脚本标签）：

```html
  <link rel="icon" href="../../favicon.svg" type="image/svg+xml">
  <link rel="manifest" href="../../manifest.webmanifest" crossorigin="use-credentials">
  <link rel="apple-touch-icon" href="../../icon-192.png">
  <link rel="stylesheet" href="../../style.css">
```

脚本标签留在原地不用改（`src="gallery.js"` 就在同目录）。

`plugins/gallery/public/gallery.js` 改 import 和三处 URL：

```js
import { initLang, tr } from "../../i18n-apply.js";
import { renderHeader } from "../../nav.js";
import { url } from "../../root.js";
```

- 第 82 行：`fetch("api/gallery/file", …)` → `fetch(url("api/gallery/file"), …)`
- 第 111 行：`fetch("api/gallery")` → `fetch(url("api/gallery"))`
- `fileUrl()` 里拼 `api/gallery/file?name=…` 的地方，同样包一层 `url(…)`

**为什么不用绝对路径**：`/api/gallery` 在反代子路径（`https://host/tmux/`）下直接 404。`../../` 由浏览器规范化到根，`url()` 从模块自己的 URL 推根，两者都跟着前缀走。

- [ ] **Step 6: 加静态映射和 301**

`src/server.ts`，在 Task 2 加的 `/plugins/…` 两条之后、通用静态资源之前：

```ts
      // 插件页面。/p/<id>/ 而不是 /<id>/：一级路径迟早跟 public/ 里的文件或
      // 未来的 API 撞名。禁用的插件，页面跟着 API 一起消失。
      const page = url.pathname.match(/^\/p\/([a-z][a-z0-9-]*)\/(.*)$/);
      if (page) {
        const [, id, rest] = page;
        if (!enabledPlugins().some((p) => p.id === id)) {
          return new Response("not found", { status: 404 });
        }
        const file = rest === "" ? "index.html" : rest!;
        // 跟制品库文件名同一套收窄：插件目录同样不能被 ../ 爬出去。浏览器会先
        // 规范化，裸客户端不会。
        if (
          file.includes("/") ||
          file.includes("\\") ||
          file.includes("\0") ||
          file.startsWith(".")
        ) {
          return new Response("bad name", { status: 400 });
        }
        const asset = Bun.file(`${PLUGINS_DIR}${id}/public/${file}`);
        if (await asset.exists()) {
          return new Response(asset, { headers: { "Cache-Control": "no-cache" } });
        }
        return new Response("not found", { status: 404 });
      }

      // 搬家前的地址。手机上存了书签、装了 PWA 的人不该撞 404。
      // 相对的 location，子路径部署下同样成立。
      if (url.pathname === "/gallery.html") {
        return new Response(null, { status: 301, headers: { Location: "p/gallery/" } });
      }
```

**注意**：`..%2F..%2F` 这种编码形式，`url.pathname` 里是解码后的 `/`，会被 `file.includes("/")` 拦下——测试里那条断言守的就是它。

- [ ] **Step 7: 跑测试确认通过**

```bash
bun test src/plugin-routing.test.ts
```

预期：全 PASS。

- [ ] **Step 8: 跑全量**

```bash
bun run test
```

预期：全绿。`public-parses.test.ts` 现在应该在检 `plugins/gallery/public/gallery.js`——跑的时候看一眼测试名里有没有它，没有就说明 Step 1 的扫描没生效。

- [ ] **Step 9: 手动看一眼**

```bash
bun run src/index.ts --port 7999
```

浏览器开 `http://127.0.0.1:7999/p/gallery/`：图片能看、上传能用、语言切换能用。再开 `http://127.0.0.1:7999/gallery.html`，应当跳到新地址。看完 Ctrl-C。

（顶栏上此刻还是老的写死 tab，指向 `gallery.html` 然后被 301 弹过来——下一个任务才换掉。）

- [ ] **Step 10: 提交**

```bash
git add -A plugins public src/server.ts src/plugin-routing.test.ts src/public-parses.test.ts src/i18n.test.ts
git commit -m "feat: 制品库页面搬到 /p/gallery/，旧地址 301"
```

---

### Task 5: 顶栏从注册表生成

**Files:**
- Modify: `public/nav.js`
- Create: `src/nav-tabs.test.ts`

**Interfaces:**
- Consumes: `PLUGINS`（Task 2）、`url()`（Task 1）、`GET /api/plugins`（Task 3）

- [ ] **Step 1: 写失败的测试**

创建 `src/nav-tabs.test.ts`。仿 `src/list-page.test.ts` 的 happy-dom 路子：

```ts
import { test, expect, afterEach } from "bun:test";
import { Window } from "happy-dom";

/**
 * 顶栏是插件唯一的入口。它从注册表生成，而 nav.js 不在 checkJs 里——
 * 一个拼错的字段名在这里的表现是"tab 静静地少一个"，别的测试全都照绿。
 *
 * 另一半是回退：启用列表要现问服务端，而默认是全开，所以问不到的时候必须
 * 当全开处理。反过来做，服务暂时不可达就等于把功能藏了。
 */

const NAV = new URL("../public/nav.js", import.meta.url).pathname;

const saved = { fetch: globalThis.fetch };
afterEach(() => {
  // 覆盖全局却不还原，曾经一次弄红了别的文件里 38 个测试——Bun 一个进程跑全部。
  globalThis.fetch = saved.fetch;
});

async function mount(/** 让 /api/plugins 返回什么，null = 让它失败 */ ids: string[] | null) {
  const window = new Window({ url: "http://localhost/" });
  const doc = window.document;
  doc.body.innerHTML = '<header id="header"></header>';
  // @ts-expect-error happy-dom 的 window 不是 lib.dom 的那个
  globalThis.window = window;
  globalThis.document = doc as unknown as Document;
  globalThis.fetch = (async (input: string) => {
    const href = String(input);
    if (href.endsWith("/api/plugins")) {
      if (ids === null) throw new Error("offline");
      return new Response(JSON.stringify(ids));
    }
    if (href.endsWith("/api/language")) return new Response(JSON.stringify({ lang: "en" }));
    return new Response("{}");
  }) as typeof fetch;

  const { renderNav } = await import(NAV + `?t=${Math.random()}`);
  await renderNav(doc.getElementById("header"), "sessions");
  return doc;
}

test("顶栏画出会话页加每个启用的插件", async () => {
  const doc = await mount(["gallery"]);
  const items = [...doc.querySelectorAll(".hseg-item")];
  expect(items.length).toBe(2);
  // 会话页在最左，插件按注册表顺序跟在后面。
  expect(items[1]!.getAttribute("href")).toBe("p/gallery/");
  expect(items[1]!.getAttribute("aria-label")).toBe("Artifacts");
});

test("被禁用的插件不出现在顶栏", async () => {
  const doc = await mount([]);
  expect([...doc.querySelectorAll(".hseg-item")].length).toBe(1);
});

test("问不到启用列表就当全开——离线不该把功能藏起来", async () => {
  const doc = await mount(null);
  const hrefs = [...doc.querySelectorAll(".hseg-item")].map((n) => n.getAttribute("href"));
  expect(hrefs).toContain("p/gallery/");
});

test("当前页是 span 不是链接，且带上计数元素", async () => {
  const doc = await mount(["gallery"]);
  const active = doc.querySelector(".hseg-item.on")!;
  expect(active.tagName).toBe("SPAN");
  expect(active.getAttribute("aria-current")).toBe("page");
  expect(doc.getElementById("count")).not.toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
bun test src/nav-tabs.test.ts
```

预期：FAIL——现在的 `renderNav` 是同步的、tab 写死，href 是 `gallery.html`。

- [ ] **Step 3: 改 `nav.js`**

顶部加 import：

```js
import { PLUGINS } from "../plugins/registry.js";
import { url } from "./root.js";
```

`ICONS` 里删掉 `gallery` 和 `notifications` 两项（它们现在归各自的清单）。**保留** `bell`、`gear`、`sessions`——那三个是内核的。

`TABS` 那张写死的数组删掉，换成：

```js
/**
 * 启用的插件 id。服务端才读得到 TMUX_NEXT_DISABLE_PLUGINS，所以问它一次。
 *
 * 问不到就当全开：默认就是全开，而"服务暂时答不上来"跟"用户关掉了它"是两回
 * 事，把后者的表现给前者，等于离线时功能凭空消失。
 */
async function enabledIds() {
  try {
    const res = await fetch(url("api/plugins"));
    if (!res.ok) throw new Error(String(res.status));
    const ids = await res.json();
    if (Array.isArray(ids)) return ids;
  } catch {
    // 落到下面的默认
  }
  return PLUGINS.map((p) => p.id);
}
```

`renderNav` 改成 `async`，开头取 tab：

```js
export async function renderNav(header, current) {
  const on = new Set(await enabledIds());
  const tabs = [
    { page: "sessions", href: url("./"), key: "list.title", icon: ICONS.sessions },
    ...PLUGINS.filter((p) => on.has(p.id)).map((p) => ({
      page: p.id,
      href: url(`p/${p.id}/`),
      key: p.titleKey,
      icon: p.icon,
    })),
  ];
```

循环体里 `svg(ICONS[tab.page])` 改成 `svg(tab.icon)`，其余（active 判断、`aria-current`、`title`/`aria-label`、计数元素）一字不动。

`renderHeader` 里 `renderNav(header, current)` 前面加 `await`。同一文件第 163 行 `location.href = "new.html"` 改成 `location.href = url("new.html")`——插件页面上那个按钮也得能用。

`@typedef {"sessions" | "gallery" | "notifications"} Page` 改成 `@typedef {string} Page`，并把注释改成说明它是 `"sessions"` 或某个插件 id。

- [ ] **Step 4: 跑测试确认通过**

```bash
bun test src/nav-tabs.test.ts
```

预期：4 个全 PASS。

- [ ] **Step 5: 跑全量**

```bash
bun run test
```

`i18n.test.ts` 的"no dictionary entry is unreferenced"这次要特别看：`gallery.title` 现在的使用点是清单里的 `titleKey`，不是 `t()` 调用。若它报成 dead key，在 `usedKeys()` 里加一条模式：

```ts
      // 插件清单：titleKey: "gallery.title"
      /\btitleKey:\s*"([A-Za-z0-9_.]+)"/g,
```

- [ ] **Step 6: 手动看一眼**

```bash
bun run src/index.ts --port 7999
```

三个页面（`/`、`/p/gallery/`、`/notifications.html`）的顶栏都应有会话页和制品两个段，点着能来回走。再试：

```bash
TMUX_NEXT_DISABLE_PLUGINS=gallery bun run src/index.ts --port 7999
```

顶栏只剩会话页，`/p/gallery/` 是 404，`/api/gallery` 是 404。看完 Ctrl-C。

- [ ] **Step 7: 提交**

```bash
git add public/nav.js src/nav-tabs.test.ts src/i18n.test.ts
git commit -m "feat: 顶栏从插件注册表生成，禁用的插件不再出现"
```

---

### Task 6: 通知页搬家

第二个插件——接口是不是只围着制品库一个例子拟的，这一步说了算。通知页形态不同：没有上传，且它读的那份日志是**内核写的**。

**Files:**
- Create: `plugins/notifications/plugin.js`
- Create: `plugins/notifications/server.ts`
- Create: `plugins/notifications/public/index.html`（由 `public/notifications.html` 搬来）
- Create: `plugins/notifications/public/notifications.js`（由 `public/notifications.js` 搬来）
- Delete: `public/notifications.html`、`public/notifications.js`
- Modify: `plugins/registry.js`、`plugins/handlers.ts`
- Modify: `public/i18n.js`（删 `notif.*` 键）
- Modify: `src/server.ts`（删 `/api/notifications` 路由，加 301）
- Modify: `src/plugin-routing.test.ts`

**Interfaces:**
- Consumes: 全部来自 Task 2/3/4 的接口
- Note: `src/notifications.ts` **留在内核**，不搬

- [ ] **Step 1: 写失败的测试**

`src/plugin-routing.test.ts` 追加：

```ts
test("通知页也是个插件：API、页面、顶栏三处都在", async () => {
  const ids = (await (await fetch(`${base()}/api/plugins`)).json()) as string[];
  expect(ids).toContain("notifications");
  expect((await fetch(`${base()}/api/notifications`)).status).toBe(200);
  expect((await fetch(`${base()}/p/notifications/`)).status).toBe(200);
  const old = await fetch(`${base()}/notifications.html`, { redirect: "manual" });
  expect(old.status).toBe(301);
  expect(old.headers.get("location")).toBe("p/notifications/");
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
bun test src/plugin-routing.test.ts
```

- [ ] **Step 3: 写清单**

创建 `plugins/notifications/plugin.js`。图标从 `public/nav.js` 的 `ICONS.notifications` 原样搬（就是那两条 `path`），文案从 `public/i18n.js` 把所有 `notif.*` 键搬来（两本都搬，一字不改，搬完 `grep -c '"notif\.' public/i18n.js` 应为 0）：

```js
// @ts-check
/**
 * 通知历史的清单。
 *
 * 注意这个插件**不拥有**那份日志：~/.tmux-next/notifications.jsonl 是推送管线
 * （/api/notify → src/push.ts）写的，插件只读。所以 src/notifications.ts 留在
 * 内核——否则内核要反向依赖插件才能记一条日志，接缝就白划了。
 *
 * 结果是：这个插件被禁用时推送照常工作，只是网页上翻不到历史。
 */

/** @type {import("../types").Plugin} */
export default {
  id: "notifications",
  titleKey: "notif.title",
  icon:
    '<path d="M22 12h-6l-2 3h-4l-2-3H2"/>' +
    '<path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  i18n: {
    zh: { /* public/i18n.js 里所有 notif.* 键的中文，原样搬来 */ },
    en: { /* 同上，英文 */ },
  },
};
```

- [ ] **Step 4: 写服务端**

创建 `plugins/notifications/server.ts`，把 `src/server.ts` 里那段路由原样搬来：

```ts
import { readNotifications } from "../../src/notifications";

/**
 * 发出去的通知留一份日志，手机上划掉的那条还能在网页里翻到。
 *
 * 日志由推送管线写（src/push.ts），这里只读——所以那个模块留在 src/，不搬进来。
 */
export async function handle(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/notifications" && req.method === "GET") {
    return Response.json({ notifications: await readNotifications() });
  }
  return null;
}
```

- [ ] **Step 5: 挂进两张表**

`plugins/registry.js`：

```js
import gallery from "./gallery/plugin.js";
import notifications from "./notifications/plugin.js";

/** @type {import("./types").Plugin[]} */
export const PLUGINS = [gallery, notifications];
```

`plugins/handlers.ts`：

```ts
import { handle as gallery } from "./gallery/server";
import { handle as notifications } from "./notifications/server";

export const HANDLERS: Record<string, PluginHandler> = { gallery, notifications };
```

- [ ] **Step 6: 搬页面**

```bash
mkdir -p plugins/notifications/public
git mv public/notifications.html plugins/notifications/public/index.html
git mv public/notifications.js plugins/notifications/public/notifications.js
```

`index.html` 里 `favicon.svg` / `manifest.webmanifest` / `icon-192.png` / `style.css` 四处加 `../../` 前缀，脚本标签不动。

`notifications.js`：

```js
import { initLang, tr } from "../../i18n-apply.js";
import { renderHeader } from "../../nav.js";
import { url } from "../../root.js";
```

- 第 38 行：`fetch("api/notifications")` → `fetch(url("api/notifications"))`
- 第 54 行：``link.href = `terminal.html?target=${encodeURIComponent(n.session)}` `` → `link.href = url(\`terminal.html?target=${encodeURIComponent(n.session)}\`)`

第二处尤其要改：从 `/p/notifications/` 出发，原来的相对链接会指到 `/p/notifications/terminal.html`，点通知跳终端会 404——而这正是这个页面存在的意义。

- [ ] **Step 7: 内核删路由、加 301**

`src/server.ts`：删掉 `/api/notifications` 那段（第 381–385 行一带，连注释），`import { readNotifications } from "./notifications";` 也删掉（`src/notifications.ts` 本身留着，`src/push.ts` 还在用它写）。旧地址那条加一行：

```ts
      if (url.pathname === "/notifications.html") {
        return new Response(null, { status: 301, headers: { Location: "p/notifications/" } });
      }
```

**核对**：`grep -n "readNotifications" src/*.ts` 应只剩 `src/notifications.ts` 自己（以及 `src/push.ts` 里写日志的那侧函数，名字不同）。

- [ ] **Step 8: 跑测试确认通过**

```bash
bun test src/plugin-routing.test.ts src/nav-tabs.test.ts
```

`nav-tabs.test.ts` 的第一个测试断言 `items.length` 是 2——现在有两个插件了，改成 3，并给新的那段加一条 href 断言：

```ts
  expect(items.length).toBe(3);
  expect(items[2]!.getAttribute("href")).toBe("p/notifications/");
```

- [ ] **Step 9: 跑全量**

```bash
bun run test
```

`src/server.test.ts` 里那两个通知历史测试（第 700 行、第 730 行一带）打的是 `/api/notifications`，URL 没变，**必须原样绿**。它们证明的是搬家没碰推送管线。

- [ ] **Step 10: 手动看一眼**

```bash
bun run src/index.ts --port 7999
```

`/p/notifications/` 能开、顶栏三段齐、点一条通知能跳到对应终端页。Ctrl-C。

- [ ] **Step 11: 提交**

```bash
git add -A plugins public src/server.ts src/plugin-routing.test.ts src/nav-tabs.test.ts
git commit -m "feat: 通知页搬成第二个插件，日志写入仍归推送管线"
```

---

### Task 7: 文档

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`、`README.zh-CN.md`

- [ ] **Step 1: 写 `CLAUDE.md` 的插件一节**

在 "Architecture" 里，紧跟 **Front-end** 那段之后插入：

```markdown
**Page-level features are plugins.** A plugin is one directory under `plugins/<id>/`: an isomorphic manifest (`plugin.js` — id, tab icon, title key, both dictionaries), a server entry (`server.ts` exporting `handle(req, url)`), and its own `public/`. The kernel reads a hard-coded array in `plugins/registry.js`, dispatches `/api/<id>/*` to that plugin's handler, and serves `/p/<id>/*` from its `public/`. Adding a page-level feature is adding a directory and one line; removing one leaves nothing behind. The gallery and the notification history are the two that exist.

The manifest and the handler are deliberately two tables. `registry.js` is loaded by the browser (`i18n.js` merges plugin dictionaries, `nav.js` builds the tabs from it), so importing a `.ts` from it would drag server code into the browser bundle — `plugins/registry.test.ts` asserts its import graph contains none.

Nothing is loaded at runtime: no scan of `~/.tmux-next/plugins`, no dynamic import. This service has no auth and binds loopback; a plugin directory anyone can drop code into is a different threat model than the one in SECURITY.md. `TMUX_NEXT_DISABLE_PLUGINS=<ids>` turns one off — its tab, its API and its pages all disappear together.

A plugin owns its own disk state through `pluginStateDir(id)` (`TMUX_NEXT_<ID>_DIR`, else `~/.tmux-next/<id>`), but it does not necessarily own everything it displays: `notifications.jsonl` is written by the push pipeline (`src/push.ts`), and `src/notifications.ts` stays in the kernel for that reason. The plugin holds the page and the read route only, so disabling it stops the history page and not the notifications.

**Shared browser modules resolve URLs against the app root, not the page.** Everything is relative so the app can be mounted under a reverse-proxy subpath, but a relative `fetch("api/…")` in a shared module resolves against whatever page loaded it — and plugin pages live at `/p/<id>/`. `public/root.js` derives the root from its own `import.meta.url` (it is always at the root, and it is served under whatever prefix the app is); `url("api/…")` is correct at any page depth under any prefix. Reaching for an absolute path instead is what breaks subpath deployment.
```

- [ ] **Step 2: 更新两份 README**

两份里凡是写"制品 / Artifacts 页在 `/gallery.html`"的地方改成 `/p/gallery/`，通知页同理。先找：

```bash
grep -n "gallery\|notifications\|制品\|通知" README.md README.zh-CN.md
```

只改路径事实，不改语气。两份必须同步——`README.zh-CN.md` 是 `README.md` 的镜像。

- [ ] **Step 3: 跑全量**

```bash
bun run test
```

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md README.md README.zh-CN.md
git commit -m "docs: 记下插件接缝，README 里的页面地址跟着改"
```

---

## 完工核对

全部任务做完后逐条确认：

- [ ] `bun run test` 全绿（`server.test.ts` / `reconnect.test.ts` 的孤儿会话断言若飘红，单独重跑该文件）
- [ ] `src/gallery.ts`、`src/gallery.test.ts`、`public/gallery.{html,js}`、`public/notifications.{html,js}` 都已不存在
- [ ] `grep -rn "gallery\|notifications" src/server.ts` 只剩 301 那两行
- [ ] `grep -c '"gallery\.\|"notif\.' public/i18n.js` 为 0
- [ ] `TMUX_NEXT_DISABLE_PLUGINS=gallery,notifications bun run src/index.ts` 起得来，顶栏只剩会话页，四个地址（两个 API、两个页面）全 404，**而推送仍然工作**
- [ ] `~/.tmux-next/gallery` 一个文件没动过，`tmux-next-gallery` skill 未经修改仍然有效
