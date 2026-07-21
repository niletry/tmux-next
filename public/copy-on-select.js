// @ts-check
/**
 * Decides when a terminal selection should be copied.
 *
 * xterm fires selection-change repeatedly as a drag grows, and again with an
 * empty string when the selection clears. Copying on every event would spam
 * the clipboard and re-copy identical text. This keeps the rule — copy a
 * non-empty selection that differs from what was last copied — out of the DOM
 * so it can be tested; the caller does the actual clipboard write.
 */
export function createCopyGate() {
  let lastCopied = "";

  return {
    /**
     * @param {string} selection  the current selection text (may be empty)
     * @returns {boolean}  whether the caller should copy it now
     */
    shouldCopy(selection) {
      const text = selection ?? "";
      if (!text) {
        // A cleared selection resets the guard so re-selecting the same text
        // copies again, but is not itself a copy.
        lastCopied = "";
        return false;
      }
      if (text === lastCopied) return false;
      lastCopied = text;
      return true;
    },
  };
}
