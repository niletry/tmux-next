import { test, expect, afterEach } from "bun:test";
import { Window } from "happy-dom";

/**
 * `opensInNewTab`/`applyTerminalLinkTarget` 读的是 `window.matchMedia("(pointer: fine)")`，
 * 跟这个项目里所有"这是不是触屏设备"的判断用同一个信号——不判断屏幕宽度，
 * 不嗅探 UA。用一个假 `matchMedia` 分别摆出两种设备来测两条分支。
 *
 * 挂在 `window` 上而不是当全局裸标识符调用：这个仓库里别的页面测试
 * （item-card.test.ts 等）只还原 `window`/`document` 两个全局，裸的 `matchMedia`
 * 不在那份约定里，挂在 `window` 上才能跟那份约定共用同一套 patch/还原。
 */

const PATCHED = ["window", "document"] as const;
const saved = new Map<string, unknown>();

function withPointerFine(fine: boolean) {
  const win = new Window({ url: "http://127.0.0.1:7682/terminal.html" });
  for (const key of PATCHED) {
    if (key in globalThis) saved.set(key, (globalThis as Record<string, unknown>)[key]);
  }
  // @ts-expect-error 覆盖 happy-dom 自带的 matchMedia：它不认识 pointer/hover
  // 这类特性查询，用真实实现测不出两条分支。
  win.matchMedia = (query) => ({ matches: query === "(pointer: fine)" ? fine : false, media: query });
  Object.defineProperty(globalThis, "window", { value: win, writable: true, configurable: true });
  Object.defineProperty(globalThis, "document", { value: win.document, writable: true, configurable: true });
}

// 不还原就会把假 document 留给同一个进程里的别的测试文件——public/ 的渲染测试
// 已经因为漏还原全局对象一次性弄红过 38 条测试。
afterEach(() => {
  for (const key of PATCHED) {
    if (saved.has(key)) {
      Object.defineProperty(globalThis, key, { value: saved.get(key), writable: true, configurable: true });
    } else {
      delete (globalThis as Record<string, unknown>)[key];
    }
  }
  saved.clear();
});

test("有精确指针（鼠标/触控板）：opensInNewTab 为 true", async () => {
  withPointerFine(true);
  const { opensInNewTab } = await import("../public/pointer-mode.js" + "?fine-true");
  expect(opensInNewTab()).toBe(true);
});

test("没有精确指针（纯触屏）：opensInNewTab 为 false", async () => {
  withPointerFine(false);
  const { opensInNewTab } = await import("../public/pointer-mode.js" + "?fine-false");
  expect(opensInNewTab()).toBe(false);
});

test("有精确指针：applyTerminalLinkTarget 设置新标签页 + noopener", async () => {
  withPointerFine(true);
  const { applyTerminalLinkTarget } = await import("../public/pointer-mode.js" + "?apply-true");
  const link = document.createElement("a");
  applyTerminalLinkTarget(link);
  expect(link.target).toBe("_blank");
  expect(link.rel).toBe("noopener noreferrer");
});

test("没有精确指针：applyTerminalLinkTarget 什么都不设，原地跳转", async () => {
  withPointerFine(false);
  const { applyTerminalLinkTarget } = await import("../public/pointer-mode.js" + "?apply-false");
  const link = document.createElement("a");
  applyTerminalLinkTarget(link);
  expect(link.target).toBe("");
  expect(link.rel).toBe("");
});
