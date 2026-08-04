import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { tmux } from "./run";
import { WEB_SESSION_PREFIX } from "./session-manager";

/**
 * Characters that make a session unmanageable.
 *
 * tmux happily *creates* a session called `a.b` or `a:b`, but every later `-t`
 * lookup parses them as the `session:window.pane` separators and fails, so the
 * session can no longer be targeted — not even to kill it. Verified against
 * tmux 3.7: `kill-session -t '=probe.dot'` answers "can't find window: probe".
 * Such a session can only be removed by its `$id`, which nothing in this app
 * uses, so it has to be refused up front.
 */
const UNTARGETABLE = /[.:]/;

/** Constant by construction: tmux runs this through `sh -c`. */
export const LAUNCH_COMMAND = "exec \"$SHELL\" -lc claude";

/**
 * The same launch with Claude Code's confirmations turned off.
 *
 * A second constant rather than a flag spliced into the first: these strings
 * reach `sh -c`, and the one rule that keeps this safe is that nothing derived
 * from a request is ever part of them. Choosing between two fixed strings keeps
 * that rule intact where building one would not.
 */
export const LAUNCH_COMMAND_SKIP_PERMISSIONS =
  "exec \"$SHELL\" -lc \"claude --dangerously-skip-permissions\"";

/**
 * Picks the launch command for a request.
 *
 * Strictly `=== true`, never truthiness: the value is untrusted JSON, and a
 * stray `"false"` string would otherwise let Claude Code act without asking.
 */
export function launchCommand(skipPermissions: unknown): string {
  return skipPermissions === true ? LAUNCH_COMMAND_SKIP_PERMISSIONS : LAUNCH_COMMAND;
}

/**
 * Id-safe characters only, so a resume id can be interpolated into the launch
 * command without letting anything shell-shaped through. Mirrors the check in
 * claude-sessions' restore path — a Claude session id is a uuid.
 */
const RESUME_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * The launch command for resuming a past Claude conversation, or null if the id
 * is not id-safe.
 *
 * The id is the only caller-supplied value that reaches the `sh -c` string, and
 * it is admitted only after matching RESUME_ID — the same discipline the fixed
 * commands above keep by carrying nothing interpolatable at all. Returning null
 * on a bad id keeps a malformed request from ever reaching tmux.
 */
export function resumeCommand(id: unknown, skipPermissions: unknown): string | null {
  if (typeof id !== "string" || !RESUME_ID.test(id)) return null;
  const flags = skipPermissions === true ? " --dangerously-skip-permissions" : "";
  return `exec "$SHELL" -lc "claude --resume ${id}${flags}"`;
}

export type NameCheck =
  | { ok: true; name: string | null }
  | { ok: false; reason: "empty" | "reserved" | "invalid" };

/**
 * Validates a caller-supplied session name.
 *
 * A missing field asks for a generated name; a field that is present but blank
 * is a mistake worth reporting rather than silently treating as "generate".
 */
export function validateRequestedName(input: string | undefined | null): NameCheck {
  if (input === undefined || input === null) return { ok: true, name: null };

  const name = input.trim();
  if (!name) return { ok: false, reason: "empty" };
  if (name.startsWith(WEB_SESSION_PREFIX)) return { ok: false, reason: "reserved" };
  if (UNTARGETABLE.test(name)) return { ok: false, reason: "invalid" };

  return { ok: true, name };
}

/** Derives a free session name from a directory, suffixing until it is unused. */
export function pickName(dir: string, existing: string[]): string {
  // Inline global regex rather than a /g version of UNTARGETABLE: a shared
  // global regex carries lastIndex between calls, which would make .test()
  // alternate between true and false on identical input.
  const base = basename(dir.replace(/\/+$/, "")).replace(/[.:]/g, "-") || "session";
  if (!existing.includes(base)) return base;

  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

export type CreateResult =
  | { ok: true; name: string; created: boolean }
  | { ok: false; reason: "empty" | "reserved" | "invalid" | "baddir" | "failed" };

/**
 * Ensures a session exists for `dir`, returning the one already there if the
 * requested name is taken.
 *
 * Reusing rather than refusing matches intent: naming a session that already
 * exists almost always means "take me back to it". A generated name has no such
 * intent behind it, so it gets a suffix instead.
 *
 * The command string is a constant. tmux runs it through `sh -c`, so no caller
 * input may be interpolated into it; the directory travels as an argv entry via
 * `-c` instead. A login shell is required because the tmux server may have been
 * started by launchd with a minimal PATH, where `claude` would not resolve.
 */
export async function createSession(
  dir: string,
  requested: string | undefined | null,
  existing: string[],
  command: string = LAUNCH_COMMAND,
): Promise<CreateResult> {
  const checked = validateRequestedName(requested);
  if (!checked.ok) return { ok: false, reason: checked.reason };

  // tmux exits 0 for `-c <missing>` and creates the session in some other
  // directory, so an unchecked bad path leaves a stray session behind.
  try {
    if (!(await stat(dir)).isDirectory()) return { ok: false, reason: "baddir" };
  } catch {
    return { ok: false, reason: "baddir" };
  }

  if (checked.name && existing.includes(checked.name)) {
    return { ok: true, name: checked.name, created: false };
  }

  const name = checked.name ?? pickName(dir, existing);
  const created = await tmux([
    "new-session",
    "-d",
    "-s",
    name,
    "-c",
    dir,
    command,
  ]);

  return created.ok ? { ok: true, name, created: true } : { ok: false, reason: "failed" };
}
