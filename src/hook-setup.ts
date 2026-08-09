import { homedir } from "node:os";
import { join } from "node:path";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

type Settings = Record<string, unknown>;
type HookEntry = { type?: string; command?: string };
type HookGroup = { matcher?: string; hooks?: HookEntry[] };

/**
 * Adds a command hook under `event` to a settings object, unless the exact same
 * command is already registered for that event.
 *
 * Pure on purpose: this is the part that could clobber a user's Claude config,
 * so it's tested in isolation. Everything already in the object is preserved —
 * other hook events, other entries under this event, and every unrelated key.
 */
export function addCommandHook(
  settings: Settings,
  event: string,
  command: string,
): { settings: Settings; added: boolean } {
  const base: Settings =
    typeof settings === "object" && settings !== null && !Array.isArray(settings) ? settings : {};
  const out: Settings = { ...base };

  const hooks: Record<string, unknown> =
    typeof out.hooks === "object" && out.hooks !== null && !Array.isArray(out.hooks)
      ? { ...(out.hooks as Record<string, unknown>) }
      : {};
  const list: HookGroup[] = Array.isArray(hooks[event]) ? [...(hooks[event] as HookGroup[])] : [];

  const already = list.some(
    (g) => Array.isArray(g?.hooks) && g.hooks.some((h) => h?.command === command),
  );
  if (already) return { settings: out, added: false };

  list.push({ hooks: [{ type: "command", command }] });
  hooks[event] = list;
  out.hooks = hooks;
  return { settings: out, added: true };
}

/** Back-compat alias for the original SessionStart-only helper. */
export function addSessionStartHook(
  settings: Settings,
  command: string,
): { settings: Settings; added: boolean } {
  return addCommandHook(settings, "SessionStart", command);
}

const scriptSource = (name: string): string =>
  new URL(`../hooks/${name}`, import.meta.url).pathname;

/** The notify script is registered under these Claude events. */
const NOTIFY_EVENTS = ["Stop", "SessionEnd", "Notification"];

/**
 * Installs the tmux-next Claude hooks.
 *
 * Two scripts into ~/.claude/hooks: the SessionStart recorder (for restore) and
 * the notify reporter (Stop / SessionEnd / Notification → phone push). Both are
 * registered in settings.json in a single write, backing the file up first and
 * refusing to add a duplicate, so running it twice is harmless.
 */
/**
 * Copies the opencode and pi extensions into place.
 *
 * Best-effort: an agent that is not installed has no directory to copy into,
 * and that is not a failure of `tmux-next hook` — most people run one agent.
 */
async function installAgentExtensions(): Promise<void> {
  const targets = [
    {
      name: "pi",
      src: new URL("../extensions/pi/tmux-next.ts", import.meta.url).pathname,
      dir: join(homedir(), ".pi", "agent", "extensions"),
      note: "pi discovers this directory on its own — nothing else to configure",
    },
    {
      name: "opencode",
      src: new URL("../extensions/opencode/tmux-next.ts", import.meta.url).pathname,
      dir: join(homedir(), ".config", "opencode", "extensions"),
      note: "also add this path to the `plugin` array in opencode.json",
    },
  ];

  for (const t of targets) {
    try {
      await mkdir(t.dir, { recursive: true });
      const dest = join(t.dir, "tmux-next.ts");
      await copyFile(t.src, dest);
      console.log(`installed ${t.name} extension → ${dest}`);
      console.log(`  ${t.note}`);
    } catch {
      // Agent not installed here; nothing to do.
    }
  }
}

export async function installHook(): Promise<void> {
  const claudeDir = join(homedir(), ".claude");
  const hooksDir = join(claudeDir, "hooks");
  await mkdir(hooksDir, { recursive: true });

  const sessionDest = join(hooksDir, "tmux-next-session.sh");
  const notifyDest = join(hooksDir, "tmux-next-notify.sh");
  for (const [srcName, dest] of [
    ["tmux-next-session.sh", sessionDest],
    ["tmux-next-notify.sh", notifyDest],
  ] as const) {
    await copyFile(scriptSource(srcName), dest);
    await chmod(dest, 0o755);
    console.log(`installed hook script → ${dest}`);
  }

  // The other two agents load extensions from their own directories rather
  // than through a settings file. Copying is enough for pi (it discovers
  // ~/.pi/agent/extensions automatically); opencode additionally needs the
  // path listed in its config, which is left to the user because that file is
  // hand-maintained and holds their provider credentials.
  await installAgentExtensions();

  const settingsPath = join(claudeDir, "settings.json");
  let settings: Settings = {};
  let existing: string | null = null;
  try {
    existing = await readFile(settingsPath, "utf8");
    settings = JSON.parse(existing) as Settings;
  } catch {
    // no settings file yet, or it isn't readable JSON — start from empty
  }

  let added = false;
  let r = addCommandHook(settings, "SessionStart", sessionDest);
  settings = r.settings;
  added ||= r.added;
  for (const event of NOTIFY_EVENTS) {
    r = addCommandHook(settings, event, notifyDest);
    settings = r.settings;
    added ||= r.added;
  }

  if (!added) {
    console.log("hooks already registered — nothing to change.");
    return;
  }

  if (existing !== null) {
    await writeFile(`${settingsPath}.bak`, existing);
    console.log(`backed up settings.json → ${settingsPath}.bak`);
  }
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`registered the hooks in ${settingsPath}`);
  console.log(
    "\nDone. New Claude sessions started in tmux will be recorded (for restore) and\n" +
      "will report turn-end / session-end / attention events for push notifications.\n" +
      "Sessions already running won't take effect until they restart. Requires jq and\n" +
      "curl on PATH. Enable notifications in the tmux-next web UI to receive them.",
  );
}
