import { test, expect, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { readTheme, writeTheme, isKnownTheme, themePath } from "./theme";
import { DEFAULT_THEME } from "../public/themes.js";

// A throwaway path per run, so the suite never reads or writes the real
// ~/.tmux-next/theme.json. Read lazily by the module, so setting it here is
// enough — same discipline as the other state modules.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "theme-test-"));
  process.env.TMUX_NEXT_THEME_PATH = join(dir, "theme.json");
});

test("the path follows the environment override", () => {
  expect(themePath()).toBe(join(dir, "theme.json"));
});

test("a missing file reads as the default", async () => {
  expect(await readTheme()).toEqual({ name: DEFAULT_THEME, ui: DEFAULT_THEME });
});

test("a stored name round-trips", async () => {
  expect(await writeTheme({ name: "nord" })).toBe(true);
  expect(await readTheme()).toEqual({ name: "nord", ui: "nord" });
});

// 这一条是「不需要迁移」的全部理由：升级前写下的文件只有 name，读出来 ui 等于它,
// 于是老机器升级后一个像素都不变。ui 缺失回落到 name，而不是回落到默认主题。
test("只有 name 的老文件，界面外观跟着终端走", async () => {
  await Bun.write(themePath(), JSON.stringify({ name: "nord" }));
  expect(await readTheme()).toEqual({ name: "nord", ui: "nord" });
});

test("两个名字各自往返", async () => {
  expect(await writeTheme({ name: "nord", ui: "catppuccin-latte" })).toBe(true);
  expect(await readTheme()).toEqual({ name: "nord", ui: "catppuccin-latte" });
});

// 设置页一次只点一款，发上来的补丁就只有一个字段。合并而不是覆盖，否则改界面
// 会把终端调色板悄悄打回默认。
test("只写一个字段不动另一个", async () => {
  await writeTheme({ name: "nord", ui: "catppuccin-latte" });
  expect(await writeTheme({ ui: "one-dark" })).toBe(true);
  expect(await readTheme()).toEqual({ name: "nord", ui: "one-dark" });
  expect(await writeTheme({ name: "tokyo-night" })).toBe(true);
  expect(await readTheme()).toEqual({ name: "tokyo-night", ui: "one-dark" });
});

test("an unknown name is refused and nothing is written", async () => {
  expect(await writeTheme({ name: "solarized-mango" })).toBe(false);
  expect(await readTheme()).toEqual({ name: DEFAULT_THEME, ui: DEFAULT_THEME });
});

// 一半写进去一半没写，是那种事后没人能解释的状态。
test("补丁里有一个字段不认识就整份拒掉", async () => {
  await writeTheme({ name: "nord", ui: "nord" });
  expect(await writeTheme({ name: "one-dark", ui: "solarized-mango" })).toBe(false);
  expect(await readTheme()).toEqual({ name: "nord", ui: "nord" });
});

test("non-string input is refused", async () => {
  for (const bad of [null, undefined, 42, "nord", ["nord"], true, {}, { name: 42 }, { ui: {} }]) {
    expect(await writeTheme(bad)).toBe(false);
  }
});

test("unreadable JSON reads as the default rather than throwing", async () => {
  await Bun.write(themePath(), "{ not json");
  expect(await readTheme()).toEqual({ name: DEFAULT_THEME, ui: DEFAULT_THEME });
});

test("a name from a build that no longer ships it falls back", async () => {
  // Written directly, bypassing writeTheme's guard — this is the on-disk state
  // left behind if a theme is ever removed from themes.js.
  await Bun.write(themePath(), JSON.stringify({ name: "retired-theme", ui: "retired-theme" }));
  expect(await readTheme()).toEqual({ name: DEFAULT_THEME, ui: DEFAULT_THEME });
});

// 只有 ui 那半退役了：终端那半仍然是有效的选择，不该被一起打回默认——而 ui 的
// 回落对象是 name，不是默认主题，跟老文件那条走的是同一条路。
test("只有一个字段退役时，另一个字段照常", async () => {
  await Bun.write(themePath(), JSON.stringify({ name: "nord", ui: "retired-theme" }));
  expect(await readTheme()).toEqual({ name: "nord", ui: "nord" });
});

test("a file with no name field falls back", async () => {
  await Bun.write(themePath(), JSON.stringify({ theme: "nord" }));
  expect(await readTheme()).toEqual({ name: DEFAULT_THEME, ui: DEFAULT_THEME });
});

test("isKnownTheme accepts what we ship and nothing else", () => {
  expect(isKnownTheme("tokyo-night")).toBe(true);
  expect(isKnownTheme("nord")).toBe(true);
  expect(isKnownTheme("no-such")).toBe(false);
  expect(isKnownTheme(null)).toBe(false);
  // Guards against a prototype key passing as a theme name.
  expect(isKnownTheme("toString")).toBe(false);
  expect(isKnownTheme("constructor")).toBe(false);
});
