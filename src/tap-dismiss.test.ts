import { test, expect } from "bun:test";
import { createBackdropDismiss } from "../public/tap-dismiss.js";

/**
 * The rule that decides when a tap on a modal backdrop closes it.
 *
 * This exists because the copy overlay closed on `pointerdown`, which removed
 * it mid-gesture and let the click that followed reach the toolbar underneath.
 */

const backdrop = { name: "backdrop" };
const content = { name: "content" };

test("a tap that starts and ends on the backdrop dismisses", () => {
  const d = createBackdropDismiss(backdrop);
  d.down(backdrop);
  expect(d.click(backdrop)).toBe(true);
});

test("a tap on the content does not dismiss", () => {
  const d = createBackdropDismiss(backdrop);
  d.down(content);
  expect(d.click(content)).toBe(false);
});

test("a selection dragged out of the content onto the backdrop does not dismiss", () => {
  // The click target for such a drag is the common ancestor — the backdrop —
  // so the end position alone cannot tell a dismissal from a selection.
  const d = createBackdropDismiss(backdrop);
  d.down(content);
  expect(d.click(backdrop)).toBe(false);
});

test("a click with no pointerdown of its own does not dismiss", () => {
  // Keyboard-synthesised clicks, and the stray click that follows a gesture
  // handled elsewhere, must not close anything.
  const d = createBackdropDismiss(backdrop);
  expect(d.click(backdrop)).toBe(false);
});

test("a dismissing tap does not arm the next click", () => {
  const d = createBackdropDismiss(backdrop);
  d.down(backdrop);
  expect(d.click(backdrop)).toBe(true);
  expect(d.click(backdrop)).toBe(false);
});
