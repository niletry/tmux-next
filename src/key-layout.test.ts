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
  expect(layout.tools).toEqual(["paste", "copy", "img", "kbd", "font-inc", "font-dec", "mic"]);
});

test("unknown keys are dropped, not kept", () => {
  const layout = normaliseLayout({
    primary: ["esc", "bogus", "up", ""],
    nav: [],
    tools: [],
  });
  expect(layout.primary).toEqual(["esc", "up", "tab", "shift-tab", "down", "enter"]);
});

test("a key mentioned twice collapses to one copy", () => {
  const layout = normaliseLayout({
    primary: ["esc", "esc", "esc"],
    nav: [],
    tools: [],
  });
  expect(layout.primary.filter((k) => k === "esc")).toHaveLength(1);
});

test("a missing row restores every key, in default order", () => {
  const layout = normaliseLayout({ primary: ["enter"] });
  expect(layout.primary).toEqual(["enter", "esc", "tab", "shift-tab", "up", "down"]);
  expect(layout.nav).toEqual([...ROWS.nav]);
  expect(layout.tools).toEqual([...ROWS.tools]);
});

test("a key in the wrong row is not duplicated when its home row is filled", () => {
  // enter appears in tools (wrong row); the primary row must still end up
  // complete, and tools must not hold two copies of enter.
  const layout = normaliseLayout({
    primary: ["esc", "tab", "shift-tab", "up", "down"],
    nav: [],
    tools: ["enter", "paste"],
  });
  expect(layout.primary).toEqual(["esc", "tab", "shift-tab", "up", "down", "enter"]);
  expect(layout.tools).toEqual(["paste", "kbd", "mic", "img", "copy", "font-dec", "font-inc"]);
});

test("every key ends up in exactly one row", () => {
  const layouts = [
    null,
    "junk",
    {},
    { primary: ["up"], nav: ["ctrl"], tools: [] },
    { primary: [], nav: [], tools: [] },
    { primary: ["esc", "tab", "shift-tab", "up", "down", "enter"], nav: [], tools: ["img"] },
  ];
  for (const raw of layouts) {
    const layout = normaliseLayout(raw);
    const all = [...layout.primary, ...layout.nav, ...layout.tools];
    expect(new Set(all).size).toBe(all.length); // no duplicates
    expect(all.sort()).toEqual(
      [...ROWS.primary, ...ROWS.nav, ...ROWS.tools].sort(), // no missing, no extras
    );
  }
});
