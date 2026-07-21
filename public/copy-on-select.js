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
/**
 * Decodes the text an OSC 52 clipboard sequence carries.
 *
 * tmux (with `set-clipboard on`) answers a mouse selection by sending
 * `OSC 52 ; <targets> ; <base64> BEL` — the selection, already encoded. xterm
 * hands the part after `52;` to an OSC handler as `"<targets>;<base64>"`. This
 * pulls the base64 out and decodes it to UTF-8, so a plain mouse drag copies
 * through the same clipboard write as a native selection.
 *
 * Returns null for anything that isn't a decodable set request — a query
 * (`?` payload), a malformed field, or non-base64 — so the caller writes the
 * clipboard only when there is real text to write.
 *
 * @param {string} data  the OSC payload after the `52;`
 * @returns {string | null}
 */
export function decodeOsc52(data) {
  const semi = data.indexOf(";");
  if (semi < 0) return null;
  const payload = data.slice(semi + 1);
  if (!payload || payload === "?") return null;
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    return text || null;
  } catch {
    return null;
  }
}

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
