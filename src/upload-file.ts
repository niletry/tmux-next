import { join } from "node:path";
import { stat, writeFile } from "node:fs/promises";
import { tmux } from "./tmux/run";
import { safeGalleryName } from "../plugins/gallery/gallery";

/**
 * Uploads into a session's working tree are capped the same way the gallery's
 * are — the bytes are buffered in memory, so an unbounded body is a memory
 * problem, not a disk one.
 */
export const MAX_SESSION_UPLOAD_BYTES = 20 * 1024 * 1024;

export type SessionUploadResult =
  | { ok: true; path: string }
  | { ok: false; reason: "name" | "session" };

/**
 * The directory a session is working in right now.
 *
 * The pane's current path, not a launch dir from a binding record: the user
 * may have cd'd since, and a fresh web terminal has no record at all. A
 * missing session (or a pane tmux cannot resolve) reads as null.
 */
export async function sessionCwd(name: string): Promise<string | null> {
  const res = await tmux(["display-message", "-p", "-t", `=${name}:`, "#{pane_current_path}"]);
  if (!res.ok) return null;
  const cwd = res.stdout.trim();
  return cwd.length > 0 ? cwd : null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes an uploaded file into a session's working directory, keeping the
 * caller's basename.
 *
 * The name goes through `safeGalleryName` first, so it can never name anything
 * outside that directory. A collision gets a numeric suffix (`x.txt` → `x-2.txt`)
 * rather than silently overwriting what is already there. Returns the absolute
 * path of the saved file — the value the client types back into the prompt so
 * the tool in the session can read it.
 *
 * Writing into the working tree is the same privilege the interface already
 * has: whoever can reach it can type `cat > file` in that very session. The
 * guarantees here are the narrow ones — the name stays a basename and the
 * destination is the session's own directory.
 */
export async function saveSessionUpload(
  session: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<SessionUploadResult> {
  const safe = safeGalleryName(fileName);
  if (!safe) return { ok: false, reason: "name" };
  const cwd = await sessionCwd(session);
  if (!cwd) return { ok: false, reason: "session" };

  const m = safe.match(/^(.*?)(\.[^.]+)?$/);
  const base = m?.[1] ?? safe;
  const ext = m?.[2] ?? "";
  let candidate = safe;
  for (let i = 2; ; i++) {
    if (!(await exists(join(cwd, candidate)))) break;
    candidate = `${base}-${i}${ext}`;
  }
  await writeFile(join(cwd, candidate), bytes);
  return { ok: true, path: join(cwd, candidate) };
}
