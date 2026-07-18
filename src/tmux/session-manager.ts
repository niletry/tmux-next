import { tmux } from "./run";

export const WEB_SESSION_PREFIX = "web-";

/** Numeric field first, name last, so a `|` inside a name is harmless. */
const REAP_FORMAT = "#{session_attached}|#{session_name}";

/**
 * Web sessions this process currently owns.
 *
 * Reaping cannot go by "unattached" alone: a leaked `tmux -C attach` child
 * keeps its session attached forever, so an orphan from a killed server would
 * never be collected. Anything not in this set belongs to nobody.
 */
const owned = new Set<string>();

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
  const found = await tmux(["has-session", "-t", target]);
  if (!found.ok) {
    throw new Error(`no such tmux session: ${target}`);
  }

  const name = WEB_SESSION_PREFIX + crypto.randomUUID().slice(0, 8);

  const created = await tmux(["new-session", "-d", "-t", target, "-s", name]);
  if (!created.ok) {
    throw new Error(`cannot create web session for ${target}: ${created.stderr.trim()}`);
  }

  // Only matters when phone and desktop view different windows; harmless otherwise.
  await tmux(["set-option", "-t", name, "aggressive-resize", "on"]);
  owned.add(name);
  return name;
}

export async function destroyWebSession(name: string): Promise<void> {
  if (!name.startsWith(WEB_SESSION_PREFIX)) {
    throw new Error(`refusing to destroy non-web session: ${name}`);
  }
  owned.delete(name);
  await tmux(["kill-session", "-t", name]);
}

/**
 * Kills every web session this process does not own.
 *
 * Covers two cases the explicit destroy misses: the server being SIGKILLed
 * before it can clean up, and a leaked control-mode child that keeps its
 * session attached. On startup nothing is owned, so leftovers from a previous
 * run are collected immediately.
 */
export async function reapOrphanWebSessions(): Promise<string[]> {
  const listed = await tmux(["list-sessions", "-F", REAP_FORMAT]);
  if (!listed.ok) return [];

  const reaped: string[] = [];
  for (const row of listed.stdout.trim().split("\n").filter(Boolean)) {
    const sep = row.indexOf("|");
    if (sep === -1) continue;
    const name = row.slice(sep + 1);
    if (name.startsWith(WEB_SESSION_PREFIX) && !owned.has(name)) {
      await destroyWebSession(name);
      reaped.push(name);
    }
  }
  return reaped;
}
