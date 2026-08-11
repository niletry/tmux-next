// @ts-check
/**
 * Applies the interface language to a page.
 *
 * Split from i18n.js for the same reason theme-apply.js is split from
 * themes.js: that module is data and pure functions so the tests can load it,
 * this one touches the DOM, localStorage and the network and only ever runs in
 * a browser.
 */

import { t, DEFAULT_LANG, LANGS } from "./i18n.js";
import { apiFetch } from "./api.js";

/**
 * localStorage is a cache, not the authority.
 *
 * The machine's choice lives on the server, but fetching it is asynchronous —
 * rendering Chinese and correcting to English a moment later flashes on every
 * load. Reading a cached value synchronously avoids that, and being wrong is
 * self-correcting.
 */
const CACHE_KEY = "termLang";

let current = DEFAULT_LANG;

/** The active language. */
export function lang() {
  return current;
}

/**
 * A translated string in the active language.
 * @param {string} key
 * @param {Record<string, string | number>} [vars]
 * @returns {string}
 */
export function tr(key, vars) {
  return t(key, current, vars);
}

export function cachedLang() {
  try {
    const stored = localStorage.getItem(CACHE_KEY);
    return stored && LANGS.includes(stored) ? stored : DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG;
  }
}

/**
 * Rewrites every marked element in the document.
 *
 * The markup keeps its original text as a fallback, so a page whose script
 * failed still reads as something rather than as a row of blanks.
 */
export function applyLang(/** @type {string} */ next) {
  current = LANGS.includes(next) ? next : DEFAULT_LANG;
  document.documentElement.lang = current === "zh" ? "zh-CN" : "en";

  for (const el of document.querySelectorAll("[data-i18n]")) {
    const key = el.getAttribute("data-i18n");
    if (key) el.textContent = t(key, current);
  }
  for (const [attr, target] of [
    ["data-i18n-aria", "aria-label"],
    ["data-i18n-title", "title"],
    ["data-i18n-placeholder", "placeholder"],
  ]) {
    for (const el of document.querySelectorAll(`[${attr}]`)) {
      const key = el.getAttribute(attr);
      if (key) el.setAttribute(target, t(key, current));
    }
  }
}

/** Paints the cached language now, then reconciles with the machine's. */
export async function initLang() {
  applyLang(cachedLang());
  try {
    const res = await apiFetch("api/language");
    if (!res.ok) return current;
    const { lang: served } = await res.json();
    if (typeof served === "string" && served !== current) {
      applyLang(served);
      try {
        localStorage.setItem(CACHE_KEY, served);
      } catch {
        /* private mode; costs a flash next load, nothing more */
      }
    }
    return current;
  } catch {
    return current;
  }
}

/**
 * Switches language: paints immediately, then persists.
 * @param {string} next
 * @returns {Promise<boolean>}
 */
export async function setLang(next) {
  applyLang(next);
  try {
    localStorage.setItem(CACHE_KEY, next);
  } catch {
    /* ignore */
  }
  try {
    const res = await apiFetch("api/language", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lang: next }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
