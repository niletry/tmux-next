import { test, expect, afterEach, beforeEach } from "bun:test";
import { Window } from "happy-dom";
import { t } from "../public/i18n.js";

/**
 * 一张单画出来的那几块——chip、徽标、会话行、明细浮层。
 *
 * 单独成模块、单独测，是因为它现在有两个使用者：首页的卡片，和会话侧（会话列表
 * 的 chip、终端页的徽标）点开的那个浮层。两边各画一套 chip，迟早会对同一份数据
 * 给出两种说法，而那种漂移没有任何东西看得见。
 *
 * 页面文件不做类型检查，这个模块做（// @ts-check）——它是两处共用的那一层。
 */

const tr = (key: string, vars?: Record<string, string | number>) => t(key, "en", vars);

const PATCHED = ["window", "document"] as const;
const saved = new Map<string, unknown>();
let patched = false;

beforeEach(async () => {
  const win = new Window({ url: "http://127.0.0.1:7682/index.html" });
  patched = true;
  for (const key of PATCHED) {
    if (key in globalThis) saved.set(key, (globalThis as Record<string, unknown>)[key]);
  }
  Object.defineProperty(globalThis, "window", { value: win, writable: true, configurable: true });
  Object.defineProperty(globalThis, "document", { value: win.document, writable: true, configurable: true });
  // 语言钉死在 en：i18n-apply.js 的当前语言是模块级状态，同一个进程里别的页面
  // 测试会把它设成 zh，而 import 缓存让那份状态跨文件活着。不显式设一次，这里
  // 的断言就取决于哪个文件先跑。
  const { applyLang } = await import("../public/i18n-apply.js");
  applyLang("en");
});

// 不还原就会把假 document 留给同一个进程里的别的测试文件——public/ 的渲染测试
// 已经因为漏还原 fetch 一次性弄红过 38 条测试。
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

const load = () => import(`../public/item-card.js?t=${Math.random()}`);

const NOW = Math.floor(Date.now() / 1000);
const session = (over: Record<string, unknown> = {}) => ({
  name: "甲", sessionId: "$1", turn: null, idle: false, ...over,
});

test("没有明细的维度画成一格 chip，值原样显示", async () => {
  const { facetChip } = await load();
  const chip = facetChip({ dim: "jira.status", value: "In Review" });
  expect(chip.tagName).toBe("SPAN");
  expect(chip.textContent).toContain("In Review");
});

test("带明细的维度画成按钮，点开列出每一行", async () => {
  const { facetChip } = await load();
  const chip = facetChip({
    dim: "jira.pr",
    value: "1",
    detail: [{ label: "PR #7 修登录", value: "OPEN", url: "https://example.com/pr/7" }],
  });
  expect(chip.tagName).toBe("BUTTON");
  chip.dispatchEvent(new (globalThis as any).window.Event("click", { bubbles: true }));
  const sheet = document.querySelector(".sheet-backdrop")!;
  expect(sheet).toBeTruthy();
  const link = sheet.querySelector("a.detail-label") as HTMLAnchorElement;
  expect(link.href).toBe("https://example.com/pr/7");
  expect(link.rel).toBe("noopener noreferrer");
  expect(sheet.textContent).toContain("OPEN");
});

test("agent 维度的取值走字典，不把内部词露出来", async () => {
  const { facetChip } = await load();
  const chip = facetChip({ dim: "item.agent", value: "waiting" });
  expect(chip.textContent).toContain(tr("items.agent.waiting"));
  expect(chip.textContent).not.toContain("waiting");
});

test("badge 维度和没有会话的 item.sessions 不进 chip 行", async () => {
  const { chipVisible } = await load();
  expect(chipVisible({ dim: "item.source", value: "jira", badge: true })).toBe(false);
  expect(chipVisible({ dim: "item.sessions", value: "0" })).toBe(false);
  expect(chipVisible({ dim: "item.sessions", value: "2" })).toBe(true);
});

test("会话行链到终端页，参数名是 target", async () => {
  const { sessionRow } = await load();
  const row = sessionRow(session({ name: "web-1-a" }), null);
  expect(row.getAttribute("href")).toContain("target=web-1-a");
  expect(row.textContent).toContain(tr("items.agent.working"));
});

test("单头给出标题、单号链接与会话数", async () => {
  const { itemHead } = await load();
  const head = itemHead(
    { id: "it-1", title: "修登录页", source: { provider: "jira", ref: "AB-1", url: "https://j/AB-1" } },
    [{ dim: "item.source", value: "jira", badge: true }],
    2,
  );
  expect(head.querySelector(".item-title")!.textContent).toBe("修登录页");
  const src = head.querySelector("a.item-source") as HTMLAnchorElement;
  expect(src.textContent).toBe("AB-1");
  expect(src.href).toBe("https://j/AB-1");
  expect(head.textContent).toContain(tr("items.sessions", { n: 2 }));
});

test("本地单没有来源徽标，也不画会话数", async () => {
  const { itemHead } = await load();
  const head = itemHead({ id: "it-2", title: "本地的活", source: null }, [], 0);
  expect(head.querySelector(".item-source")).toBeNull();
  expect(head.querySelector(".item-count")).toBeNull();
});
