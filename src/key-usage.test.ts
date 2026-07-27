import { test, expect } from "bun:test";
import { sanitiseCounts, mergeCounts } from "./key-usage";

test("keeps well-formed label/count pairs", () => {
  expect(sanitiseCounts({ enter: 3, "ctrl-c": 1 })).toEqual({ enter: 3, "ctrl-c": 1 });
});

test("floors fractional counts and drops non-positive ones", () => {
  expect(sanitiseCounts({ up: 2.9, down: 0, left: -5 })).toEqual({ up: 2 });
});

test("refuses labels that are not the boring allow-listed shape", () => {
  const cleaned = sanitiseCounts({
    Enter: 1, // uppercase
    "a b": 1, // space
    "../etc": 1, // path-ish
    "": 1, // empty
    ["x".repeat(41)]: 1, // too long
  });
  expect(cleaned).toEqual({});
});

test("ignores non-number counts", () => {
  expect(sanitiseCounts({ tab: "5", esc: null, up: {} })).toEqual({});
});

test("caps an absurd single count", () => {
  expect(sanitiseCounts({ enter: 999_999_999 }).enter).toBe(100_000);
});

test("returns empty for non-objects", () => {
  expect(sanitiseCounts(null)).toEqual({});
  expect(sanitiseCounts("enter")).toEqual({});
  expect(sanitiseCounts(42)).toEqual({});
});

test("merge adds deltas onto the running total", () => {
  expect(mergeCounts({ enter: 10, esc: 2 }, { enter: 3, tab: 1 })).toEqual({
    enter: 13,
    esc: 2,
    tab: 1,
  });
});

test("merge does not mutate its inputs", () => {
  const total = { enter: 1 };
  mergeCounts(total, { enter: 1 });
  expect(total).toEqual({ enter: 1 });
});
