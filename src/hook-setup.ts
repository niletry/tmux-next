import { homedir } from "node:os";
import { join } from "node:path";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

type Settings = Record<string, unknown>;
type HookEntry = { type?: string; command?: string };
type HookGroup = { matcher?: string; hooks?: HookEntry[] };

/**
 * Adds a SessionStart command hook to a settings object, unless the exact same
 * command is already there.
 *
 * Pure on purpose: this is the part that could clobber a user's Claude config,
 * so it's tested in isolation. Everything already in the object is preserved —
 * other hook events, other SessionStart entries, and every unrelated key.
 */
export function addSessionStartHook(
  settings: Settings,
  command: string,
): { settings: Settings; added: boolean } {
  const base: Settings =
    typeof settings === "object" && settings !== null && !Array.isArray(settings) ? settings : {};
  const out: Settings = { ...base };

  const hooks: Record<string, unknown> =
    typeof out.hooks === "object" && out.hooks !== null && !Array.isArray(out.hooks)
      ? { ...(out.hooks as Record<string, unknown>) }
      : {};
  const list: HookGroup[] = Array.isArray(hooks.SessionStart)
    ? [...(hooks.SessionStart as HookGroup[])]
    : [];

  const already = list.some(
    (g) => Array.isArray(g?.hooks) && g.hooks.some((h) => h?.command === command),
  );
  if (already) return { settings: out, added: false };

  list.push({ hooks: [{ type: "command", command }] });
  hooks.SessionStart = list;
  out.hooks = hooks;
  return { settings: out, added: true };
}

const hookScriptSource = (): string =>
  new URL("../hooks/tmux-next-session.sh", import.meta.url).pathname;

/**
 * Installs the SessionStart hook so Claude sessions get recorded for restore.
 *
 * Copies the bundled script into ~/.claude/hooks and registers it in
 * settings.json, backing the file up first and refusing to add a duplicate, so
 * running it twice is harmless.
 */
export async function installHook(): Promise<void> {
  const claudeDir = join(homedir(), ".claude");
  const dest = join(claudeDir, "hooks", "tmux-next-session.sh");

  await mkdir(join(claudeDir, "hooks"), { recursive: true });
  await copyFile(hookScriptSource(), dest);
  await chmod(dest, 0o755);
  console.log(`installed hook script → ${dest}`);

  const settingsPath = join(claudeDir, "settings.json");
  let settings: Settings = {};
  let existing: string | null = null;
  try {
    existing = await readFile(settingsPath, "utf8");
    settings = JSON.parse(existing) as Settings;
  } catch {
    // no settings file yet, or it isn't readable JSON — start from empty
  }

  const { settings: next, added } = addSessionStartHook(settings, dest);
  if (!added) {
    console.log("SessionStart hook already registered — nothing to change.");
    return;
  }

  if (existing !== null) {
    await writeFile(`${settingsPath}.bak`, existing);
    console.log(`backed up settings.json → ${settingsPath}.bak`);
  }
  await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`registered the hook in ${settingsPath}`);
  console.log(
    "\nDone. New Claude sessions started in tmux will be recorded, so tmux-next can\n" +
      "restore them after a reboot. Sessions already running won't be recorded until\n" +
      "they restart. Requires jq on PATH.",
  );
}
