import { test, expect } from "bun:test";
import { connClass } from "../public/conn-state.js";

/**
 * The connection dot replaced words that used to say what was happening, so
 * the one thing that must not break is that its three states stay tellable
 * apart. terminal.js is not type-checked, and a typo'd state name there would
 * show up as a dot that quietly stops changing.
 */

test("each state gets its own class", () => {
  const classes = ["connecting", "connected", "lost"].map(connClass);
  expect(new Set(classes).size).toBe(3);
});

test("every state keeps the base class, so the dot is always sized", () => {
  for (const state of ["connecting", "connected", "lost"]) {
    expect(connClass(state).split(" ")).toContain("conn");
  }
});

test("an unknown state reads as trouble, not as fine", () => {
  // A socket callback handing over something unexpected must not paint the
  // "everything is up" dot — the failure has to stay visible.
  expect(connClass("typo")).toBe(connClass("lost"));
  expect(connClass("")).toBe(connClass("lost"));
});
