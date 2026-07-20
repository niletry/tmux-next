import { test, expect } from "bun:test";
import { COLS, ROWS, sanitiseGeometry } from "./geometry";

test("a normal phone geometry passes through untouched", () => {
  expect(sanitiseGeometry(80, 24)).toEqual({ cols: 80, rows: 24 });
});

test("a wide desktop geometry passes through untouched", () => {
  expect(sanitiseGeometry(212, 58)).toEqual({ cols: 212, rows: 58 });
});

test("a newline in a dimension cannot reach the tmux command", () => {
  // control mode separates commands by newline, so an unchecked value here is
  // arbitrary tmux execution: `refresh-client -C 80,24\nkill-server`.
  expect(sanitiseGeometry(80, "24\nkill-server")).toEqual({ cols: 80, rows: ROWS.fallback });
  expect(sanitiseGeometry("80\nkill-server", 24)).toEqual({ cols: COLS.fallback, rows: 24 });
});

test("a non-numeric dimension falls back rather than throwing", () => {
  expect(sanitiseGeometry("abc", null)).toEqual({ cols: COLS.fallback, rows: ROWS.fallback });
  expect(sanitiseGeometry(undefined, {})).toEqual({ cols: COLS.fallback, rows: ROWS.fallback });
});

test("an absent dimension means no preference, not the narrowest window", () => {
  // Regression: clamping undefined to the minimum handed a client that omitted
  // cols a 20-column window, which is what every pre-cols client sends.
  expect(sanitiseGeometry(undefined, 24)).toEqual({ cols: COLS.fallback, rows: 24 });
  expect(COLS.fallback).toBe(80);
});

test("a fractional dimension is floored to a whole cell count", () => {
  expect(sanitiseGeometry(80.9, 24.9)).toEqual({ cols: 80, rows: 24 });
});

test("an absurd dimension is clamped, not rejected", () => {
  // A 100000-column window would make tmux allocate a screen to match.
  expect(sanitiseGeometry(100000, 100000)).toEqual({ cols: COLS.max, rows: ROWS.max });
});

test("zero and negative dimensions clamp to the minimum", () => {
  // A real number, just an unusable one — clamp rather than second-guess it.
  expect(sanitiseGeometry(0, -5)).toEqual({ cols: COLS.min, rows: ROWS.min });
});

test("the result is always safe to interpolate into a command", () => {
  const hostile = ["80\nkill-server", "1e9", "0x50", " 80 ", "80;ls", Infinity, NaN];
  for (const value of hostile) {
    const { cols, rows } = sanitiseGeometry(value, value);
    expect(Number.isInteger(cols)).toBe(true);
    expect(Number.isInteger(rows)).toBe(true);
    expect(`${cols},${rows}`).toMatch(/^\d+,\d+$/);
  }
});
