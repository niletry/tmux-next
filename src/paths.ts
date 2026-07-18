import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

/**
 * Directories the app is willing to look at.
 *
 * The service listens on loopback and leaves auth to Caddy, but the browse
 * endpoint still hands out directory structure, so it has no business covering
 * the whole filesystem. Every existing session lives under one of these two.
 *
 * The home directory comes from the environment rather than being written out,
 * while the external volume is specific to this machine and is a constant.
 */
export function allowedRoots(): string[] {
  return [homedir(), "/mnt/data"];
}

/** Whether an already-resolved path sits inside one of `roots`. */
export function isWithinRoots(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(root + sep));
}

export type ResolveResult = { ok: true; path: string } | { ok: false };

/**
 * Canonicalises a path and confirms it is a directory inside `roots`.
 *
 * Resolving first is what makes the check sound: `realpath` collapses `..` and
 * follows symlinks, so a link pointing out of a root is judged by where it
 * lands rather than by where it sits. Comparing on a separator boundary keeps
 * `/home/samuel` from passing as `/home/sam`.
 */
export async function resolveWithinRoots(
  input: string,
  roots: string[],
): Promise<ResolveResult> {
  let resolved: string;
  try {
    resolved = await realpath(input);
  } catch {
    return { ok: false };
  }

  if (!isWithinRoots(resolved, roots)) return { ok: false };

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
 * `parent` is null once `path` is a root, so browsing cannot climb past the
 * boundary — the UI has no back button to offer there.
 */
export async function listDirectories(path: string, roots: string[]): Promise<Listing> {
  const resolved = await resolveWithinRoots(path, roots);
  if (!resolved.ok) return REFUSED;

  let names: string[];
  try {
    const dirents = await readdir(resolved.path, { withFileTypes: true });
    names = dirents.filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name);
  } catch {
    return REFUSED;
  }

  // A root's own parent lies outside, which is what stops browsing there.
  const parent = dirname(resolved.path);
  const reachable = parent !== resolved.path && isWithinRoots(parent, roots);

  return {
    ok: true,
    path: resolved.path,
    parent: reachable ? parent : null,
    entries: names
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, path: join(resolved.path, name) })),
  };
}
