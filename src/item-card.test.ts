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
  // 默认摆出"有精确指针"的设备：happy-dom 自带的 matchMedia 不认识 pointer 这类
  // 特性查询，测不出真实分支——这里假装桌面，让终端链接测的都是既有的
  // "开新标签页"这条路；触屏那条分支单独在下面一条用例里覆盖。
  // @ts-expect-error 覆盖 happy-dom 自带实现。
  win.matchMedia = (query: string) => ({ matches: query === "(pointer: fine)", media: query });
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

test("facetChip 把 sessionName 一路传给明细里的发送按钮", async () => {
  const { facetChip } = await load();
  const chip = facetChip(
    { dim: "jira.checks", value: "1/1", detail: [{ label: "ci/test", value: "FAILED", tone: "warn", send: "修复它" }] },
    { sessionName: "web-1-a" },
  );
  chip.dispatchEvent(new (globalThis as any).window.Event("click", { bubbles: true }));
  expect(document.querySelector(".detail-send")).not.toBeNull();
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

// 会话终端是自己在跑的另一个东西，不是"看完就关"的一次性内容——原地跳走会把
// 点开它之前那一页（单面板、会话列表）一起带走。但只在有精确指针的设备上：
// 见 pointer-mode.js，手机的标签页管理挤不下这个。
test("有精确指针的设备：会话行的终端链接在新标签页打开", async () => {
  const { sessionRow } = await load();
  const row = sessionRow(session({ name: "web-1-a" }), null);
  expect(row.getAttribute("target")).toBe("_blank");
  expect(row.getAttribute("rel")).toBe("noopener noreferrer");
});

test("纯触屏设备：会话行的终端链接原地跳转", async () => {
  // @ts-expect-error 覆盖成"没有精确指针"。
  window.matchMedia = (query: string) => ({ matches: false, media: query });
  const { sessionRow } = await load();
  const row = sessionRow(session({ name: "web-1-a" }), null);
  expect(row.getAttribute("target")).toBeNull();
  expect(row.getAttribute("rel")).toBeNull();
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

// --- statusLightRow：卡片头部的台阶灯 -----------------------------------------

test("带 stage 的 facet 画成固定几步的台阶，走过的绿、没走到的灰", async () => {
  const { statusLightRow } = await load();
  const row = statusLightRow([
    { dim: "jira.status", value: "Ready for Release", stage: { rank: 4, total: 6 } },
  ]);
  const dots = row.querySelectorAll(".status-dot");
  expect(dots.length).toBe(6);
  for (let i = 0; i < 6; i++) {
    const passed = i <= 4;
    expect(dots[i]!.classList.contains(passed ? "ok" : "dim")).toBe(true);
    expect(dots[i]!.classList.contains("filled")).toBe(passed);
  }
});

test("同一批 facet 里有 light 且 tone 是 warn 时，当前那一步改画成红色", async () => {
  const { statusLightRow } = await load();
  const row = statusLightRow([
    { dim: "jira.status", value: "In Progress", stage: { rank: 1, total: 6 } },
    { dim: "jira.checks", value: "1/2", tone: "warn", light: true },
  ]);
  const dots = row.querySelectorAll(".status-dot");
  // 走过的两步（0、1）里，当前所在的那一步（1）改红，之前的（0）仍然是绿。
  expect(dots[0]!.classList.contains("ok")).toBe(true);
  expect(dots[1]!.classList.contains("warn")).toBe(true);
  expect(dots[1]!.classList.contains("ok")).toBe(false);
  // 没走到的照旧灰，不受卡住信号影响。
  expect(dots[2]!.classList.contains("dim")).toBe(true);
});

test("light 的 tone 是 ok（一切正常）时不改色，台阶照常画", async () => {
  const { statusLightRow } = await load();
  const row = statusLightRow([
    { dim: "jira.status", value: "Done", stage: { rank: 5, total: 6 } },
    { dim: "jira.checks", value: "0/2", tone: "ok", light: true },
  ]);
  const dots = row.querySelectorAll(".status-dot");
  expect(dots[5]!.classList.contains("ok")).toBe(true);
  expect(dots[5]!.classList.contains("warn")).toBe(false);
});

test("没有 stage 时，light 的 facet 各自退回画一颗点，不会因为凑不到台阶就消失", async () => {
  const { statusLightRow } = await load();
  const row = statusLightRow([
    { dim: "jira.checks", value: "1/2", tone: "warn", light: true },
  ]);
  const dots = row.querySelectorAll(".status-dot");
  expect(dots.length).toBe(1);
  expect(dots[0]!.classList.contains("warn")).toBe(true);
});

test("既没有 stage 也没有 light 的 facet 不出现在灯带里", async () => {
  const { statusLightRow } = await load();
  const row = statusLightRow([{ dim: "jira.epic", value: "登录改版" }]);
  expect(row.querySelectorAll(".status-dot").length).toBe(0);
});

test("台阶带 title，说明是哪个维度的什么值——不靠颜色单独传达信息", async () => {
  const { statusLightRow } = await load();
  const row = statusLightRow([
    { dim: "jira.status", value: "Ready for Release", stage: { rank: 4, total: 6 } },
  ]);
  const dot = row.querySelectorAll(".status-dot")[4]!;
  expect(dot.getAttribute("title")).toContain("Ready for Release");
});

test("卡住的那一步点一下，打开的是卡住信号自己的明细，不是状态本身的明细", async () => {
  const { statusLightRow } = await load();
  const row = statusLightRow([
    { dim: "jira.status", value: "In Progress", stage: { rank: 1, total: 6 } },
    {
      dim: "jira.prs", value: "1", tone: "warn", light: true,
      detail: [{ label: "修登录页", value: "DECLINED" }],
    },
  ]);
  const dot = row.querySelectorAll(".status-dot")[1] as HTMLButtonElement;
  expect(dot.tagName).toBe("BUTTON");
  dot.click();
  const sheet = document.querySelector(".sheet-backdrop")!;
  expect(sheet).toBeTruthy();
  expect(sheet.textContent).toContain("DECLINED");
});

test("没有明细的台阶是静态的，不是按钮", async () => {
  const { statusLightRow } = await load();
  const row = statusLightRow([
    { dim: "jira.status", value: "Done", stage: { rank: 5, total: 6 } },
  ]);
  const dot = row.querySelectorAll(".status-dot")[5]!;
  expect(dot.tagName).toBe("SPAN");
});

test("itemHead 把台阶灯排进头部，跟着来源徽标之后", async () => {
  const { itemHead } = await load();
  const head = itemHead(
    { id: "it-1", title: "修登录页", source: { provider: "jira", ref: "AB-1" } },
    [
      { dim: "jira.status", value: "Done", stage: { rank: 5, total: 6 } },
      { dim: "jira.checks", value: "0/2", tone: "ok", light: true },
    ],
    0,
  );
  expect(head.querySelectorAll(".status-dot").length).toBe(6);
});

// --- openDetailSheet：group 字段按 PR 分组 -----------------------------------

test("连续同 group 的行只画一条组标题，不重复", async () => {
  const { openDetailSheet } = await load();
  openDetailSheet("检查: 1/3", [
    { label: "ci/test", value: "SUCCESSFUL", tone: "ok", group: "web-app · fix/login → main · OPEN" },
    { label: "ci/build", value: "FAILED", tone: "warn", group: "backend · fix/api → develop · MERGED" },
    { label: "ci/lint", value: "SUCCESSFUL", tone: "ok", group: "backend · fix/api → develop · MERGED" },
  ]);
  const titles = [...document.querySelectorAll(".detail-group-toggle")].map((n) => n.textContent);
  expect(titles).toEqual(["web-app · fix/login → main · OPEN", "backend · fix/api → develop · MERGED"]);
  expect(document.querySelectorAll(".detail-row").length).toBe(3);
});

test("没有 group 的行不画组标题", async () => {
  const { openDetailSheet } = await load();
  openDetailSheet("PR", [{ label: "修登录页", value: "OPEN" }]);
  expect(document.querySelector(".detail-group-toggle")).toBeNull();
  expect(document.querySelectorAll(".detail-row").length).toBe(1);
});

test("组默认展开，点标题折叠，再点一下展开回来", async () => {
  const { openDetailSheet } = await load();
  openDetailSheet("检查: 1/1", [
    { label: "ci/test", value: "SUCCESSFUL", tone: "ok", group: "web-app #371 · fix/login → main · OPEN" },
  ]);
  const head = document.querySelector(".detail-group-toggle") as HTMLButtonElement;
  const rows = document.querySelector(".detail-group-rows") as HTMLElement;

  expect(head.getAttribute("aria-expanded")).toBe("true");
  expect(rows.hidden).toBe(false);

  head.click();
  expect(head.getAttribute("aria-expanded")).toBe("false");
  expect(rows.hidden).toBe(true);

  head.click();
  expect(head.getAttribute("aria-expanded")).toBe("true");
  expect(rows.hidden).toBe(false);
});

test("折叠一个组不影响另一个组", async () => {
  const { openDetailSheet } = await load();
  openDetailSheet("检查: 2/2", [
    { label: "ci/test", value: "SUCCESSFUL", tone: "ok", group: "web-app #1 · a → main · OPEN" },
    { label: "ci/build", value: "SUCCESSFUL", tone: "ok", group: "backend #2 · b → main · OPEN" },
  ]);
  const [first, second] = [...document.querySelectorAll(".detail-group-toggle")] as HTMLButtonElement[];
  first!.click();
  expect(first!.getAttribute("aria-expanded")).toBe("false");
  expect(second!.getAttribute("aria-expanded")).toBe("true");
});

test("组带 groupUrl 时旁边有个链到原始地址的入口，跟折叠按钮并排不嵌套", async () => {
  const { openDetailSheet } = await load();
  openDetailSheet("检查: 1/1", [
    {
      label: "ci/test", value: "SUCCESSFUL", tone: "ok",
      group: "web-app #371 · fix/login → main · OPEN",
      groupUrl: "https://example.com/pr/371",
    },
  ]);
  const head = document.querySelector(".detail-group-head")!;
  const link = head.querySelector("a.detail-group-link") as HTMLAnchorElement;
  expect(link.href).toBe("https://example.com/pr/371");
  expect(link.target).toBe("_blank");
  expect(link.rel).toBe("noopener noreferrer");
  // 并排，不是嵌套：<a> 不能出现在 <button> 里面。
  expect(head.querySelector(".detail-group-toggle a")).toBeNull();
});

test("没有 groupUrl 就不画那个链接入口", async () => {
  const { openDetailSheet } = await load();
  openDetailSheet("检查: 1/1", [
    { label: "ci/test", value: "SUCCESSFUL", tone: "ok", group: "web-app #371 · fix/login → main · OPEN" },
  ]);
  expect(document.querySelector(".detail-group-link")).toBeNull();
});

// --- 明细行「发给会话」按钮：只在有 send 且恰好一个绑定会话时才出现 --------

test("有 send 且传了 sessionName 才画按钮", async () => {
  const { openDetailSheet } = await load();
  openDetailSheet("检查: 1/1", [
    { label: "ci/test", value: "FAILED", tone: "warn", send: "请修复 ci/test" },
  ], "web-1-a");
  const btn = document.querySelector(".detail-send") as HTMLButtonElement;
  expect(btn).not.toBeNull();
  expect(btn.textContent).toBe(tr("items.sendToSession"));
});

test("没有 send 就不画按钮，就算传了 sessionName", async () => {
  const { openDetailSheet } = await load();
  openDetailSheet("检查: 1/1", [{ label: "ci/test", value: "SUCCESSFUL", tone: "ok" }], "web-1-a");
  expect(document.querySelector(".detail-send")).toBeNull();
});

test("多会话或没有会话时不传 sessionName，按钮不出现", async () => {
  const { openDetailSheet } = await load();
  openDetailSheet("检查: 1/1", [
    { label: "ci/test", value: "FAILED", tone: "warn", send: "请修复 ci/test" },
  ], null);
  expect(document.querySelector(".detail-send")).toBeNull();
});

test("点击按钮把 send 文本发给传入的会话，成功后短暂反馈再恢复", async () => {
  const { openDetailSheet } = await load();
  const real = globalThis.fetch;
  const calls: { url: string; body: unknown }[] = [];
  (globalThis as any).fetch = async (u: unknown, init?: RequestInit) => {
    calls.push({ url: String(u), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(null, { status: 204 });
  };
  openDetailSheet("检查: 1/1", [
    { label: "ci/test", value: "FAILED", tone: "warn", send: "请修复 ci/test" },
  ], "web-1-a");
  const btn = document.querySelector(".detail-send") as HTMLButtonElement;
  btn.dispatchEvent(new (globalThis as any).window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  (globalThis as any).fetch = real;

  expect(calls.length).toBe(1);
  expect(calls[0]!.url).toContain("api/sessions/web-1-a/keys");
  expect(calls[0]!.body).toEqual({ text: "请修复 ci/test" });
  expect(btn.disabled).toBe(true);
  expect(btn.textContent).toBe(tr("items.sent"));
});

test("发送失败时提示错误，按钮重新可点", async () => {
  const { openDetailSheet } = await load();
  const real = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response(null, { status: 500 });
  openDetailSheet("检查: 1/1", [
    { label: "ci/test", value: "FAILED", tone: "warn", send: "请修复 ci/test" },
  ], "web-1-a");
  const btn = document.querySelector(".detail-send") as HTMLButtonElement;
  btn.dispatchEvent(new (globalThis as any).window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  (globalThis as any).fetch = real;

  expect(btn.disabled).toBe(false);
  expect(btn.textContent).toBe(tr("items.sendToSession"));
});

test("没有历史记录时 historySection 什么都不画", async () => {
  const { historySection } = await load();
  expect(historySection([])).toBeNull();
});

test("historySection 每条历史记录画一行，带上会话名", async () => {
  const { historySection } = await load();
  const section = historySection([
    { session: "甲", boundAt: NOW - 3600, endedAt: NOW - 1800 },
    { session: "乙", boundAt: NOW - 7200, endedAt: NOW - 6000 },
  ]);
  expect(section).not.toBeNull();
  expect(section!.textContent).toContain(tr("items.history"));
  const rows = section!.querySelectorAll(".item-history-row");
  expect(rows).toHaveLength(2);
  expect(rows[0]!.textContent).toContain("甲");
  expect(rows[1]!.textContent).toContain("乙");
});

test("仍是 open 的记录（endedAt 为 null）不该出现在历史区——调用方已经把它们过滤掉了，这里只管画", async () => {
  const { historyRow } = await load();
  const row = historyRow({ session: "甲", boundAt: NOW - 60, endedAt: NOW - 30 });
  expect(row.className).toBe("item-history-row");
  expect(row.textContent).toContain("甲");
});
