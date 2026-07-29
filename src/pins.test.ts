import { test, expect } from "bun:test";
import { applyPin, applyRename } from "./pins";

test("pinning adds a name once", () => {
  expect(applyPin([], "a", true)).toEqual(["a"]);
  expect(applyPin(["a"], "a", true)).toEqual(["a"]); // no duplicate
  expect(applyPin(["a"], "b", true)).toEqual(["a", "b"]);
});

test("unpinning removes a name, and is a no-op if absent", () => {
  expect(applyPin(["a", "b"], "a", false)).toEqual(["b"]);
  expect(applyPin(["b"], "a", false)).toEqual(["b"]);
});

test("pin order is preserved", () => {
  let pins: string[] = [];
  pins = applyPin(pins, "x", true);
  pins = applyPin(pins, "y", true);
  pins = applyPin(pins, "z", true);
  expect(pins).toEqual(["x", "y", "z"]);
});

test("rename rewrites a pinned name and leaves others alone", () => {
  expect(applyRename(["a", "b"], "a", "a2")).toEqual(["a2", "b"]);
  expect(applyRename(["a", "b"], "c", "c2")).toEqual(["a", "b"]);
});
