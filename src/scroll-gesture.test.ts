import { test, expect } from "bun:test";
// A browser module, but a `// @ts-check`ed one — its JSDoc types are real.
import { createGesture, createPager } from "../public/scroll-gesture.js";

const LINE = 20;

test("dragging down by one line scrolls one line toward older output", () => {
  const g = createGesture({ lineHeight: LINE });
  g.start(100);
  expect(g.move(100 + LINE)).toBe(1);
});

test("dragging up scrolls toward newer output", () => {
  const g = createGesture({ lineHeight: LINE });
  g.start(100);
  expect(g.move(100 - LINE)).toBe(-1);
});

test("movement shorter than one line scrolls nothing", () => {
  const g = createGesture({ lineHeight: LINE });
  g.start(100);
  expect(g.move(100 + LINE - 1)).toBe(0);
});

test("leftover movement carries into the next move", () => {
  const g = createGesture({ lineHeight: LINE });
  g.start(100);
  // 1.5 lines: one line now, half a line banked.
  expect(g.move(100 + LINE * 1.5)).toBe(1);
  // Another half line completes the second one.
  expect(g.move(100 + LINE * 2)).toBe(1);
});

test("a long drag reports every line it crossed", () => {
  const g = createGesture({ lineHeight: LINE });
  g.start(100);
  expect(g.move(100 + LINE * 3)).toBe(3);
});

test("a touch that barely moved is a tap", () => {
  const g = createGesture({ lineHeight: LINE, tapSlop: 10 });
  g.start(100);
  g.move(105);
  expect(g.end().tap).toBe(true);
});

test("a touch that moved past the slop is not a tap", () => {
  const g = createGesture({ lineHeight: LINE, tapSlop: 10 });
  g.start(100);
  g.move(130);
  expect(g.end().tap).toBe(false);
});

test("a drag that returns to its origin is still not a tap", () => {
  const g = createGesture({ lineHeight: LINE, tapSlop: 10 });
  g.start(100);
  g.move(160);
  g.move(100);
  expect(g.end().tap).toBe(false);
});

test("scrolling fewer lines than a page sends no page key", () => {
  const p = createPager({ pageLines: 10 });
  expect(p.take(3)).toBe(0);
});

test("scrolling a full page sends one page key", () => {
  const p = createPager({ pageLines: 10 });
  expect(p.take(10)).toBe(1);
});

test("lines accumulate across calls until they make a page", () => {
  const p = createPager({ pageLines: 10 });
  p.take(6);
  expect(p.take(4)).toBe(1);
});

test("scrolling back the other way cancels banked lines", () => {
  const p = createPager({ pageLines: 10 });
  p.take(6);
  p.take(-6);
  expect(p.take(4)).toBe(0);
});

test("a page key in the other direction is negative", () => {
  const p = createPager({ pageLines: 10 });
  expect(p.take(-10)).toBe(-1);
});
