import { test, expect, afterAll } from "bun:test";
import { isLight, themeOf } from "../public/themes.js";

/**
 * theme-apply.js 摸 DOM、localStorage 和网络，所以它没有被 themes.test.ts 覆盖。
 * 这里只验一件事：color-scheme 跟着主题的极性走。
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

test("color-scheme 跟着主题的极性走", async () => {
  const style = new Map<string, string>();
  Object.assign(globalThis, {
    document: {
      documentElement: {
        style: { setProperty: (k: string, v: string) => void style.set(k, v) },
        dataset: {} as Record<string, string>,
      },
    },
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  const { applyTheme } = await import("../public/theme-apply.js");

  applyTheme("tokyo-night");
  expect(isLight(themeOf("tokyo-night"))).toBe(false);
  expect(style.get("color-scheme")).toBe("dark");

  applyTheme("catppuccin-latte");
  expect(isLight(themeOf("catppuccin-latte"))).toBe(true);
  expect(style.get("color-scheme")).toBe("light");
});
