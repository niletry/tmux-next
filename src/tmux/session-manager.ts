import { tmux } from "./run";

export const WEB_SESSION_PREFIX = "web-";

/** Numeric field first, name last, so a `|` inside a name is harmless. */
const REAP_FORMAT = "#{session_attached}|#{session_name}";

/**
 * Web session names carry the pid of the process that created them:
 * `web-<pid>-<random>`.
 *
 * Reaping cannot go by "unattached" alone — a leaked `tmux -C attach` child
 * keeps its session attached forever — and an in-memory ownership set is not
 * enough either, because it makes every other live process look like an
 * orphan. Encoding the owner in the name makes ownership decidable from
 * outside the process: a session is garbage exactly when its owner is gone.
 */
function ownerPid(name: string): number | null {
  const m = name.match(/^web-(\d+)-/);
  return m ? Number(m[1]) : null;
}

function ownerAlive(name: string): boolean {
  const pid = ownerPid(name);
  if (pid === null) return false; // Unparseable: from an older build, collect it.
  try {
    // Signal 0 checks for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a grouped session pointing at `target`.
 *
 * A grouped session shares the target's window list but keeps its own current
 * window, which is what isolates the phone's window switching from the
 * desktop's. It does NOT isolate size — a window has exactly one size no
 * matter how many sessions view it.
 */
export async function createWebSession(target: string): Promise<string> {
  // tmux 3.7 silently ignores `-t <missing>` and creates a plain new session
  // with a fresh shell, so the target must be checked up front.
  // `=` forces an exact match; a bare target would resolve by prefix or glob
  // and could silently attach the phone to a different session.
  const found = await tmux(["has-session", "-t", `=${target}`]);
  if (!found.ok) {
    throw new Error(`no such tmux session: ${target}`);
  }

  const name = `${WEB_SESSION_PREFIX}${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

  const created = await tmux(["new-session", "-d", "-t", `=${target}`, "-s", name]);
  if (!created.ok) {
    throw new Error(`cannot create web session for ${target}: ${created.stderr.trim()}`);
  }

  // Only matters when phone and desktop view different windows; harmless otherwise.
  await tmux(["set-option", "-t", name, "aggressive-resize", "on"]);
  return name;
}

export async function destroyWebSession(name: string): Promise<void> {
  if (!name.startsWith(WEB_SESSION_PREFIX)) {
    throw new Error(`refusing to destroy non-web session: ${name}`);
  }
  await tmux(["kill-session", "-t", `=${name}`]);
}

/**
 * Kills every web session whose creating process is gone.
 *
 * Covers the cases the explicit destroy misses: the server being SIGKILLed
 * before it can clean up, and a leaked control-mode child that keeps its
 * session attached. Sessions belonging to another live process — a second
 * instance, or a test run — are left alone.
 */
export async function reapOrphanWebSessions(): Promise<string[]> {
  const listed = await tmux(["list-sessions", "-F", REAP_FORMAT]);
  if (!listed.ok) return [];

  const reaped: string[] = [];
  for (const row of listed.stdout.trim().split("\n").filter(Boolean)) {
    const sep = row.indexOf("|");
    if (sep === -1) continue;
    const name = row.slice(sep + 1);
    if (name.startsWith(WEB_SESSION_PREFIX) && !ownerAlive(name)) {
      await destroyWebSession(name);
      reaped.push(name);
    }
  }
  return reaped;
}
