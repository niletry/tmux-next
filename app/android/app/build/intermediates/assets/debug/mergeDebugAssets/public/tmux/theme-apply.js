// @ts-check
/**
 * Applies a theme to the page, and keeps the machine's choice in sync.
 *
 * Loaded by every page that shows colour, before first paint. The split from
 * themes.js is deliberate: that module is pure data and pure functions, so the
 * test suite can import it under Bun; this one touches the DOM, localStorage
 * and the network, and is only ever run by a browser.
 */

import { apiFetch } from "./api.js";
import { themeVars, DEFAULT_THEME } from "./themes.js";

/**
 * localStorage is a *cache*, not the source of truth.
 *
 * The machine's choice lives in ~/.tmux-next/theme.json, but fetching it is
 * asynchronous — painting the default first and correcting a moment later
 * flashes the wrong colours on every load. Reading a cached name synchronously
 * avoids that, and being wrong is self-correcting: the fetch below overwrites
 * it. On a device that has never loaded the page the cache is empty and the
 * default paints, which is the same thing that would have happened anyway.
 */
const CACHE_KEY = "termTheme";

/**
 * Writes a theme's colours onto :root. Everything else derives from these.
 * @param {string} name
 */
export function applyTheme(name) {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(themeVars(name))) {
    root.style.setProperty(key, value);
  }
  root.dataset.theme = name;
}

/** The cached name, or the default. */
export function cachedTheme() {
  try {
    return localStorage.getItem(CACHE_KEY) || DEFAULT_THEME;
  } catch {
    // Private mode, or storage disabled — the default is a fine answer.
    return DEFAULT_THEME;
  }
}

/** @param {string} name */
function cache(name) {
  try {
    localStorage.setItem(CACHE_KEY, name);
  } catch {
    // Not being able to cache costs a flash on the next load, nothing more.
  }
}

/**
 * Paints the cached theme now, then reconciles with the server.
 *
 * Returns the authoritative name once known, so a caller that renders a picker
 * can tick the right row.
 *
 * @returns {Promise<string>}
 */
export async function initTheme() {
  applyTheme(cachedTheme());
  try {
    const res = await apiFetch("api/theme");
    if (!res.ok) return cachedTheme();
    const { name } = await res.json();
    if (typeof name === "string" && name !== document.documentElement.dataset.theme) {
      applyTheme(name);
      cache(name);
    }
    return name;
  } catch {
    // Offline, or the server is gone. The cached theme is already painted and
    // the page is still usable; there is nothing to tell the user here.
    return cachedTheme();
  }
}

/**
 * Switches the theme: paints immediately, then persists.
 *
 * Painting first is what makes the picker feel instant. A failed write leaves
 * the page correct but the machine unchanged, which is why the result is
 * reported back rather than swallowed.
 *
 * @param {string} name
 * @returns {Promise<boolean>} whether the choice was stored
 */
export async function setTheme(name) {
  applyTheme(name);
  cache(name);
  try {
    const res = await apiFetch("api/theme", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
