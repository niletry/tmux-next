/**
 * Terminal dimensions arriving from a browser, made safe to use.
 *
 * These numbers are interpolated into a tmux control mode command
 * (`refresh-client -C <cols>,<rows>`), and control mode separates commands by
 * newline — so an unchecked value is arbitrary tmux execution, not merely a
 * wrong window size. Everything here exists to guarantee the output is a pair
 * of plain integers.
 */

type Bounds = { min: number; max: number; fallback: number };

/**
 * `fallback` is not the same as `min`, and conflating them is a real bug: a
 * client that omits a dimension is saying "no preference", so it gets the
 * default size. Clamping absent input to `min` instead handed every pre-cols
 * client a 20-column window.
 *
 * A number that is merely out of range is clamped — it expressed a preference,
 * just an impossible one. Only unusable input (absent, non-numeric, NaN,
 * Infinity, a string smuggling a newline) falls back.
 */
export const COLS: Bounds = { min: 20, max: 1000, fallback: 80 };
export const ROWS: Bounds = { min: 5, max: 500, fallback: 24 };

function clean(value: unknown, bounds: Bounds): number {
  // Absent means no preference. Checked before Number(), which maps both null
  // and "" to 0 — a value that would then clamp to the narrowest window.
  if (value === undefined || value === null || value === "") return bounds.fallback;

  // Number() rather than parseInt(): parseInt("80\nkill-server") is 80, which
  // would silently accept a hostile string by reading its numeric prefix.
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return bounds.fallback;
  return Math.min(bounds.max, Math.max(bounds.min, n));
}

export function sanitiseGeometry(
  cols: unknown,
  rows: unknown,
): { cols: number; rows: number } {
  return { cols: clean(cols, COLS), rows: clean(rows, ROWS) };
}
