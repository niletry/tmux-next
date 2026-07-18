/**
 * Pure helpers for the directory picker, kept apart from the DOM so the
 * matching and shortening rules can be tested without a browser.
 */

/** Filters directory entries by a case-insensitive substring of their name. */
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
 */
export function shortPath(path, home) {
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}
