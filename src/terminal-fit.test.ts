import { test, expect } from "bun:test";
// @ts-expect-error - plain browser module, no types
import { MAX_FONT_PX, MIN_COLUMNS, computeGeometry } from "../public/terminal-fit.js";

// Menlo/SFMono advance width, the value xterm measures in practice.
const RATIO = 0.6;
const geo = (width: number, height = 900) =>
  computeGeometry({ width, height, ratio: RATIO, lineHeight: 1.2 });

test("a phone shrinks the font so exactly 80 columns fit", () => {
  const { cols, fontSize } = geo(390);
  expect(cols).toBe(MIN_COLUMNS);
  expect(fontSize).toBe(Math.floor(390 / MIN_COLUMNS / RATIO));
});

test("every common phone width stays at 80 columns", () => {
  // The mobile contract: changing MAX_FONT_PX must never cost the phone columns.
  for (const width of [320, 360, 390, 414, 430]) {
    expect(geo(width).cols).toBe(MIN_COLUMNS);
  }
});

test("a desktop pins the font at the cap rather than growing it", () => {
  expect(geo(1600).fontSize).toBe(MAX_FONT_PX);
  expect(geo(2560).fontSize).toBe(MAX_FONT_PX);
});

test("a desktop spends the leftover width on columns", () => {
  const { cols } = geo(1600);
  expect(cols).toBe(Math.floor(1600 / (MAX_FONT_PX * RATIO)));
  expect(cols).toBeGreaterThan(MIN_COLUMNS);
});

test("a wider window yields more columns at the same font size", () => {
  const narrow = geo(1200);
  const wide = geo(1900);
  expect(wide.fontSize).toBe(narrow.fontSize);
  expect(wide.cols).toBeGreaterThan(narrow.cols);
});

test("the two regimes meet where 80 columns need exactly the cap", () => {
  // Below the switch the font is still growing; above it, columns are.
  const boundary = MIN_COLUMNS * MAX_FONT_PX * RATIO;
  expect(geo(boundary - 20).cols).toBe(MIN_COLUMNS);
  expect(geo(boundary + 200).cols).toBeGreaterThan(MIN_COLUMNS);
  expect(geo(boundary + 200).fontSize).toBe(MAX_FONT_PX);
});

test("the grid never drops below the readable floor", () => {
  const tiny = geo(120, 100);
  expect(tiny.cols).toBeGreaterThanOrEqual(MIN_COLUMNS);
  expect(tiny.fontSize).toBeGreaterThanOrEqual(6);
  expect(tiny.rows).toBeGreaterThanOrEqual(8);
});

test("rows follow the height and the chosen font", () => {
  const { rows, fontSize } = geo(1600, 900);
  expect(rows).toBe(Math.floor(900 / (fontSize * 1.2)));
});

test("every geometry is a pair of whole cells", () => {
  for (const width of [320, 390, 768, 1024, 1600, 2560, 3840]) {
    const { cols, rows, fontSize } = geo(width);
    expect(Number.isInteger(cols)).toBe(true);
    expect(Number.isInteger(rows)).toBe(true);
    expect(Number.isInteger(fontSize)).toBe(true);
  }
});
