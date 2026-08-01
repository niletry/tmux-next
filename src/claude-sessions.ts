import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, stat, unlink, mkdir } from "node:fs/promises";
import { tmux } from "./tmux/run";

/**
 * Remembers which Claude conversation ran in which tmux session, on disk, so it
 * survives the tmux server dying — a reboot, a crash, `tmux kill-server`. A
 * Claude SessionStart hook writes one small file per session here; when the
 * tmux session is later gone but its record remains, tmux-next can recreate it
 * and `claude --resume` the conversation (whose transcript is also on disk).
 *
 * One file per record, named by the Claude id (a uuid, always a safe filename),
 * so concurrent hooks never clash. The tmux session name lives in the contents.
 */
export function sessionsDir(): string {
  return process.env.TMUX_NEXT_SESSIONS_DIR || join(homedir(), ".tmux-next", "sessions");
}

export type SessionRecord = {
  id: string;
  session: string;
  cwd?: string;
  mtime: number;
  file: string;
};

const ok = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 512;

/** Newest record wins when a session name was reused across conversations. */
export function dedupeBySession(records: SessionRecord[]): SessionRecord[] {
  const byName = new Map<string, SessionRecord>();
  for (const r of records) {
    const prev = byName.get(r.session);
    if (!prev || r.mtime > prev.mtime) byName.set(r.session, r);
  }
  return [...byName.values()];
}

/** Records whose tmux session is no longer alive — the ones worth restoring. */
export function restorable(records: SessionRecord[], liveNames: Set<string>): SessionRecord[] {
  return dedupeBySession(records).filter((r) => !liveNames.has(r.session));
}

export async function readSessionRecords(): Promise<SessionRecord[]> {
  let names: string[];
  try {
    names = await readdir(sessionsDir());
  } catch {
    return [];
  }

  const out: SessionRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(sessionsDir(), name);
    try {
      const data = (await Bun.file(file).json()) as { id?: unknown; session?: unknown; cwd?: unknown };
      if (!ok(data.id) || !ok(data.session)) continue;
      const { mtimeMs } = await stat(file);
      out.push({
        id: data.id,
        session: data.session,
        ...(ok(data.cwd) ? { cwd: data.cwd } : {}),
        mtime: mtimeMs,
        file,
      });
    } catch {
      // skip an unreadable / half-written file
    }
  }
  return out;
}

/** Drops every record for a session that's intentionally gone (killed here). */
export async function forgetSession(name: string): Promise<void> {
  for (const r of await readSessionRecords()) {
    if (r.session === name) await unlink(r.file).catch(() => {});
  }
}

/** Rewrites a session name on its records so a rename doesn't strand them. */
export async function renameSessionRecords(from: string, to: string): Promise<void> {
  for (const r of await readSessionRecords()) {
    if (r.session !== from) continue;
    await Bun.write(r.file, JSON.stringify(r.cwd ? { id: r.id, session: to, cwd: r.cwd } : { id: r.id, session: to }));
  }
}

const RESUME_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Recreates the tmux session and resumes the conversation in it.
 *
 * The id is validated to id-safe characters before it reaches the command, and
 * the working directory travels as an argv entry (`-c`), so nothing user-shaped
 * is interpolated into the shell string. A session that already exists, or a
 * name tmux can't target (a `.` or `:`), is refused rather than guessed at.
 */
export async function restoreRecord(
  rec: SessionRecord,
): Promise<{ ok: boolean; session: string; reason?: string }> {
  if (!RESUME_ID.test(rec.id)) return { ok: false, session: rec.session, reason: "badid" };
  if (/[.:]/.test(rec.session)) return { ok: false, session: rec.session, reason: "badname" };
  if ((await tmux(["has-session", "-t", `=${rec.session}`])).ok) {
    return { ok: false, session: rec.session, reason: "exists" };
  }

  const args = ["new-session", "-d", "-s", rec.session];
  if (rec.cwd) args.push("-c", rec.cwd);
  args.push(`exec "$SHELL" -lc "claude --resume ${rec.id}"`);

  const res = await tmux(args);
  return res.ok ? { ok: true, session: rec.session } : { ok: false, session: rec.session, reason: "failed" };
}

/** Ensures the drop-folder exists (the hook also creates it, belt-and-braces). */
export async function ensureSessionsDir(): Promise<void> {
  await mkdir(sessionsDir(), { recursive: true }).catch(() => {});
}
