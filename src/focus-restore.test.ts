import { test, expect } from "bun:test";
// A browser module, but a `// @ts-check`ed one — its JSDoc types are real.
import { shouldRestoreFocus } from "../public/focus-restore.js";

const state = (over: Partial<Parameters<typeof shouldRestoreFocus>[0]> = {}) => ({
  keyboardWanted: true,
  renaming: false,
  modalOpen: false,
  ...over,
});

test("a blur while the user wants the keyboard pulls focus back", () => {
  expect(shouldRestoreFocus(state())).toBe(true);
});

test("the keyboard the user dismissed is not reopened", () => {
  expect(shouldRestoreFocus(state({ keyboardWanted: false }))).toBe(false);
});

test("the rename field keeps the focus it was given", () => {
  // Snatching focus back here is what stopped the title field being typable.
  expect(shouldRestoreFocus(state({ renaming: true }))).toBe(false);
});

test("an open overlay keeps the focus, so a phone selection survives", () => {
  // The copy overlay's <pre> is not focusable, so the long press that starts a
  // selection blurs xterm's textarea. Answering that blur with term.focus()
  // moves the document selection into the textarea and the selection handles
  // vanish the instant they appear — the whole overlay is unusable on a phone.
  expect(shouldRestoreFocus(state({ modalOpen: true }))).toBe(false);
});

test("an overlay opened while renaming is still not a reason to grab focus", () => {
  expect(shouldRestoreFocus(state({ renaming: true, modalOpen: true }))).toBe(false);
});
