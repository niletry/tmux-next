export const WEB_SESSION_PREFIX = "web-";

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
  const target_exists = await Bun.$`tmux has-session -t ${target}`.quiet().nothrow();
  if (target_exists.exitCode !== 0) {
    throw new Error(`no such tmux session: ${target}`);
  }

  const name = WEB_SESSION_PREFIX + crypto.randomUUID().slice(0, 8);

  const created = await Bun.$`tmux new-session -d -t ${target} -s ${name}`.quiet().nothrow();
  if (created.exitCode !== 0) {
    throw new Error(
      `cannot create web session for ${target}: ${created.stderr.toString().trim()}`,
    );
  }

  // Only matters when phone and desktop view different windows; harmless otherwise.
  await Bun.$`tmux set-option -t ${name} aggressive-resize on`.quiet().nothrow();
  return name;
}

export async function destroyWebSession(name: string): Promise<void> {
  if (!name.startsWith(WEB_SESSION_PREFIX)) {
    throw new Error(`refusing to destroy non-web session: ${name}`);
  }
  await Bun.$`tmux kill-session -t ${name}`.quiet().nothrow();
}

/**
 * Kills web sessions with no client attached. Needed because the explicit
 * destroy on disconnect never runs when the server is SIGKILLed.
 */
export async function reapOrphanWebSessions(): Promise<string[]> {
  // The tab must come from a JS string; a literal \t inside the shell template
  // reaches tmux as a backslash and a t.
  const fmt = "#{session_name}\t#{session_attached}";
  const listed = await Bun.$`tmux list-sessions -F ${fmt}`.quiet().nothrow();
  if (listed.exitCode !== 0) return [];

  const reaped: string[] = [];
  for (const row of listed.stdout.toString().trim().split("\n").filter(Boolean)) {
    const [name, attached] = row.split("\t");
    if (name?.startsWith(WEB_SESSION_PREFIX) && attached === "0") {
      await destroyWebSession(name);
      reaped.push(name);
    }
  }
  return reaped;
}
