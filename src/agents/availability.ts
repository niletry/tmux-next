import { AGENT_IDS, AGENTS } from "./index";

/**
 * Which agents can actually be started on this machine.
 *
 * Not cosmetic. Launch commands run as `$SHELL -lc <agent>`, and a login
 * shell's PATH is not the server's — under launchd the service starts with a
 * bare environment, so an agent that works in your terminal may be invisible to
 * it. When that happens tmux creates the session, the command fails instantly,
 * the session disappears, and the user is told nothing at all.
 *
 * Probing the same way the launch resolves is the point: `command -v` inside
 * `$SHELL -lc` answers the question that actually matters, rather than whether
 * the binary exists somewhere.
 */

/** Kept as a constant so the test can pin it to what launch() uses. */
export const PROBE_SHELL_FLAGS = ["-lc"] as const;

const CACHE_MS = 30_000;
let cache: { at: number; value: Record<string, boolean> } | null = null;

async function probe(id: string): Promise<boolean> {
  const shell = process.env.SHELL || "/bin/sh";
  try {
    const proc = Bun.spawn([shell, ...PROBE_SHELL_FLAGS, `command -v ${id}`], {
      stdout: "pipe",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/**
 * Availability per agent id, cached briefly.
 *
 * Spawning a login shell per agent is not free and the answer rarely changes,
 * but it must not be cached for the life of the process either — installing an
 * agent should take effect without restarting the server.
 */
export async function agentAvailability(): Promise<Record<string, boolean>> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.value;

  const entries = await Promise.all(
    AGENT_IDS.map(async (id) => [id, await probe(AGENTS[id]!.id)] as const),
  );
  const value = Object.fromEntries(entries);
  cache = { at: now, value };
  return value;
}
