// @ts-check
/**
 * Pure helpers for the directory picker, kept apart from the DOM so the
 * matching and shortening rules can be tested without a browser.
 *
 * Type-checked: these are imported by tests, so the annotations below are
 * verified rather than decorative. The DOM-heavy modules in this directory
 * are not checked — see tsconfig.json.
 */

/**
 * @typedef {{ name: string, path: string }} DirEntry
 */

/**
 * Filters directory entries by a case-insensitive substring of their name.
 *
 * @param {DirEntry[]} entries
 * @param {string} query
 * @returns {DirEntry[]}
 */
export function filterEntries(entries, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((e) => e.name.toLowerCase().includes(needle));
}

/**
 * Renders a path for a narrow screen, abbreviating the home directory to `~`.
 *
 * The separator check keeps `/home/samuel` from being shown as `~a` when home
 * is `/home/sam`.
 *
 * @param {string} path
 * @param {string} home
 * @returns {string}
 */
export function shortPath(path, home) {
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}

/**
 * Splits a shortened path into the lead-up and the directory you are in.
 *
 * The crumb is the only thing that always answers "where will this session be
 * created?" — chips go dark the moment you browse below a favourite. Giving the
 * last segment its own element lets it be styled as the answer rather than as
 * the tail of a dim path.
 *
 * The parent keeps its trailing separator so the two halves concatenate back
 * into the original, and a leaf is never empty: `~` and `/` are their own leaf.
 *
 * @param {string} path
 * @param {string} home
 * @returns {{ parent: string, leaf: string }}
 */
export function splitPath(path, home) {
  const shown = shortPath(path, home);
  const trimmed = shown.length > 1 ? shown.replace(/\/$/, "") : shown;
  const cut = trimmed.lastIndexOf("/");
  const leaf = cut < 0 ? trimmed : trimmed.slice(cut + 1);
  // Root is its own leaf: there is no shorter thing left to name it by.
  if (!leaf) return { parent: "", leaf: trimmed };
  return { parent: cut < 0 ? "" : trimmed.slice(0, cut + 1), leaf };
}
