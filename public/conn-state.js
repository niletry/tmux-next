// @ts-check
/**
 * What the connection indicator looks like in each state.
 *
 * The terminal bar used to spell the connection out — "已连接" sat in the bar
 * for the entire life of a session, which is the one moment the words are
 * least worth their width: a connection that is up is the boring case. The dot
 * says it in 9px and gives the rest of the bar back to the session name.
 *
 * Only the class lives here. The words stay at the call site as literal
 * `tr("…")` calls, because src/i18n.test.ts finds keys by scanning for exactly
 * that shape — a key reached through a lookup table reads as dead to it, and a
 * dead-key check that cries wolf gets ignored.
 *
 * The three states are not three colours. `ok` is a filled circle, `wait` a
 * hollow ring, `bad` a filled square: the reading survives a colour-blind eye
 * and a washed-out phone screen in sunlight.
 */

/** @typedef {"connecting" | "connected" | "lost"} ConnState */

/** @type {Record<ConnState, string>} */
const CLASSES = {
  connecting: "conn wait",
  connected: "conn ok",
  lost: "conn bad",
};

/**
 * The class list for a connection state.
 *
 * Total on purpose: the argument comes from socket callbacks, and an
 * unrecognised state degrades to the one that admits something is wrong rather
 * than to the one that claims everything is fine.
 *
 * @param {string} state
 * @returns {string}
 */
export function connClass(state) {
  return CLASSES[/** @type {ConnState} */ (state)] ?? CLASSES.lost;
}
