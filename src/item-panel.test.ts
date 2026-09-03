import { test, expect, afterEach, beforeEach } from "bun:test";
import { Window } from "happy-dom";
import { t } from "../public/i18n.js";

/**
 * 会话侧点开的那个浮层：这条会话（或这张卡）挂在哪张单下，那张单此刻怎么样。
 *
 * 它是"反向"的那一半——首页是单 → 会话，这里是会话 → 单。取数走
 * /api/items/:id 与 /api/items/by-session，画法全部来自 item-card.js，所以这个
 * 文件测的是取数、失败兜底和浮层本身的开关，不重复测 chip 怎么画。
 */

const tr = (key: string) => t(key, "en");

const PATCHED = ["window", "document", "fetch"] as const;
const saved = new Map<string, unknown>();
let patched = false;
let asked: string[] = [];

/** 下一次请求的应答。测试各自改它。 */
let reply: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(async () => {
  asked = [];
  const win = new Window({ url: "http://127.0.0.1:7682/terminal.html" });
  patched = true;
  for (const key of PATCHED) {
    if (key in globalThis) saved.set(key, (globalThis as Record<string, unknown>)[key]);
  }
  const set = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  set("window", win);
  set("document", win.document);
  set("fetch", async (u: unknown) => {
    asked.push(String(u));
    if (reply.status !== 200) return new Response("no", { status: reply.status });
    return new Response(JSON.stringify(reply.body));
  });
  // 语言钉死在 en：i18n-apply.js 的当前语言是模块级状态，同一个进程里别的页面
  // 测试会把它设成 zh，而 import 缓存让那份状态跨文件活着。不显式设一次，这里
  // 的断言就取决于哪个文件先跑。
  const { applyLang } = await import("../public/i18n-apply.js");
  applyLang("en");
});

// 不还原就会把假 fetch 留给同一个进程里的别的测试文件。
afterEach(() => {
  if (!patched) return;
  for (const key of PATCHED) {
    if (saved.has(key)) {
      Object.defineProperty(globalThis, key, { value: saved.get(key), writable: true, configurable: true });
    } else {
      delete (globalThis as Record<string, unknown>)[key];
    }
  }
  saved.clear();
  patched = false;
});

const load = () => import(`../public/item-panel.js?t=${Math.random()}`);

const detail = (over: Record<string, unknown> = {}) => ({
  item: { id: "it-1", title: "修登录页", source: { provider: "jira", ref: "AB-1", url: "https://j/AB-1" }, tags: [], createdAt: 1, closedAt: null },
  sessions: [{ name: "web-1-a", sessionId: "$1", turn: "waiting", idle: true }],
  facets: [
    { dim: "jira.status", value: "In Review" },
    { dim: "item.sessions", value: "1" },
  ],
  ...over,
});

test("按单号取，画出标题、chip 与会话行", async () => {
  reply = { status: 200, body: detail() };
  const { openItemPanel } = await load();
  const panel = await openItemPanel({ id: "it-1" });
  expect(asked.some((u) => u.includes("api/items/it-1"))).toBe(true);
  expect(panel.querySelector(".item-title")!.textContent).toBe("修登录页");
  expect(panel.textContent).toContain("In Review");
  const row = panel.querySelector("a.item-session") as HTMLAnchorElement;
  expect(row.getAttribute("href")).toContain("target=web-1-a");
});

test("按会话名取，打的是 by-session 那条", async () => {
  reply = { status: 200, body: detail() };
  const { openItemPanel } = await load();
  await openItemPanel({ session: "web-1-a" });
  expect(asked[0]).toContain("api/items/by-session?session=web-1-a");
});

// 会话没挂单、单被扫掉、服务器不在——对看的人是同一件事：这会儿看不到。浮层照开，
// 里面说一句，而不是点了什么都不发生。
test("取不到就开一个只说一句话的浮层", async () => {
  reply = { status: 404, body: {} };
  const { openItemPanel } = await load();
  const panel = await openItemPanel({ id: "it-gone" });
  expect(panel.textContent).toContain(tr("items.offline"));
  expect(panel.querySelector(".item-title")).toBeNull();
});

test("Esc 关掉浮层并回调 onClose", async () => {
  reply = { status: 200, body: detail() };
  const { openItemPanel } = await load();
  let closed = 0;
  const panel = await openItemPanel({ id: "it-1" }, { onClose: () => { closed++; } });
  expect(document.querySelector(".sheet-backdrop")).toBeTruthy();
  const KeyboardEvent = (globalThis as any).window.KeyboardEvent;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(document.querySelector(".sheet-backdrop")).toBeNull();
  expect(closed).toBe(1);
  expect(panel.isConnected).toBe(false);
});

test("点关闭按钮也关，且只回调一次", async () => {
  reply = { status: 200, body: detail() };
  const { openItemPanel } = await load();
  let closed = 0;
  const panel = await openItemPanel({ id: "it-1" }, { onClose: () => { closed++; } });
  const close = panel.querySelector(".sheet-close") as HTMLButtonElement;
  close.click();
  const KeyboardEvent = (globalThis as any).window.KeyboardEvent;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(closed).toBe(1);
});

// 同一条会话连点两下不该叠出两层浮层——第二次只是把已经开着的那个换成新数据。
test("已经开着一个时不叠第二个", async () => {
  reply = { status: 200, body: detail() };
  const { openItemPanel } = await load();
  await openItemPanel({ id: "it-1" });
  await openItemPanel({ id: "it-1" });
  expect(document.querySelectorAll(".sheet-backdrop").length).toBe(1);
});

// --- 终端页顶栏上的那枚入口 -------------------------------------------------
//
// 逻辑放在这个模块里（而不是 terminal.js 里）是为了它能被无头地渲染：terminal.js
// 要拉起 xterm 才跑得起来，而"这条会话挂没挂单、挂着时画什么"跟终端本身无关。

test("挂着单时往顶栏加一枚写着单号的按钮", async () => {
  reply = { status: 200, body: detail() };
  const { mountItemEntry } = await load();
  const bar = document.createElement("div");
  await mountItemEntry("web-1-a", bar);
  const btn = bar.querySelector("button") as HTMLButtonElement;
  expect(btn.textContent).toContain("AB-1");
  expect(btn.title).toBe(tr("list.viewItem"));
});

// 本地单没有单号，退回标题——留一枚空按钮等于让人点了才知道它是什么。
test("本地单退回显示标题", async () => {
  reply = { status: 200, body: detail({ item: { id: "it-2", title: "本地的活", source: null } }) };
  const { mountItemEntry } = await load();
  const bar = document.createElement("div");
  await mountItemEntry("web-1-a", bar);
  expect(bar.querySelector("button")!.textContent).toContain("本地的活");
});

// 没挂单就什么都不画：占位符会让顶栏在最窄的屏幕上先输掉一格宽度，换来一个
// 说"没有"的东西。
test("没挂单时顶栏什么都不加", async () => {
  reply = { status: 404, body: {} };
  const { mountItemEntry } = await load();
  const bar = document.createElement("div");
  await mountItemEntry("web-1-a", bar);
  expect(bar.children.length).toBe(0);
});

// 终端页整页都在收键盘，浮层开着的时候焦点不能被抢回终端——onOpen/onClose 就是
// 那个开关（terminal.js 的 modalOpen，见 focus-restore.js）。
test("点开与关掉各回调一次，给终端页当 modalOpen 用", async () => {
  reply = { status: 200, body: detail() };
  const { mountItemEntry } = await load();
  const bar = document.createElement("div");
  const seen: string[] = [];
  await mountItemEntry("web-1-a", bar, {
    onOpen: () => seen.push("open"),
    onClose: () => seen.push("close"),
  });
  (bar.querySelector("button") as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 20));
  expect(seen).toEqual(["open"]);
  const KeyboardEvent = (globalThis as any).window.KeyboardEvent;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(seen).toEqual(["open", "close"]);
});
