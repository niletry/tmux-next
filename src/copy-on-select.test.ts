import { test, expect } from "bun:test";
// A browser module, but a `// @ts-check`ed one — its JSDoc types are real.
import { createCopyGate, decodeOsc52 } from "../public/copy-on-select.js";

const osc52 = (text: string, targets = "c") => `${targets};${btoa(text)}`;

test("decodes the text an OSC 52 set request carries", () => {
  expect(decodeOsc52(osc52("hello"))).toBe("hello");
});

test("decodes UTF-8, not just ASCII", () => {
  // tmux base64-encodes the raw UTF-8 bytes; a naive atob would mangle CJK.
  const text = "选中的中文";
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  expect(decodeOsc52(`c;${b64}`)).toBe(text);
});

test("ignores a clipboard query rather than treating ? as text", () => {
  // OSC 52 with a `?` payload asks the terminal for the clipboard; it is not
  // something to copy.
  expect(decodeOsc52("c;?")).toBe(null);
});

test("returns null for a payload with no target separator", () => {
  expect(decodeOsc52("garbage")).toBe(null);
});

test("returns null for non-base64 rather than throwing", () => {
  expect(decodeOsc52("c;not valid base64 @#$")).toBe(null);
});

test("an empty selection decodes to null", () => {
  expect(decodeOsc52("c;")).toBe(null);
});

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
