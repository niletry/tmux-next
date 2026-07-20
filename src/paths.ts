import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ResolveResult = { ok: true; path: string } | { ok: false };

/**
 * Canonicalises a path and confirms it is a directory.
 *
 * There is deliberately no allow-list of roots. An earlier version fenced
 * browsing to the home directory and one named volume, which read as a
 * security boundary but was not one: anyone who can reach this endpoint can
 * also attach to a session and run `ls` anywhere. Fencing the browser while
 * leaving a shell open only made the app less useful — new machines and new
 * drives needed a code change — without making it safer.
 *
 * `realpath` still runs, because the caller needs the canonical path: it
 * collapses `..` and follows symlinks so the directory reported back is the
 * one a session would actually start in.
 */
export async function resolveDirectory(input: string): Promise<ResolveResult> {
  let resolved: string;
  try {
    resolved = await realpath(input);
  } catch {
    return { ok: false };
  }

  try {
    if (!(await stat(resolved)).isDirectory()) return { ok: false };
  } catch {
    return { ok: false };
  }

  return { ok: true, path: resolved };
}

export type DirEntry = { name: string; path: string };
export type Listing =
  | { ok: true; path: string; parent: string | null; entries: DirEntry[] }
  | { ok: false; path: null; parent: null; entries: [] };

const REFUSED: Listing = { ok: false, path: null, parent: null, entries: [] };

/**
 * Lists the sub-directories of `path` for the browser UI.
 *
 * Dot directories are omitted: on a phone a list padded with `.git` and
 * `.cache` buries the handful of entries actually worth tapping.
 *
 * `parent` is null at the filesystem root, which is the only thing that bounds
 * the climb now that there are no configured roots.
 */
export async function listDirectories(path: string): Promise<Listing> {
  const resolved = await resolveDirectory(path);
  if (!resolved.ok) return REFUSED;

  let names: string[];
  try {
    const dirents = await readdir(resolved.path, { withFileTypes: true });
    names = dirents.filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name);
  } catch {
    return REFUSED;
  }

  const parent = dirname(resolved.path);

  return {
    ok: true,
    path: resolved.path,
    parent: parent === resolved.path ? null : parent,
    entries: names
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, path: join(resolved.path, name) })),
  };
}
