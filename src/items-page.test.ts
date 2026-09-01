import { test, expect, afterEach } from "bun:test";
import { Window } from "happy-dom";
import { t } from "../public/i18n.js";

// mount() 的 fetch shim 把 api/language 答成 "en"，所以断言里的翻译也固定在
// "en"——跟页面实际渲染用的是同一份字典、同一种语言，不是巧合对上。
const tr = (key: string) => t(key, "en");

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

async function mount(body: unknown, store: Record<string, string> = {}) {
  const win = new Window({ url: "http://127.0.0.1:7682/index.html" });
  const doc = win.document;
  doc.body.innerHTML = '<header id="header"></header><main id="items"></main>';

  patch({
    window: win,
    document: doc,
    location: win.location,
    history: win.history,
    URLSearchParams: win.URLSearchParams,
    localStorage: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = v; },
    },
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

// 链接只从 source.url 来——内核不知道任何插件的路由规则，猜一条 URL 出来
// （比如按 provider 名字拼 p/<id>/？key=）就是在编那份规则，而且这条规则
// 编错过一次：没有任何插件页面真的读 ?key=。
test("单的来源带 url 时，标题链到那个地址", async () => {
  const root = await mount(payload({
    items: [item({
      source: { provider: "jira", ref: "EXAMPLE-1", url: "https://example.atlassian.net/browse/EXAMPLE-1" },
    })],
  }));
  const link = root.querySelector("a.item-title");
  expect(link?.getAttribute("href")).toBe("https://example.atlassian.net/browse/EXAMPLE-1");
});

// 有来源、但那条来源没带 url——标题不该被拿去瞎拼一个地址，退回纯文本；
// ref 徽标仍然画，因为它是有用的信息，跟"有没有地方可点"是两件事。
test("单的来源没有 url 时，标题不是链接，但 ref 徽标还在", async () => {
  const root = await mount(payload({
    items: [item({ source: { provider: "jira", ref: "EXAMPLE-1" } })],
  }));
  expect(root.querySelector("a.item-title")).toBeNull();
  expect(root.querySelector(".item-source")?.textContent).toBe("EXAMPLE-1");
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

// ---- facet chips ----

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

// ---- 分组与筛选（Task 8）----

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
  const options = [...root.querySelectorAll("#group-by option")].map((o) => o.getAttribute("value"));
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
