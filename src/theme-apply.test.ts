import { test, expect, afterAll } from "bun:test";
import { isLight, themeOf, themeVars, uiVars } from "../public/themes.js";

/**
 * theme-apply.js 摸 DOM、localStorage 和网络，所以它没有被 themes.test.ts 覆盖。
 * 这里验两件事：两组变量各自认各自的主题名，以及 color-scheme 跟着**界面**主题
 * 的极性走。
 *
 * DOM 垫片必须把它替换掉的全局还回去——Bun 在一个进程里跑所有测试文件，
 * 覆盖 fetch 那次弄红过别的文件里 38 条测试。
 */
const saved = {
  document: (globalThis as { document?: unknown }).document,
  localStorage: (globalThis as { localStorage?: unknown }).localStorage,
  fetch: globalThis.fetch,
};
afterAll(() => {
  Object.assign(globalThis, saved);
});

/** 装一层 DOM 垫片，返回被写到 :root 上的东西。 */
async function mount() {
  const style = new Map<string, string>();
  const dataset: Record<string, string> = {};
  Object.assign(globalThis, {
    document: {
      documentElement: {
        style: { setProperty: (k: string, v: string) => void style.set(k, v) },
        dataset,
      },
    },
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  const { applyTheme } = await import("../public/theme-apply.js");
  return { applyTheme, style, dataset };
}

test("color-scheme 跟着界面主题的极性走", async () => {
  const { applyTheme, style } = await mount();

  applyTheme("tokyo-night", "tokyo-night");
  expect(isLight(themeOf("tokyo-night"))).toBe(false);
  expect(style.get("color-scheme")).toBe("dark");

  applyTheme("catppuccin-latte", "catppuccin-latte");
  expect(isLight(themeOf("catppuccin-latte"))).toBe(true);
  expect(style.get("color-scheme")).toBe("light");

  // 决定权在界面那半：原生滚动条、<select> 弹层、日期选择器都是外壳，不是画布。
  applyTheme("tokyo-night", "catppuccin-latte");
  expect(style.get("color-scheme")).toBe("light");
  applyTheme("catppuccin-latte", "tokyo-night");
  expect(style.get("color-scheme")).toBe("dark");
});

// 只给一个名字时两组都用它——老设备的缓存里只有终端那个键，缺的那半不该变成默认。
test("省略界面主题时跟着终端走", async () => {
  const { applyTheme, style, dataset } = await mount();
  applyTheme("nord");
  expect(style.get("--surface-1")).toBe(uiVars("nord")["--surface-1"]);
  expect(dataset.theme).toBe("nord");
  expect(dataset.termTheme).toBe("nord");
});

test("两组变量各自认各自的主题", async () => {
  const { applyTheme, style, dataset } = await mount();
  applyTheme("nord", "catppuccin-latte");

  // 终端调色板来自第一个名字。
  expect(style.get("--term-bg")).toBe(themeVars("nord")["--term-bg"]);
  expect(style.get("--term-fg")).toBe(themeVars("nord")["--term-fg"]);
  // 页面角色色来自第二个。
  for (const key of ["--surface-1", "--surface-4", "--text-1", "--text-2", "--accent"]) {
    expect([key, style.get(key)]).toEqual([key, uiVars("catppuccin-latte")[key]]);
  }
  // 而且真的不一样——两个名字选得对，这条断言才有意义。
  expect(style.get("--surface-1")).not.toBe(uiVars("nord")["--surface-1"]);

  // 两个 attribute，因为读它们的是两拨代码：设置页要知道各自选中哪一款。
  expect(dataset.termTheme).toBe("nord");
  expect(dataset.theme).toBe("catppuccin-latte");
});
