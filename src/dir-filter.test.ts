import { test, expect } from "bun:test";
// @ts-expect-error - plain browser module, no types
import { filterEntries, shortPath } from "../public/dir-filter.js";

const ENTRIES = [
  { name: "orbit-spec", path: "/v/orbit-spec" },
  { name: "orbit-web", path: "/v/orbit-web" },
  { name: "notes", path: "/v/notes" },
];

test("an empty query keeps every entry", () => {
  expect(filterEntries(ENTRIES, "").map((e) => e.name)).toEqual([
    "orbit-spec",
    "orbit-web",
    "notes",
  ]);
});

test("a query matches anywhere in the name, not just the start", () => {
  expect(filterEntries(ENTRIES, "spec").map((e) => e.name)).toEqual(["orbit-spec"]);
});

test("matching ignores case so the phone keyboard's capitals do not matter", () => {
  expect(filterEntries(ENTRIES, "ORBIT").map((e) => e.name)).toEqual([
    "orbit-spec",
    "orbit-web",
  ]);
});

test("surrounding whitespace in a query is ignored", () => {
  expect(filterEntries(ENTRIES, "  notes ").map((e) => e.name)).toEqual(["notes"]);
});

test("a query matching nothing yields nothing", () => {
  expect(filterEntries(ENTRIES, "zzz")).toEqual([]);
});

test("a short path is left alone", () => {
  expect(shortPath("/home/sam", "/home/sam")).toBe("~");
});

test("a path under home is shown relative to it", () => {
  expect(shortPath("/home/sam/projects/tmux-next", "/home/sam")).toBe("~/projects/tmux-next");
});

test("a path outside home keeps its full form", () => {
  expect(shortPath("/mnt/data/vr", "/home/sam")).toBe("/mnt/data/vr");
});

test("a home-prefixed sibling is not abbreviated", () => {
  // /home/samuel must not render as ~a
  expect(shortPath("/home/samuel/x", "/home/sam")).toBe("/home/samuel/x");
});
