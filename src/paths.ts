import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export type Refusal = "denied" | "missing";

export type ResolveResult = { ok: true; path: string } | { ok: false; reason: Refusal };

/**
 * Why a filesystem call failed, in the only two flavours the browser can act on.
 *
 * "It is not there" and "you may not look" are different answers and deserve
 * different words on screen. Collapsing them is what let a macOS privacy block
 * on an external volume present as an ordinary empty folder, which is the kind
 * of lie that costs an afternoon: every layer reported success right up to the
 * point where the session died.
 */
function refusalFor(error: unknown): Refusal {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EACCES" || code === "EPERM" ? "denied" : "missing";
}

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
  } catch (error) {
    return { ok: false, reason: refusalFor(error) };
  }

  try {
    if (!(await stat(resolved)).isDirectory()) return { ok: false, reason: "missing" };
  } catch (error) {
    return { ok: false, reason: refusalFor(error) };
  }

  return { ok: true, path: resolved };
}

export type DirEntry = { name: string; path: string };
export type Listing =
  | { ok: true; path: string; parent: string | null; entries: DirEntry[] }
  | { ok: false; path: null; parent: null; entries: []; reason: Refusal };

const refused = (reason: Refusal): Listing => ({
  ok: false,
  path: null,
  parent: null,
  entries: [],
  reason,
});

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
  if (!resolved.ok) return refused(resolved.reason);

  let names: string[];
  try {
    const dirents = await readdir(resolved.path, { withFileTypes: true });
    names = dirents.filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name);
  } catch (error) {
    // Reachable on its own: a directory can be traversable enough to stat and
    // still refuse to be read.
    return refused(refusalFor(error));
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

export type NameCheck =
  | { ok: true; name: string }
  | { ok: false; reason: "empty" | "invalid" | "hidden" | "toolong" };

/**
 * Validates a directory name typed into the browser's filter box.
 *
 * A *name*, never a path: anything with a separator is refused rather than
 * interpreted, which is what keeps this endpoint from becoming `mkdir -p`.
 * Backslash is refused alongside `/` — it is a legal character in a POSIX
 * filename, but a name containing one is far more likely to be someone
 * expecting Windows path semantics than a deliberate choice.
 *
 * Dot-prefixed names are refused because listDirectories filters them out: a
 * directory you cannot then see is worse than a rejection. 255 is the common
 * per-component limit on ext4 and APFS.
 */
export function validateDirName(input: unknown): NameCheck {
  if (typeof input !== "string") return { ok: false, reason: "invalid" };
  const name = input.trim();
  if (!name) return { ok: false, reason: "empty" };
  if (name === "." || name === "..") return { ok: false, reason: "invalid" };
  if (name.includes("/") || name.includes("\\")) return { ok: false, reason: "invalid" };
  if (name.startsWith(".")) return { ok: false, reason: "hidden" };
  if (name.length > 255) return { ok: false, reason: "toolong" };
  return { ok: true, name };
}

export type CreateDirResult =
  | { ok: true; path: string }
  | { ok: false; reason: "badparent" | "empty" | "invalid" | "hidden" | "toolong" | "exists" | "failed" };

/**
 * Creates one directory directly inside `parent`.
 *
 * Three layers, and the third is the one that matters. The parent is resolved
 * through the same canonicalisation browsing uses, the name is validated as a
 * name, and then the joined path is checked to still sit *directly* under the
 * resolved parent. That last check is a property of paths rather than of
 * strings, so it holds even where the name check would not — and it is what
 * makes "this cannot create a hierarchy" structural rather than a promise.
 *
 * `mkdir` runs without `recursive`, so an existing directory surfaces as EEXIST
 * instead of silently succeeding: a caller who thinks they made a fresh
 * directory but landed in someone else's would be worse off than one who got
 * an error.
 */
export async function createDirectory(parent: string, name: unknown): Promise<CreateDirResult> {
  const checked = validateDirName(name);
  if (!checked.ok) return { ok: false, reason: checked.reason };

  const resolved = await resolveDirectory(parent);
  if (!resolved.ok) return { ok: false, reason: "badparent" };

  const path = join(resolved.path, checked.name);
  if (dirname(path) !== resolved.path) return { ok: false, reason: "invalid" };

  try {
    await mkdir(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "EEXIST" ? "exists" : "failed" };
  }
  return { ok: true, path };
}
