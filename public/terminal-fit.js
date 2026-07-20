// @ts-check
/**
 * Chooses the font size and grid for a terminal of a given pixel size.
 *
 * Pure arithmetic, no DOM: terminal.js measures the element and the real cell
 * ratio, this decides the geometry. Split out because the two regimes below are
 * easy to get subtly wrong and impossible to check by reading.
 */

export const MIN_COLUMNS = 80;

/**
 * Desktop font size, effectively.
 *
 * On a phone width is scarce, so the font shrinks until MIN_COLUMNS fit. On a
 * desktop that same rule would blow the font up to ~33px, so it stops here and
 * the leftover width buys columns instead. One rule, no device sniffing: the
 * switch is exactly where MIN_COLUMNS stop fitting at this size.
 *
 * Past the switch the font is pinned here — on any desktop window the size the
 * first rule wants is far above the cap — so this constant alone decides the
 * desktop font. A phone is 390-430px wide, far below the switch, so changing it
 * leaves mobile untouched.
 */
export const MAX_FONT_PX = 12;

const MIN_FONT_PX = 6;
const MIN_ROWS = 8;

/**
 * @param {object} box
 * @param {number} box.width       element width in CSS pixels
 * @param {number} box.height      element height in CSS pixels
 * @param {number} box.ratio       cell width / font size, measured not guessed
 * @param {number} box.lineHeight  cell height / font size
 * @returns {{ cols: number, rows: number, fontSize: number }}
 */
export function computeGeometry({ width, height, ratio, lineHeight }) {
  // The size that would make exactly MIN_COLUMNS fill the width.
  const wanted = Math.floor(width / MIN_COLUMNS / ratio);
  const fontSize = Math.max(MIN_FONT_PX, Math.min(MAX_FONT_PX, wanted));

  // Only a capped font leaves width worth spending on columns. Below the cap
  // the count is held at MIN_COLUMNS on purpose: flooring the font size leaves
  // a sliver of slack, and turning that into an 81st column would make the
  // phone's width drift with every viewport nudge — each drift a tmux reflow.
  const capped = wanted > MAX_FONT_PX;
  const cols = capped
    ? Math.max(MIN_COLUMNS, Math.floor(width / (fontSize * ratio)))
    : MIN_COLUMNS;
  const rows = Math.max(MIN_ROWS, Math.floor(height / (fontSize * lineHeight)));

  return { cols, rows, fontSize };
}
