// @ts-check
/**
 * Picks the default session name to prefill when starting another session
 * for an issue that already has one.
 *
 * `createSession` does not error on a name collision — it reuses the
 * existing session and reports `created: false` (src/tmux/session-create.ts).
 * So the prefill must itself avoid a name already in use, or "start another"
 * silently reopens the first session instead of creating a second. Kept as a
 * pure function, apart from the DOM, so the picking rule can be tested
 * without a browser.
 */

/**
 * @param {string} key issue key, e.g. "EXAMPLE-1"
 * @param {string[]} taken names already in use — bound sessions and any
 *   other live tmux session name
 * @returns {string} the issue key itself if free, otherwise the first
 *   `${key}-2`, `${key}-3`, … not in `taken`
 */
export function pickSessionName(key, taken) {
  const used = new Set(taken);
  if (!used.has(key)) return key;
  let n = 2;
  while (used.has(`${key}-${n}`)) n++;
  return `${key}-${n}`;
}
