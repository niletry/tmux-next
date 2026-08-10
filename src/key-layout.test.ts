import { test, expect } from "bun:test";
// A browser module, but a `// @ts-check`ed one — its JSDoc types are real.
import { ROWS, normaliseLayout, defaultLayout } from "../public/key-layout.js";

const DEFAULT = defaultLayout();

test("nothing stored means the default layout", () => {
  expect(normaliseLayout(null)).toEqual(DEFAULT);
  expect(normaliseLayout(undefined)).toEqual(DEFAULT);
  expect(normaliseLayout("garbage")).toEqual(DEFAULT);
  expect(normaliseLayout(42)).toEqual(DEFAULT);
});

test("a valid stored layout is preserved in its stored order", () => {
  const layout = normaliseLayout({
    primary: ["enter", "esc", "up", "down", "tab", "shift-tab"],
    nav: ["right", "left", "ctrl", "ctrl-c"],
    tools: ["paste", "copy", "img", "kbd", "font-inc", "font-dec"],
  });
  expect(layout.primary).toEqual(["enter", "esc", "up", "down", "tab", "shift-tab"]);
  expect(layout.nav).toEqual(["right", "left", "ctrl", "ctrl-c"]);
  expect(layout.tools).toEqual(["paste", "copy", "img", "kbd", "font-inc", "font-dec"]);
});

test("unknown keys are dropped, not kept", () => {
  const layout = normaliseLayout({
    primary: ["esc", "bogus", "up", ""],
    nav: [],
    tools: [],
  });
  expect(layout.primary).toEqual(["esc", "up"]);
});

test("a key mentioned twice collapses to one copy", () => {
  const layout = normaliseLayout({
    primary: ["esc", "esc", "esc"],
    nav: [],
    tools: [],
  });
  expect(layout.primary.filter((k) => k === "esc")).toHaveLength(1);
});

test("a key may live on a row other than its default — the whole board is one drop zone", () => {
  const layout = normaliseLayout({
    primary: ["tab", "shift-tab", "up", "down", "enter"], // esc dragged away
    nav: [],
    tools: ["esc", "kbd", "mic", "img", "paste", "copy", "font-dec", "font-inc"],
  });
  expect(layout.primary).toEqual(["tab", "shift-tab", "up", "down", "enter"]);
  expect(layout.tools).toEqual(["esc", "kbd", "mic", "img", "paste", "copy", "font-dec", "font-inc"]);
});

test("a row the user emptied stays empty — nothing is forced back", () => {
  const layout = normaliseLayout({
    primary: [],
    nav: ["ctrl", "ctrl-c", "left", "right"],
    tools: [],
  });
  expect(layout.primary).toEqual([]);
  expect(layout.nav).toEqual(["ctrl", "ctrl-c", "left", "right"]);
  expect(layout.tools).toEqual([]);
});

test("keys end up exactly as stored: no duplicates, no unknown keys", () => {
  const raw = {
    primary: ["esc", "esc", "bogus", "tab", ""],
    nav: ["right", "ctrl", "ctrl", "left", "ctrl-c"],
    tools: [],
  };
  const layout = normaliseLayout(raw);
  expect(layout.primary).toEqual(["esc", "tab"]);
  expect(layout.nav).toEqual(["right", "ctrl", "left", "ctrl-c"]);
  expect(layout.tools).toEqual([]);
});
