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
  expect(await readTheme()).toBe(DEFAULT_THEME);
});

test("a stored name round-trips", async () => {
  expect(await writeTheme("nord")).toBe(true);
  expect(await readTheme()).toBe("nord");
});

test("an unknown name is refused and nothing is written", async () => {
  expect(await writeTheme("solarized-mango")).toBe(false);
  expect(await readTheme()).toBe(DEFAULT_THEME);
});

test("non-string input is refused", async () => {
  for (const bad of [null, undefined, 42, {}, ["nord"], true]) {
    expect(await writeTheme(bad)).toBe(false);
  }
});

test("unreadable JSON reads as the default rather than throwing", async () => {
  await Bun.write(themePath(), "{ not json");
  expect(await readTheme()).toBe(DEFAULT_THEME);
});

test("a name from a build that no longer ships it falls back", async () => {
  // Written directly, bypassing writeTheme's guard — this is the on-disk state
  // left behind if a theme is ever removed from themes.js.
  await Bun.write(themePath(), JSON.stringify({ name: "retired-theme" }));
  expect(await readTheme()).toBe(DEFAULT_THEME);
});

test("a file with no name field falls back", async () => {
  await Bun.write(themePath(), JSON.stringify({ theme: "nord" }));
  expect(await readTheme()).toBe(DEFAULT_THEME);
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
