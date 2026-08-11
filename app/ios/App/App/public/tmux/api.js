// @ts-check
/**
 * One place the front-end talks to the server.
 *
 * In a browser the page and the server share an origin, so every call is a
 * relative path and the base is empty. The native shell (Capacitor) loads the
 * same files from the device and the server lives at an address the user
 * saved, so the base prefixes every call — and only then. Keeping the base in
 * one module means the two modes differ in one string, not in every call site.
 */

const STORAGE_KEY = "tn-server";

/** The saved server address, or "" for same-origin (browser) mode. */
export function serverBase() {
  try {
    return (localStorage.getItem(STORAGE_KEY) || "").replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/** Full URL for a server-relative path ("" base keeps the path as-is). */
/** @param {string} path */
export function apiUrl(path) {
  const base = serverBase();
  return base ? `${base}/${path}` : path;
}

/** fetch against the server, wherever it lives. */
/** @param {string} path @param {RequestInit} [init] */
export function apiFetch(path, init) {
  return fetch(apiUrl(path), init);
}

/** A WebSocket URL for a server-relative path (ws/wss follow http/https). */
/** @param {string} path */
export function apiWsUrl(path) {
  const base = serverBase();
  if (!base) return path;
  return base.replace(/^http/, "ws") + "/" + path;
}

/** sendBeacon against the server, with a fetch fallback. */
/** @param {string} path @param {BodyInit} body */
export function apiBeacon(path, body) {
  const url = apiUrl(path);
  if (navigator.sendBeacon) {
    navigator.sendBeacon(url, body);
  } else {
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    });
  }
}
