import { test, expect, afterEach } from "bun:test";
import { Window } from "happy-dom";
import { t } from "../public/i18n.js";

// mount() 的 fetch shim 把 api/language 答成 "en"，所以断言里的翻译也固定在
// "en"——跟页面实际渲染用的是同一份字典、同一种语言，不是巧合对上。
const tr = (key: string, vars?: Record<string, string | number>) => t(key, "en", vars);

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

/** 模块加载时的真 fetch，用来证明 shim 被完整还原了（见 patch() 里的注释）。 */
const REAL_FETCH = globalThis.fetch;

const NOW = Math.floor(Date.now() / 1000);

function item(over: Record<string, unknown> = {}) {
  return {
    id: "it-1",
    title: "修登录页",
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

/** 页面发出去的写请求，供断言用。每次 mount 清空。 */
let posted: Array<{ url: string; method: string; body: string }> = [];

/** 设了它之后，下一次 GET /api/items 换成这份——用来演"建完单再拉一次"。 */
let nextBody: unknown = null;

/** POST /api/items/sync 的应答，个别测试改它；mount() 之间不清也不影响别的测试
 * 用不到它的分支——不涉及同步的测试根本不会打这条路由。 */
let syncReply: { created: number; updated: number; total: number; truncated: boolean } =
  { created: 0, updated: 0, total: 0, truncated: false };
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
  // 一个测试里 mount 两次是合法的（比如对比"有明细"和"没明细"两种渲染）。第二次
  // patch 时 globalThis 上放着的是**上一层 shim**，把它存进 saved 就等于让
  // afterEach 把假 fetch 当真值还原回去，之后整个进程里所有文件的 fetch 都是假的。
  // 所以只有第一层才记录原值，后面的 patch 直接覆盖。
  const first = !patched;
  patched = true;
  for (const key of PATCHED) {
    if (first && key in globalThis) saved.set(key, (globalThis as Record<string, unknown>)[key]);
    Object.defineProperty(globalThis, key, {
      value: shims[key], writable: true, configurable: true,
    });
  }
}

/**
 * `enabledIds` 是 /api/plugins 该答出来的启用插件 id 列表——默认 `["jira"]`，
 * 跟真实部署的默认状态一致（jira 插件默认是启用的）。刷新按钮该不该画，现在
 * 要看这份列表跟每个插件清单自己声明的 `provides` 的交集，不再只看
 * `item.source` 存不存在，所以大多数测试不用管这个参数；只有故意测
 * "没人认领这个来源"的那条会传空数组。
 */
async function mount(body: unknown, store: Record<string, string> = {}, enabledIds: string[] = ["jira"]) {
  posted = [];
  nextBody = null;
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
    fetch: (async (u: unknown, init?: RequestInit) => {
      const href = String(u);
      if (init?.method && init.method !== "GET") {
        posted.push({ url: href, method: init.method, body: String(init.body ?? "") });
        if (href.includes("/refresh")) return new Response(JSON.stringify({ ok: true }));
        if (href.includes("api/items/sync")) return new Response(JSON.stringify(syncReply));
        return new Response(JSON.stringify({}));
      }
      if (href.includes("api/items")) return new Response(JSON.stringify(nextBody ?? body));
      if (href.includes("api/plugins")) return new Response(JSON.stringify(enabledIds));
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

/**
 * 会话链接的参数名必须是 `target`。
 *
 * terminal.js 只读 `target`（`searchParams.get("target")`），会话列表和通知落点
 * 用的也是它。这里一度写成 `session=`：链接看着没问题、会话名也在里面，点进去却
 * 打不开——而当时的断言只检查 href 含不含会话名，正好从这个洞里漏过去了。所以这
 * 条盯的是参数名本身。
 */
test("会话链接用 target 参数，跟会话列表和通知落点一致", async () => {
  const root = await mount(payload({
    items: [item()],
    sessions: [session({ name: "跑测试" })],
    bindings: [{ session: "跑测试", itemId: "it-1", live: true }],
  }));
  const href = root.querySelector(".item-session")?.getAttribute("href") ?? "";
  expect(href).toContain("target=");
  expect(href).not.toContain("session=");
  expect(href).toContain(encodeURIComponent("跑测试"));
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
      "it-1": [{ dim: "item.agent", value: "working" }],
      "it-2": [{ dim: "item.agent", value: "waiting" }],
    },
  }));
  const headers = [...root.querySelectorAll(".group-name")].map((n) => n.textContent);
  expect(headers[0]).toBe(tr("items.agent.waiting"));
});

test("分组选择器的选项从数据里现算", async () => {
  const root = await mount(payload({
    items: [item()],
    facets: { "it-1": [{ dim: "item.agent", value: "working" }, { dim: "jira.status", value: "In Progress" }] },
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
    facets: { "it-1": [{ dim: "item.agent", value: "working" }] },
  }), store);
  expect(root.querySelectorAll(".item-card").length).toBe(1);
});

/**
 * 真正筛空的情形：两个维度的取值在数据里都存在，但没有一张单同时满足。
 *
 * 这条以前用的是"取值压根不在数据里"（`item.agent: ["nope"]`），而那种筛选现在会被
 * pruneSelection 对账掉——它是个看不见、点不掉却在生效的筛选，属于要治的病，不是要
 * 测的行为。
 */
test("筛到没有单时说清楚，而不是空白", async () => {
  const store = {
    "tmux-next.items.filter": JSON.stringify({
      "item.agent": ["working"],
      "jira.status": ["Done"],
    }),
  };
  const root = await mount(payload({
    items: [item({ id: "it-1" }), { ...item(), id: "it-2", title: "另一张" }],
    facets: {
      "it-1": [{ dim: "item.agent", value: "working" }],
      "it-2": [{ dim: "jira.status", value: "Done" }],
    },
  }), store);
  expect(root.querySelectorAll(".item-card").length).toBe(0);
  expect(root.querySelector(".empty")?.textContent).toContain(tr("items.noneMatch"));
});

// 说清楚还不够——还要给一个能解除它的东西，否则你知道是筛选在作怪，也得自己去猜是
// 哪个字段、翻到哪个 chip。
test("筛空时给一个清除筛选的按钮，点了就回到全部", async () => {
  const store = {
    "tmux-next.items.filter": JSON.stringify({
      "item.agent": ["working"],
      "jira.status": ["Done"],
    }),
  };
  const root = await mount(payload({
    items: [item({ id: "it-1" }), { ...item(), id: "it-2", title: "另一张" }],
    facets: {
      "it-1": [{ dim: "item.agent", value: "working" }],
      "it-2": [{ dim: "jira.status", value: "Done" }],
    },
  }), store);
  const clear = root.querySelector(".clear-filter");
  expect(clear).not.toBeNull();
  clear?.dispatchEvent(new (globalThis as any).window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  expect(root.querySelectorAll(".item-card").length).toBe(2);
  expect(JSON.parse(store["tmux-next.items.filter"]!)).toEqual({});
});

/**
 * 存下来的取值已经不在数据里时，页面自愈而不是被筛空。
 *
 * 这就是真实遇到的那一幕：同步换了一批单之后，早先选中的状态没了，chips 里没有它、
 * 点不掉它，可它还在过滤 —— 46 张单被筛成 0，屏幕上没有一个选中的 chip 可以解释。
 */
test("失效的筛选取值被对账掉，页面不再被筛空", async () => {
  const store = { "tmux-next.items.filter": JSON.stringify({ "item.agent": ["nope"] }) };
  const root = await mount(payload({
    items: [item()],
    facets: { "it-1": [{ dim: "item.agent", value: "working" }] },
  }), store);
  expect(root.querySelectorAll(".item-card").length).toBe(1);
  expect(JSON.parse(store["tmux-next.items.filter"]!)).toEqual({});
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
    facets: { "it-1": [{ dim: "item.agent", value: "working" }] },
  }), store);
  expect(root.querySelector(".unassigned")?.textContent).toContain("随手开的");
});

/**
 * 筛选按字段分行、按需添加。
 *
 * 从前所有维度的取值平铺成一排 chips，谁属于哪个字段全靠 chip 自带的"维度: 取值"
 * 前缀区分——十三张单九个维度时那是几十个挤在一起、彼此长得一样的按钮。现在一个
 * 字段一块，默认一块都不加，由使用者挑。
 */

const FIELDS_KEY = "tmux-next.items.fields";

const twoDims = {
  "it-1": [
    { dim: "item.agent", value: "waiting" },
    { dim: "jira.status", value: "In Progress" },
  ],
  "it-2": [
    { dim: "item.agent", value: "working" },
    { dim: "jira.status", value: "Done" },
  ],
};

const twoItems = [{ ...item(), id: "it-1" }, { ...item(), id: "it-2", title: "另一张" }];

test("默认一个筛选字段都不加，只给一个添加入口", async () => {
  const root = await mount(payload({ items: twoItems, facets: twoDims }));
  expect(root.querySelectorAll(".filter-field").length).toBe(0);
  expect(root.querySelector("#field-picker")).not.toBeNull();
});

test("添加入口列出数据里有的维度", async () => {
  const root = await mount(payload({ items: twoItems, facets: twoDims }));
  const options = [...root.querySelectorAll("#field-picker option")].map((o) => o.getAttribute("value"));
  expect(options).toContain("item.agent");
  expect(options).toContain("jira.status");
});

test("加过的字段各占一块，块里是它自己的取值", async () => {
  const store = { [FIELDS_KEY]: JSON.stringify(["jira.status"]) };
  const root = await mount(payload({ items: twoItems, facets: twoDims }), store);
  const fields = root.querySelectorAll(".filter-field");
  expect(fields.length).toBe(1);
  expect(fields[0].querySelector(".field-name")?.textContent).toBeTruthy();
  const values = [...fields[0].querySelectorAll(".filter-chip")].map((c) => c.textContent);
  expect(values.sort()).toEqual(["Done", "In Progress"]);
});

// chip 上只写取值：归属由它所在的那一块表达，不必每个按钮都重复一遍字段名。
test("chip 上不再重复字段名", async () => {
  const store = { [FIELDS_KEY]: JSON.stringify(["jira.status"]) };
  const root = await mount(payload({ items: twoItems, facets: twoDims }), store);
  const chip = root.querySelector(".filter-chip");
  expect(chip?.textContent).toBe("In Progress");
});

test("已加的字段不再出现在添加入口里", async () => {
  const store = { [FIELDS_KEY]: JSON.stringify(["jira.status"]) };
  const root = await mount(payload({ items: twoItems, facets: twoDims }), store);
  const options = [...root.querySelectorAll("#field-picker option")].map((o) => o.getAttribute("value"));
  expect(options).not.toContain("jira.status");
  expect(options).toContain("item.agent");
});

test("字段块里的取值是 toggle，选中态画出来", async () => {
  const store = {
    [FIELDS_KEY]: JSON.stringify(["jira.status"]),
    "tmux-next.items.filter": JSON.stringify({ "jira.status": ["In Progress"] }),
  };
  const root = await mount(payload({ items: twoItems, facets: twoDims }), store);
  const chips = [...root.querySelectorAll(".filter-chip")];
  const on = chips.filter((c) => c.className.includes("selected"));
  expect(on.length).toBe(1);
  expect(on[0].textContent).toBe("In Progress");
  expect(on[0].getAttribute("aria-pressed")).toBe("true");
});

test("存的字段在当前数据里没有就不画，但不从存储里抹掉", async () => {
  const store = { [FIELDS_KEY]: JSON.stringify(["gone.dim", "jira.status"]) };
  const root = await mount(payload({ items: twoItems, facets: twoDims }), store);
  expect(root.querySelectorAll(".filter-field").length).toBe(1);
  expect(JSON.parse(store[FIELDS_KEY])).toEqual(["gone.dim", "jira.status"]);
});

// 移掉字段却留着它的选择，等于留一个看不见还在生效的筛选——页面少了几张单，而屏幕
// 上没有任何东西解释为什么。
test("移除字段时连它的选择一起清掉", async () => {
  const store = {
    [FIELDS_KEY]: JSON.stringify(["jira.status"]),
    "tmux-next.items.filter": JSON.stringify({ "jira.status": ["Done"] }),
  };
  const root = await mount(payload({ items: twoItems, facets: twoDims }), store);
  root.querySelector(".field-remove")?.dispatchEvent(new (globalThis as any).window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  expect(JSON.parse(store[FIELDS_KEY])).toEqual([]);
  expect(JSON.parse(store["tmux-next.items.filter"])).toEqual({});
});

// ---- 同步、单张刷新、归档（Task 8）----

const withSource = () => item({ source: { provider: "jira", ref: "EXAMPLE-1" } });
const clickable = (root: any, sel: string) =>
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

// 有来源，但没有任何启用的插件声明 provides 里含这个 provider——TMUX_NEXT_
// DISABLE_PLUGINS=jira 就是这个状况：/api/plugins 答不出 "jira"，点了就是一次
// 必然 404 的请求。这是这条 review 里的 Important 1：按钮不该画出来，而不是
// 画出来再让点击去发现打不通。
test("有来源，但没有启用的插件认领这个 provider 时不画刷新按钮", async () => {
  const root = await mount(payload({ items: [withSource()] }), {}, []);
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

// Ruling 2 之一：头部计数要跟卡片渲染同一份集合。两张单只在 closedAt 上不同，
// 旧写法（数 items.length）会给 2，新写法（数 visible.length）给 1——这条断言
// 专门盯着这个差异，不是随便一个"有计数"的测试。
test("归档一张单之后，头部计数只数还画着的那些", async () => {
  const root = await mount(payload({
    items: [item({ id: "it-1" }), item({ id: "it-2", closedAt: 1787000000 })],
  }));
  expect(root.querySelectorAll(".item-card").length).toBe(1);
  expect(document.getElementById("count")?.textContent).toBe(tr("items.count", { n: 1 }));
});

// Ruling 2 之二：筛选选项要从"看得见的单"里现算，不能来自后端给的全量 facets。
// 两张单同一个维度、不同取值，取值只出现在被默认隐藏的归档单上的那个不该出现
// 在筛选块里——旧写法（选项算在全量 facets 上）会连"Done"一起给出来。
test("归档单独有的取值不出现在筛选选项里", async () => {
  const store = { [FIELDS_KEY]: JSON.stringify(["jira.status"]) };
  const root = await mount(payload({
    items: [item({ id: "it-1" }), item({ id: "it-2", closedAt: 1787000000 })],
    facets: {
      "it-1": [{ dim: "jira.status", value: "In Progress" }],
      "it-2": [{ dim: "jira.status", value: "Done" }],
    },
  }), store);
  const values = [...root.querySelectorAll(".filter-chip")].map((c) => c.textContent);
  expect(values).toEqual(["In Progress"]);
});

/**
 * 带明细的维度可以点开看列表。
 *
 * 汇总数字只说"几个挂了"，说不出**是哪个**挂了——而那才是看到红色之后唯一想知道
 * 的事。内核不知道这些行是 CI 检查，只知道这个维度还有东西可看。
 */

const withChecks = () =>
  payload({
    items: [item()],
    facets: {
      "it-1": [
        {
          dim: "jira.checks",
          value: "1/2",
          tone: "warn",
          detail: [
            { label: "ci/circleci: test", value: "FAILED", tone: "warn" },
            { label: "ci/circleci: build", value: "SUCCESSFUL", tone: "ok" },
          ],
        },
      ],
    },
  });

test("带明细的 chip 画成按钮，没明细的还是静态文字", async () => {
  const root = await mount(withChecks());
  expect(root.querySelector("button.facet.has-detail")).not.toBeNull();

  const plain = await mount(payload({
    items: [item()],
    facets: { "it-1": [{ dim: "jira.status", value: "In Progress" }] },
  }));
  expect(plain.querySelector("button.facet")).toBeNull();
});

test("点开列出每一行的名字和状态", async () => {
  const root = await mount(withChecks());
  root.querySelector("button.facet.has-detail")
    ?.dispatchEvent(new (globalThis as any).window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));

  const rows = [...document.querySelectorAll(".detail-row")];
  expect(rows.length).toBe(2);
  expect(rows[0]!.textContent).toContain("ci/circleci: test");
  expect(rows[0]!.textContent).toContain("FAILED");
});

// 状态的颜色靠 tone，而 tone 是插件给的——内核不认识 FAILED 这个词。
test("明细行的色调来自 tone，不是内核认识状态词", async () => {
  const root = await mount(withChecks());
  root.querySelector("button.facet.has-detail")
    ?.dispatchEvent(new (globalThis as any).window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  expect(document.querySelector(".detail-state.warn")).not.toBeNull();
  expect(document.querySelector(".detail-state.ok")).not.toBeNull();
});

test("关闭按钮收起浮层", async () => {
  const root = await mount(withChecks());
  root.querySelector("button.facet.has-detail")
    ?.dispatchEvent(new (globalThis as any).window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  expect(document.querySelector(".sheet-backdrop")).not.toBeNull();

  document.querySelector(".sheet-close")
    ?.dispatchEvent(new (globalThis as any).window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  expect(document.querySelector(".sheet-backdrop")).toBeNull();
});


// 这条必须排在会 mount 两次的测试后面：它验的正是那一次的 afterEach 还原对不对。
// 还原错了不会在本文件里露头——本文件每个测试都自带 shim——而是让之后所有文件的
// fetch 变成假的（CLAUDE.md 记过一次同样的事故，当时打挂 38 个测试）。
test("多次 mount 之后真 fetch 仍被还原", () => {
  expect(globalThis.fetch).toBe(REAL_FETCH);
});

// 明细行带 url 时画成链接。target=_blank 必须配 rel=noopener，否则对面拿得到
// window.opener；这条断言就是盯着那个组合，不是盯着"有没有 a 标签"。
test("带链接的明细行画成新窗口打开的链接", async () => {
  const root = await mount(payload({
    items: [item()],
    facets: { "it-1": [{ dim: "jira.prs", value: "2", detail: [
      { label: "修登录页", value: "OPEN", url: "https://example.com/pr/1" },
      { label: "没链接的", value: "MERGED", tone: "dim" },
    ] }] },
  }));
  root.querySelector("button.facet.has-detail")
    ?.dispatchEvent(new (globalThis as any).window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));

  const link = document.querySelector("a.detail-label") as HTMLAnchorElement | null;
  expect(link?.getAttribute("href")).toBe("https://example.com/pr/1");
  expect(link?.getAttribute("target")).toBe("_blank");
  expect(link?.getAttribute("rel")).toBe("noopener noreferrer");

  // 没链接的那行仍然是静态文字，不是一个 href 为空的链接。
  expect(document.querySelectorAll("a.detail-label").length).toBe(1);
  expect(document.querySelectorAll(".detail-row").length).toBe(2);
});

/**
 * 新建本地单：只要一个标题。
 *
 * 这是首页上唯一一个"从无到有"的动作——在它之前，本地单只能用 curl 建。
 */

const click = (node: { dispatchEvent: (e: any) => unknown } | null) =>
  node?.dispatchEvent(new (globalThis as any).window.Event("click", { bubbles: true }));

const type = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new (globalThis as any).window.Event("input", { bubbles: true }));
};

test("新建单按钮开出一个只要标题的浮层", async () => {
  const root = await mount(payload());
  click(root.ownerDocument.getElementById("new-item"));
  await new Promise((r) => setTimeout(r, 20));

  expect(document.querySelector(".sheet-backdrop")).not.toBeNull();
  expect(document.querySelector(".sheet-input")).not.toBeNull();
  // 目录、标签都不问——单是工作单元，那些是它之后长出来的东西。
  expect(document.querySelectorAll(".sheet-input").length).toBe(1);
});

// 空标题服务端会 400。与其点了才知道，不如按不下去。
test("标题为空时建立按钮按不下去", async () => {
  const root = await mount(payload());
  click(root.ownerDocument.getElementById("new-item"));
  await new Promise((r) => setTimeout(r, 20));

  const create = document.querySelector(".sheet-create") as HTMLButtonElement;
  expect(create.disabled).toBe(true);

  const input = document.querySelector(".sheet-input") as HTMLInputElement;
  type(input, "   ");
  expect(create.disabled).toBe(true);

  type(input, "修登录页");
  expect(create.disabled).toBe(false);
});

test("建单发出 POST，标题去掉首尾空白", async () => {
  const root = await mount(payload());
  click(root.ownerDocument.getElementById("new-item"));
  await new Promise((r) => setTimeout(r, 20));

  type(document.querySelector(".sheet-input") as HTMLInputElement, "  修登录页  ");
  click(document.querySelector(".sheet-create"));
  await new Promise((r) => setTimeout(r, 60));

  const req = posted.find((p) => p.url.includes("api/items") && p.method === "POST");
  expect(req).toBeDefined();
  expect(JSON.parse(req!.body)).toEqual({ title: "修登录页" });
});

// 建完必须重新去问一次服务端。只拿手上已有的数据重画，新建的单不在里面——
// 页面会看起来什么都没发生。
test("建完重新拉一次列表，新单出现在页面上", async () => {
  const root = await mount(payload());
  nextBody = payload({ items: [item({ id: "it-9", title: "刚建的单" })] });

  click(root.ownerDocument.getElementById("new-item"));
  await new Promise((r) => setTimeout(r, 20));
  type(document.querySelector(".sheet-input") as HTMLInputElement, "刚建的单");
  click(document.querySelector(".sheet-create"));
  await new Promise((r) => setTimeout(r, 120));

  expect(document.querySelector(".sheet-backdrop")).toBeNull();
  expect(root.textContent).toContain("刚建的单");
});

// 失败之后最不该做的事是把人刚打的字扔掉。
test("建单失败时浮层留着、输入留着", async () => {
  const root = await mount(payload());
  click(root.ownerDocument.getElementById("new-item"));
  await new Promise((r) => setTimeout(r, 20));

  const input = document.querySelector(".sheet-input") as HTMLInputElement;
  type(input, "会失败的单");
  // 让这次 POST 返回 500
  const real = globalThis.fetch;
  (globalThis as any).fetch = async (u: unknown, init?: RequestInit) =>
    init?.method === "POST" && String(u).includes("api/items")
      ? new Response("boom", { status: 500 })
      : real(u as any, init);

  click(document.querySelector(".sheet-create"));
  await new Promise((r) => setTimeout(r, 60));
  (globalThis as any).fetch = real;

  expect(document.querySelector(".sheet-backdrop")).not.toBeNull();
  expect((document.querySelector(".sheet-input") as HTMLInputElement).value).toBe("会失败的单");
  const err = document.querySelector(".sheet-error") as HTMLElement;
  expect(err.hidden).toBe(false);
  expect(err.textContent).toBe(tr("items.createFailed"));
  // 还能再试一次，不是按死了
  expect((document.querySelector(".sheet-create") as HTMLButtonElement).disabled).toBe(false);
});

// 手机上打完字直接回车是唯一顺手的提交方式。
test("回车提交，Esc 关掉", async () => {
  const root = await mount(payload());
  click(root.ownerDocument.getElementById("new-item"));
  await new Promise((r) => setTimeout(r, 20));
  const input = document.querySelector(".sheet-input") as HTMLInputElement;
  type(input, "回车建的单");
  input.dispatchEvent(new (globalThis as any).window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  expect(posted.some((p) => p.method === "POST" && JSON.parse(p.body).title === "回车建的单")).toBe(true);

  click(root.ownerDocument.getElementById("new-item"));
  await new Promise((r) => setTimeout(r, 20));
  (document.querySelector(".sheet-input") as HTMLInputElement)
    .dispatchEvent(new (globalThis as any).window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  expect(document.querySelector(".sheet-backdrop")).toBeNull();
});

// 上面几条走的是"一张单都没有"那条分支（空状态里那个按钮）。有单的时候按钮在
// 工具条上，是另一段代码——两条路都得有入口，否则总有一头够不到。
test("已经有单时新建按钮在工具条上", async () => {
  const root = await mount(payload({ items: [item()] }));
  const btn = root.ownerDocument.getElementById("new-item");
  expect(btn).not.toBeNull();
  expect(btn?.closest(".toolbar-actions")).not.toBeNull();

  click(btn);
  await new Promise((r) => setTimeout(r, 20));
  expect(document.querySelector(".sheet-input")).not.toBeNull();
});

/**
 * 方向一：在单上挂一个已经跑着的会话。
 *
 * 反方向在会话列表（src/list-page.test.ts），两边打的是同一个接口。
 */

test("卡片上的关联按钮列出所有会话，并标出别人已经占着的", async () => {
  const root = await mount(payload({
    items: [item(), item({ id: "it-2", title: "改搜索" })],
    sessions: [session({ name: "甲" }), session({ name: "乙" })],
    bindings: [{ session: "乙", itemId: "it-2", live: true }],
  }));

  click(root.querySelector(".item-link"));
  await new Promise((r) => setTimeout(r, 20));

  const rows = [...document.querySelectorAll(".pick-row")];
  expect(rows.map((r) => r.querySelector(".pick-label")?.textContent)).toEqual(["甲", "乙"]);
  // 已经挂在别处的要说明白挂在哪——否则选下去就是一次看不见的改挂。
  expect(rows[1]!.querySelector(".pick-note")?.textContent).toContain("改搜索");
  expect(rows[0]!.querySelector(".pick-note")).toBeNull();
});

test("选一个会话就 POST 到这张单的 bind 上", async () => {
  const root = await mount(payload({
    items: [item()],
    sessions: [session({ name: "甲" })],
  }));

  click(root.querySelector(".item-link"));
  await new Promise((r) => setTimeout(r, 20));
  click(document.querySelector(".pick-row"));
  await new Promise((r) => setTimeout(r, 60));

  const req = posted.find((p) => p.url.includes("/bind"));
  expect(req?.method).toBe("POST");
  expect(req?.url).toContain("api/items/it-1/bind");
  expect(JSON.parse(req!.body)).toEqual({ session: "甲" });
});

// 挂在自己名下的那个要标出来，不是藏起来：藏掉会让人以为自己记错了。
test("已经挂在本单下的会话标成当前项", async () => {
  const root = await mount(payload({
    items: [item()],
    sessions: [session({ name: "甲" })],
    bindings: [{ session: "甲", itemId: "it-1", live: true }],
  }));

  click(root.querySelector(".item-link"));
  await new Promise((r) => setTimeout(r, 20));
  const row = document.querySelector(".pick-row")!;
  expect(row.className).toContain("current");
  expect(row.querySelector(".pick-note")).toBeNull();
});

test("一个会话都没有时说清楚", async () => {
  const root = await mount(payload({ items: [item()], sessions: [] }));
  click(root.querySelector(".item-link"));
  await new Promise((r) => setTimeout(r, 20));
  expect(document.querySelector(".sheet-warn")?.textContent).toBe(tr("items.noSessions"));
});
