import { test, expect, afterEach } from "bun:test";
import { Window } from "happy-dom";

/**
 * The work-item list, driven in a real DOM.
 *
 * Home page is now items, not sessions — this is the render test the task
 * brief calls for, copying src/list-page.test.ts's happy-dom scaffolding
 * (PATCHED list + guarded afterEach restore) rather than inventing a new one.
 */

// Worktree-relative on purpose — see src/list-page.test.ts for why a hardcoded
// absolute path here would silently test the main checkout instead of this one.
const PAGE = new URL("../public/items.js", import.meta.url).pathname;

const NOW = Math.floor(Date.now() / 1000);

function item(over: Record<string, unknown> = {}) {
  return {
    id: "it-1",
    title: "修登录页",
    cwd: "/tmp/x",
    source: null,
    tags: [],
    createdAt: NOW,
    closedAt: null,
    ...over,
  };
}
function session(over: Record<string, unknown> = {}) {
  return {
    name: "甲",
    sessionId: "$1",
    windowWidth: 80,
    windowHeight: 24,
    lastActivityEpoch: NOW,
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
    itemId: null,
    ...over,
  };
}
const payload = (over: Record<string, unknown> = {}) => ({
  items: [],
  bindings: [],
  sessions: [],
  facets: {},
  ...over,
});

const PATCHED = ["window", "document", "location", "history", "URLSearchParams",
  "localStorage", "fetch", "setInterval"] as const;
const saved = new Map<string, unknown>();
// Only mount()/mountFailing() touch globalThis — without this flag a test file
// that never mounted would still run the restore loop, find `saved` empty and
// delete real globals like `fetch` that were never touched, breaking every
// other test file sharing this Bun process.
let patched = false;

afterEach(() => {
  if (!patched) return;
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
  patched = false;
});

function patch(shims: Record<string, unknown>) {
  patched = true;
  for (const key of PATCHED) {
    if (key in globalThis) saved.set(key, (globalThis as Record<string, unknown>)[key]);
    Object.defineProperty(globalThis, key, {
      value: shims[key], writable: true, configurable: true,
    });
  }
}

async function mount(body: unknown) {
  const win = new Window({ url: "http://127.0.0.1:7682/index.html" });
  const doc = win.document;
  doc.body.innerHTML = '<header id="header"></header><main id="items"></main>';

  patch({
    window: win,
    document: doc,
    location: win.location,
    history: win.history,
    URLSearchParams: win.URLSearchParams,
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: (async (u: unknown) => {
      const href = String(u);
      if (href.includes("api/items")) return new Response(JSON.stringify(body));
      if (href.includes("api/plugins")) return new Response(JSON.stringify([]));
      if (href.includes("api/language")) return new Response(JSON.stringify({ lang: "en" }));
      return new Response("{}");
    }) as typeof fetch,
    setInterval: () => 0,
  });

  await import(`${PAGE}?t=${Math.random()}`);
  await new Promise((r) => setTimeout(r, 250));
  return doc.getElementById("items")!;
}

async function mountFailing() {
  const win = new Window({ url: "http://127.0.0.1:7682/index.html" });
  const doc = win.document;
  doc.body.innerHTML = '<header id="header"></header><main id="items"></main>';

  patch({
    window: win,
    document: doc,
    location: win.location,
    history: win.history,
    URLSearchParams: win.URLSearchParams,
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: (async (u: unknown) => {
      const href = String(u);
      if (href.includes("api/items")) throw new Error("offline");
      if (href.includes("api/plugins")) return new Response(JSON.stringify([]));
      if (href.includes("api/language")) return new Response(JSON.stringify({ lang: "en" }));
      return new Response("{}");
    }) as typeof fetch,
    setInterval: () => 0,
  });

  await import(`${PAGE}?t=${Math.random()}`);
  await new Promise((r) => setTimeout(r, 250));
  return doc.getElementById("items")!;
}

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

// 内核不认识具体插件——这是接缝的方向，值得由测试守着而不是靠自觉，同 list.js
// 那条断言（src/list-page.test.ts）。
test("items.js 的源码里不出现任何具体插件的 id", async () => {
  const source = await Bun.file(PAGE).text();
  expect(source).not.toContain("jira");
  expect(source).not.toContain("gallery");
});
