import { test, expect } from "bun:test";
// A browser module, but a `// @ts-check`ed one — its JSDoc types are real.
import { sessionState, isWaiting } from "../public/session-state.js";

test("turn wins over idle when both are present", () => {
  expect(sessionState({ idle: false, turn: "waiting" })).toBe("waiting");
  expect(sessionState({ idle: true, turn: "working" })).toBe("working");
});

test("idle is the fallback when turn cannot answer", () => {
  expect(sessionState({ idle: true, turn: null })).toBe("waiting");
  expect(sessionState({ idle: false, turn: null })).toBe("working");
  expect(sessionState({ idle: true })).toBe("waiting");
  expect(sessionState({ idle: false })).toBe("working");
});

test("isWaiting mirrors sessionState", () => {
  expect(isWaiting({ idle: false, turn: "waiting" })).toBe(true);
  expect(isWaiting({ idle: true, turn: "working" })).toBe(false);
  expect(isWaiting({ idle: true, turn: null })).toBe(true);
  expect(isWaiting({ idle: false, turn: null })).toBe(false);
});
