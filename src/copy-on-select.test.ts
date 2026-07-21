import { test, expect } from "bun:test";
// A browser module, but a `// @ts-check`ed one — its JSDoc types are real.
import { createCopyGate } from "../public/copy-on-select.js";

test("a fresh non-empty selection copies", () => {
  const gate = createCopyGate();
  expect(gate.shouldCopy("hello")).toBe(true);
});

test("an empty selection never copies", () => {
  const gate = createCopyGate();
  expect(gate.shouldCopy("")).toBe(false);
});

test("the same selection is not copied twice in a row", () => {
  // xterm fires selection-change many times as a drag settles; the clipboard
  // should be written once, not on every event.
  const gate = createCopyGate();
  expect(gate.shouldCopy("line")).toBe(true);
  expect(gate.shouldCopy("line")).toBe(false);
  expect(gate.shouldCopy("line")).toBe(false);
});

test("a growing drag copies each new extent", () => {
  const gate = createCopyGate();
  expect(gate.shouldCopy("l")).toBe(true);
  expect(gate.shouldCopy("li")).toBe(true);
  expect(gate.shouldCopy("lin")).toBe(true);
});

test("clearing then re-selecting the same text copies again", () => {
  // Clearing resets the guard, so a deliberate re-select is honoured rather
  // than swallowed as a duplicate.
  const gate = createCopyGate();
  expect(gate.shouldCopy("same")).toBe(true);
  expect(gate.shouldCopy("")).toBe(false);
  expect(gate.shouldCopy("same")).toBe(true);
});

test("null is treated as empty, not a crash", () => {
  const gate = createCopyGate();
  // @ts-expect-error - exercising a defensive path
  expect(gate.shouldCopy(null)).toBe(false);
});
