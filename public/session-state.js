// @ts-check
/**
 * Whether a session counts as waiting on you or working, for the session list.
 *
 * Mirrors `stateOf` in `src/items/facets.ts` — same fallback, same reason: `turn`
 * is read from the transcript's `stop_reason`, part of the record format, so it
 * survives an agent's TUI changing how it paints. `idle` is the older screen
 * heuristic (a regex against the TUI's own idle marker) and stays only as the
 * fallback for sessions `turn` cannot answer — no transcript (not Claude, or
 * older than the binding record), or the tail read failed.
 *
 * Kept as a second copy rather than one shared import: `items/facets.ts` is a
 * server module compiled by tsc, this one is loaded by the browser with no
 * build step. Both sides must change together if the rule ever does.
 */

/**
 * @typedef {{ idle: boolean, turn?: "waiting" | "working" | null }} SessionState
 */

/**
 * @param {SessionState} session
 * @returns {"waiting" | "working"}
 */
export function sessionState(session) {
  if (session.turn) return session.turn;
  return session.idle ? "waiting" : "working";
}

/** @param {SessionState} session */
export function isWaiting(session) {
  return sessionState(session) === "waiting";
}
