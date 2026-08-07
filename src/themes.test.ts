import { test, expect } from "bun:test";
// A browser module, but a `// @ts-check`ed one — its JSDoc types are real.
import {
  THEMES,
  THEME_ORDER,
  DEFAULT_THEME,
  ANSI_NAMES,
  themeOf,
  themeVars,
  xtermTheme,
} from "../public/themes.js";

/**
 * Relative luminance, WCAG 2.x.
 *
 * Reimplemented here rather than imported from the module under test: a bug in
 * a shared helper would cancel itself out and every ratio would pass.
 */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const names = Object.keys(THEMES);
const HEX = /^#[0-9a-f]{6}$/;

test("the picker order covers exactly the defined themes", () => {
  expect([...THEME_ORDER].sort()).toEqual([...names].sort());
});

test("the default theme exists", () => {
  expect(names).toContain(DEFAULT_THEME);
});

test.each(names)("%s defines every colour as #rrggbb", (name) => {
  const t = THEMES[name]!;
  expect(t.ansi).toHaveLength(16);
  const all = [
    t.background, t.foreground, t.cursor, t.cursorAccent,
    t.selectionBackground, t.onAccent, ...t.ansi,
  ];
  for (const c of all) expect(c).toMatch(HEX);
  expect(t.label.length).toBeGreaterThan(0);
});

/**
 * The contrast floors, and why they sit where they do.
 *
 * WCAG AA, not AAA. Measured against their own backgrounds One Dark's
 * foreground is 6.6:1 and two of Nord's colours land under 4.5:1 — an AAA bar
 * would fail two of the four established palettes, which means the bar is
 * wrong, not the palettes. AA still catches what actually hurts: every one of
 * these themes ships an upstream bright black between 1.69:1 and 2.46:1, and
 * that is the colour Claude Code draws its secondary text in.
 */
const FG_MIN = 4.5;      // body text
const COLOUR_MIN = 3.0;  // short coloured marks: ✓ ✗ filenames, single glyphs
const DIM_MIN = 3.0;     // bright black — secondary text, the whole point

test.each(names)("%s: foreground is readable on its background", (name) => {
  const t = THEMES[name]!;
  expect(contrast(t.foreground, t.background)).toBeGreaterThanOrEqual(FG_MIN);
});

test.each(names)("%s: bright black is readable as secondary text", (name) => {
  const t = THEMES[name]!;
  expect(contrast(t.ansi[8]!, t.background)).toBeGreaterThanOrEqual(DIM_MIN);
});

/**
 * Black gets an identity check, not a contrast floor.
 *
 * In a dark palette colour 0 *is* the darkest ink — programs use it for fills,
 * shadows and rules, not for text, and all four upstream palettes put it at or
 * below their own background (Tokyo Night's is 1.05:1). Demanding contrast here
 * would mean rejecting the convention rather than enforcing readability.
 *
 * What is worth rejecting is black being byte-identical to the background, as
 * One Dark ships it: then a rule drawn in colour 0 is not dim, it is absent.
 */
test.each(names)("%s: black is not literally the background", (name) => {
  const t = THEMES[name]!;
  expect(t.ansi[0]).not.toBe(t.background);
});

test.each(names)("%s: every chromatic colour clears the floor", (name) => {
  const t = THEMES[name]!;
  // Slots 1-6 and 9-14: the six hues in both normal and bright form. Black,
  // white and their bright forms are covered by the tests above or are plain
  // foreground-grade greys.
  const chromatic = [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14];
  // Collected rather than asserted one by one: a failure then names every slot
  // that fell short and by how much, instead of stopping at the first.
  const short = chromatic
    .map((i) => ({ slot: ANSI_NAMES[i]!, ratio: contrast(t.ansi[i]!, t.background) }))
    .filter((r) => r.ratio < COLOUR_MIN)
    .map((r) => `${r.slot} ${r.ratio.toFixed(2)}:1`);
  expect(short).toEqual([]);
});

test.each(names)("%s: on-accent text is readable on the accent fill", (name) => {
  const t = THEMES[name]!;
  // --accent is the theme's blue; onAccent is pressed onto it in buttons and chips.
  expect(contrast(t.onAccent, t.ansi[4]!)).toBeGreaterThanOrEqual(FG_MIN);
});

test.each(names)("%s: the cursor is visible and its accent readable under it", (name) => {
  const t = THEMES[name]!;
  expect(contrast(t.cursor, t.background)).toBeGreaterThanOrEqual(COLOUR_MIN);
  // A block cursor inverts: cursorAccent is the glyph drawn on top of it. One
  // glyph under a cursor is a non-text mark, not body copy, so it takes the
  // 3:1 floor — One Dark's upstream #528bff cursor lands at 4.33:1 and holding
  // it to 4.5 would mean recolouring the theme to satisfy the wrong rule.
  expect(contrast(t.cursorAccent, t.cursor)).toBeGreaterThanOrEqual(COLOUR_MIN);
});

test.each(names)("%s: selected text stays legible", (name) => {
  const t = THEMES[name]!;
  // selectionForeground is deliberately unset, so the text keeps its own
  // colour over the selection fill. Foreground-on-selection is the case that
  // has to hold for ordinary output.
  expect(contrast(t.foreground, t.selectionBackground)).toBeGreaterThanOrEqual(COLOUR_MIN);
});

test("themeOf falls back rather than returning undefined", () => {
  expect(themeOf("no-such-theme")).toBe(THEMES[DEFAULT_THEME]!);
  expect(themeOf(null)).toBe(THEMES[DEFAULT_THEME]!);
  expect(themeOf(undefined)).toBe(THEMES[DEFAULT_THEME]!);
  expect(themeOf("nord")).toBe(THEMES.nord!);
});

test.each(names)("%s: themeVars emits one variable per colour", (name) => {
  const vars = themeVars(name);
  for (const slot of ANSI_NAMES) expect(vars[`--term-${slot}`]).toMatch(HEX);
  for (const key of ["--term-bg", "--term-fg", "--term-cursor", "--term-cursor-accent",
                     "--term-selection", "--on-accent"]) {
    expect(vars[key]).toMatch(HEX);
  }
  expect(Object.keys(vars)).toHaveLength(ANSI_NAMES.length + 6);
});

/**
 * Guards the field list against xterm's ITheme, which has 23 properties. We set
 * 21: extendedAnsi and selectionForeground are left to xterm on purpose (see
 * xtermTheme). A missing field here means a colour silently falls back to
 * xterm's Tango default — exactly the bug this whole change exists to fix.
 */
test.each(names)("%s: xtermTheme covers every field we intend to set", (name) => {
  const theme = xtermTheme(name);
  const expected = [
    "background", "foreground", "cursor", "cursorAccent", "selectionBackground",
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "brightBlack", "brightRed", "brightGreen", "brightYellow",
    "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
  ];
  expect(Object.keys(theme).sort()).toEqual([...expected].sort());
  for (const v of Object.values(theme)) expect(v).toMatch(HEX);
});
