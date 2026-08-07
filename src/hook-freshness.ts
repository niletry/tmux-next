import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

/**
 * Detects hooks that were installed from an older version of this package.
 *
 * `tmux-next hook` copies the scripts into ~/.claude/hooks rather than pointing
 * at the ones inside the package, which is what lets them keep working when the
 * package is not on PATH. The cost is that upgrading npm does not upgrade them:
 * a fixed hook sits in node_modules while the stale copy keeps running.
 *
 * That failure mode is silent by construction — hooks are meant to never
 * disturb Claude, so a broken one produces no output anywhere. The
 * grouped-session bug lived like that: bindings and pushes simply stopped for
 * any session a browser had open, with nothing to notice.
 *
 * Comparing contents rather than a version string keeps this honest with no
 * bookkeeping: the files either match what this build ships or they do not.
 */
const HOOK_NAMES = ["tmux-next-session.sh", "tmux-next-notify.sh"];

const PACKAGED_DIR = new URL("../hooks/", import.meta.url).pathname;

/**
 * The installed hook scripts that differ from the ones this build ships.
 *
 * A script that was never installed is not reported: the user has not opted
 * into the feature, and startup is no place to advertise it. Any read failure
 * yields "nothing stale" — a diagnostic must never be the reason a server
 * refuses to start.
 */
export async function staleHooks(
  home: string = homedir(),
  packagedDir: string = PACKAGED_DIR,
): Promise<string[]> {
  const installedDir = join(home, ".claude", "hooks");
  const stale: string[] = [];

  for (const name of HOOK_NAMES) {
    let installed: string;
    try {
      installed = await readFile(join(installedDir, name), "utf8");
    } catch {
      continue; // not installed — nothing to say
    }
    try {
      const packaged = await readFile(join(packagedDir, name), "utf8");
      if (packaged !== installed) stale.push(name);
    } catch {
      // No packaged copy to compare against; stay quiet rather than guess.
    }
  }
  return stale;
}

/** The startup line, or null when everything is current. */
export function staleHookMessage(stale: string[]): string | null {
  if (stale.length === 0) return null;
  return (
    `warning: ${stale.length} installed Claude hook${stale.length > 1 ? "s are" : " is"} ` +
    `out of date (${stale.join(", ")}).\n` +
    "         Re-run `bunx tmux-next hook` to update them — an outdated hook\n" +
    "         fails silently, taking session restore and push notifications with it."
  );
}
