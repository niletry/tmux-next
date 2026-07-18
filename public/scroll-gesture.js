/**
 * Turns a vertical touch drag into a count of lines to scroll.
 *
 * Pure bookkeeping, no DOM: the caller feeds it touch coordinates and gets back
 * whole lines, which it turns into wheel events. Kept separate from terminal.js
 * so the accumulation and tap/swipe rules can be tested without a browser.
 */
/**
 * Converts a stream of line counts into whole pages.
 *
 * Used only on the fallback path: a program that ignores mouse reporting gets
 * PgUp/PgDn instead, and sending one key per line would jump a page per line.
 */
export function createPager({ pageLines }) {
  let banked = 0;

  return {
    take(lines) {
      banked += lines;
      const pages = Math.trunc(banked / pageLines);
      banked -= pages * pageLines;
      return pages;
    },
  };
}

export function createGesture({ lineHeight, tapSlop = 10 }) {
  let startY = 0;
  let emitted = 0;
  let maxDistance = 0;

  return {
    start(y) {
      startY = y;
      emitted = 0;
      maxDistance = 0;
    },

    /**
     * Returns whole lines crossed since the last call. Positive means dragging
     * down, which shows older output — the content follows the finger.
     */
    move(y) {
      const travelled = y - startY;
      maxDistance = Math.max(maxDistance, Math.abs(travelled));

      // Truncation banks the sub-line remainder, so a slow drag still adds up
      // instead of rounding away every step.
      const total = Math.trunc(travelled / lineHeight);
      const lines = total - emitted;
      emitted = total;
      return lines;
    },

    /** A tap never wandered far; anything else was a swipe, even if it came back. */
    end() {
      return { tap: maxDistance < tapSlop };
    },
  };
}
