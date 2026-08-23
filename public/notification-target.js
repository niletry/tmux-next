// @ts-check
/**
 * Where a tapped notification should land, and how to get a window there.
 *
 * Split out of sw.js because the interesting part is control flow, not service
 * worker glue: the previous handler took the first open window, swallowed a
 * failed navigate() and returned, which made its own openWindow() fallback
 * unreachable. On Android that is the whole bug — with the browser in the
 * background its tab is frozen but still listed by matchAll(), navigate()
 * rejects, focus() on a dead client does nothing, and the tap goes nowhere.
 * iOS never hit it because a home-screen web app owns a real window the
 * browser cannot freeze out from under it.
 *
 * Nothing here touches `self`, so a test can drive it with a fake clients
 * object and prove the fallback is reachable.
 */

/**
 * @typedef {object} WindowLike
 * @property {string} [url]
 * @property {(url: string) => Promise<unknown>} [navigate]
 * @property {() => Promise<unknown>} [focus]
 */

/**
 * @typedef {object} ClientsLike
 * @property {() => Promise<unknown[]>} matchAll
 * @property {(url: string) => Promise<unknown>} [openWindow]
 */

/**
 * The page a notification for `session` should open.
 *
 * Absolute, resolved against the worker's scope, so it is unambiguous whether
 * the app is opened fresh or an existing window is redirected.
 *
 * @param {string | undefined} session  session name the push carried, if any
 * @param {string} scope                the service worker's registration scope
 * @returns {string}
 */
export function targetUrl(session, scope) {
  const path = session ? `terminal.html?target=${encodeURIComponent(session)}` : "./";
  return new URL(path, scope).href;
}

/**
 * Brings some window to `url`, opening one if no existing window can be used.
 *
 * Every step is treated as fallible: a window that refuses to navigate or does
 * not come to the front is skipped, the rest of the list is tried, and only
 * once none of them worked does a new window get opened. A window already on
 * `url` is focused as-is — navigating it would reload the terminal for nothing.
 *
 * @param {ClientsLike} clients
 * @param {string} url
 * @returns {Promise<void>}
 */
export async function openTarget(clients, url) {
  const wins = /** @type {WindowLike[]} */ (await clients.matchAll());

  // A window already showing the session first: it needs no navigate, so it is
  // the one most likely to succeed.
  const ordered = [...wins].sort((a, b) => Number(b.url === url) - Number(a.url === url));

  for (const win of ordered) {
    if (typeof win.focus !== "function") continue;
    try {
      if (win.url !== url && typeof win.navigate === "function") await win.navigate(url);
      // focus() resolves with the client it focused; anything falsy means the
      // window did not actually come forward, so keep looking.
      if (await win.focus()) return;
    } catch {
      // Frozen, discarded, or uncontrolled — try the next one.
    }
  }

  if (typeof clients.openWindow === "function") await clients.openWindow(url);
}
