import { homedir } from "node:os";
import { join } from "node:path";
import { stat } from "node:fs/promises";

/**
 * The installed version of an agent, for the session list's precise marker.
 *
 * Claude needs no probe: its launcher execs a versioned binary, so the pane's
 * current command *is* the version (`2.1.223`), read off the tmux format
 * string for free. opencode and pi run under plain names (`opencode`, `node`),
 * so their version comes from one `--version` call, cached: a quarter-second
 * probe per agent, not per session.
 *
 * The value is the installed build — which is what the launcher starts — so it
 * is accurate for every live session of that agent. A probe that fails (agent
 * not installed, or the server cannot see it) degrades to null, which the
 * client shows as a plain name badge.
 */

const cache = new Map<string, { value: string | null; at: number }>();
const TTL_MS = 60 * 60 * 1000;

/** The version-shaped pane command, or null. Claude's binary is its version. */
export function versionFromCommand(command: string): string | null {
  const v = command.trim();
  return /^\d+\.\d+\.\d+$/.test(v) ? v : null;
}

/** The installed version of an agent, or null when it cannot be found. */
export async function agentVersion(id: "opencode" | "pi"): Promise<string | null> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await probe(id);
  cache.set(id, { value, at: Date.now() });
  return value;
}

/** `pi --version` lives under ~/.bun/bin, which launchd's bare PATH lacks. */
async function findBin(name: string): Promise<string | null> {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  dirs.push(join(homedir(), ".bun", "bin"));
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // not here; keep looking
    }
  }
  return null;
}

async function probe(id: "opencode" | "pi"): Promise<string | null> {
  const bin = await findBin(id);
  if (!bin) return null;
  try {
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const v = out.trim().split("\n")[0]?.trim();
    return v && /^[\w.+-]+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}
