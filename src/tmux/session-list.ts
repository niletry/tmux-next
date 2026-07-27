import { tmux } from "./run";
import { validateRequestedName } from "./session-create";
import { WEB_SESSION_PREFIX } from "./session-manager";

export type SessionSummary = {
  name: string;
  windowWidth: number;
  windowHeight: number;
  lastActivityEpoch: number;
  attached: boolean;
  preview: string[];
  pendingInput: string | null;
  idle: boolean;
};

const PREVIEW_LINES = 4;

/** Box drawing only, or Claude Code chrome that carries no information. */
const CHROME = [
  /^[\s─│╭╮╰╯━┃┏┓┗┛|]*$/,
  /bypass permissions/,
  /enter to collapse/,
  /new task\? \/clear/,
  /^\s*\/rc\s*$/,
  /\? for shortcuts/,
];

/** Claude Code prints this when a turn finishes, e.g. "✻ Cogitated for 1m 21s". */
const IDLE_MARKER = /^\s*[✻✽✢·*]\s+\S+ for \d/;

export function extractPreview(screen: string): {
  preview: string[];
  pendingInput: string | null;
  idle: boolean;
} {
  let pendingInput: string | null = null;
  const kept: string[] = [];

  for (const line of screen.split("\n")) {
    const prompt = line.match(/^\s*❯\s?(.*)$/);
    if (prompt) {
      const text = prompt[1]!.trim();
      pendingInput = text.length > 0 ? text : null;
      continue;
    }
    if (CHROME.some((re) => re.test(line))) continue;
    kept.push(line.replace(/\s+$/, ""));
  }

  return {
    preview: kept.slice(-PREVIEW_LINES),
    pendingInput,
    idle: kept.some((l) => IDLE_MARKER.test(l)),
  };
}

/**
 * A separator of `|` is safe because every field before the name is numeric,
 * and the name comes last so it keeps any `|` of its own. A control character
 * such as tab cannot be used: tmux rewrites it to `_` unless a locale is set.
 */
const FIELD_SEP = "|";
const LIST_FORMAT =
  "#{window_width}|#{window_height}|#{session_activity}|#{session_attached}|#{session_name}";

export type KillResult = { ok: true } | { ok: false; reason: "missing" | "internal" };

/**
 * Kills a user session, taking every process inside it with it.
 *
 * The only destructive operation in the app. Web sessions are refused: they
 * are this app's own attach points, and killing one would cut off whoever is
 * connected through it. They are cleaned up by the reaper instead.
 *
 * The name reaches tmux as an argv entry, never a shell string, so a name
 * containing shell metacharacters is inert.
 *
 * The `=` prefix forces an exact match. Without it tmux resolves a target by
 * prefix and glob, so deleting a session called `web` would happily kill
 * `webmux` instead — unacceptable for an irreversible operation.
 */
export async function killSession(name: string): Promise<KillResult> {
  if (name.startsWith(WEB_SESSION_PREFIX)) return { ok: false, reason: "internal" };

  const exact = `=${name}`;
  if (!(await tmux(["has-session", "-t", exact])).ok) return { ok: false, reason: "missing" };

  // A web session grouped to the target shares its windows, so killing the
  // target alone would leave its processes running under the web session.
  // Destroy those first so the kill actually stops what is running, no matter
  // who is attached — including whoever triggered this from that same session.
  await killGroupedWebSessions(name);

  const killed = await tmux(["kill-session", "-t", exact]);
  return killed.ok ? { ok: true } : { ok: false, reason: "missing" };
}

/**
 * Kills every `web-*` session grouped to the target.
 *
 * A group's id is fixed when the group forms and does *not* follow a later
 * rename, so it can no longer be assumed equal to the current name. We read the
 * target's own `session_group` and match web sessions to that — which stays
 * correct after a rename, when the name and the group id diverge. An ungrouped
 * target reports an empty group and has no web sessions to kill.
 *
 * Name first in the format, group last: a web-* name has no `|`, so the split
 * stays exact even if the group id contains one.
 */
async function killGroupedWebSessions(target: string): Promise<void> {
  const listed = await tmux(["list-sessions", "-F", "#{session_name}|#{session_group}"]);
  if (!listed.ok) return;
  const lines = listed.stdout.split("\n").filter(Boolean);

  // Read the target's actual group from the listing. It can't be assumed equal
  // to the current name — a group's id is fixed when the group forms and does
  // not follow a rename — and `display-message` reports an empty session_group
  // for the very session being queried, so only list-sessions can supply it.
  // Anchoring on the known target length keeps this exact even if the name
  // itself contains a `|`. An empty group means no grouped web sessions exist.
  const prefix = target + "|";
  const row = lines.find((l) => l.startsWith(prefix));
  const group = row ? row.slice(prefix.length).replace(/^=/, "") : "";
  if (!group) return;

  for (const line of lines) {
    const sep = line.indexOf("|");
    if (sep < 0) continue;
    const sname = line.slice(0, sep);
    const sgroup = line.slice(sep + 1).replace(/^=/, "");
    if (sname.startsWith(WEB_SESSION_PREFIX) && sgroup === group) {
      await tmux(["kill-session", "-t", `=${sname}`]);
    }
  }
}

export type RenameResult =
  | { ok: true; name: string }
  | { ok: false; reason: "empty" | "reserved" | "invalid" | "missing" | "taken" | "internal" | "failed" };

/**
 * Renames a user session, leaving everything running inside it untouched.
 *
 * Only the name changes: the windows, their scrollback, and every process keep
 * running, and any web session grouped to it stays attached. Web sessions are
 * refused as a target — they are the app's own attach points, not something a
 * user renames — and the new name goes through the same validation as creation,
 * so it can still be targeted afterwards. The name reaches tmux as an argv
 * entry, never a shell string.
 */
export async function renameSession(from: string, to: string): Promise<RenameResult> {
  if (from.startsWith(WEB_SESSION_PREFIX)) return { ok: false, reason: "internal" };

  const checked = validateRequestedName(to);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  // A rename must name its target; validateRequestedName reads a blank/missing
  // value as "generate one", which makes no sense here.
  if (!checked.name) return { ok: false, reason: "empty" };

  const exact = `=${from}`;
  if (!(await tmux(["has-session", "-t", exact])).ok) return { ok: false, reason: "missing" };

  // Renaming to the current name is a no-op, not a collision.
  if (checked.name === from) return { ok: true, name: from };
  if ((await tmux(["has-session", "-t", `=${checked.name}`])).ok) {
    return { ok: false, reason: "taken" };
  }

  const renamed = await tmux(["rename-session", "-t", exact, checked.name]);
  return renamed.ok ? { ok: true, name: checked.name } : { ok: false, reason: "failed" };
}

export async function listSessions(): Promise<SessionSummary[]> {
  const listed = await tmux(["list-sessions", "-F", LIST_FORMAT]);
  if (!listed.ok) return [];

  const rows = listed.stdout.trim().split("\n").filter(Boolean);
  const summaries = await Promise.all(
    rows.map(async (row): Promise<SessionSummary | null> => {
      const parts = row.split(FIELD_SEP);
      if (parts.length < 5) return null;
      const [width, height, activity, attached] = parts as [string, string, string, string];
      const name = parts.slice(4).join(FIELD_SEP);

      // Web sessions are this app's own attach points, not something to show.
      if (name.startsWith(WEB_SESSION_PREFIX)) return null;

      // Visible screen only: -S pulls in stale wrapped scrollback (verified
      // against a session that had been squeezed to 2 columns).
      //
      // The trailing `:` matters. capture-pane resolves -t as a *pane*, and a
      // bare `=name` is not a valid pane spec — it fails with "can't find pane"
      // and silently leaves every preview empty. `=name:` names the current
      // pane of that session while `=` still forces an exact session match, so
      // a session called `web` cannot capture `webmux` instead.
      const captured = await tmux(["capture-pane", "-p", "-t", `=${name}:`]);
      const screen = captured.ok ? captured.stdout : "";
      return {
        name,
        windowWidth: Number(width),
        windowHeight: Number(height),
        lastActivityEpoch: Number(activity),
        attached: attached === "1",
        ...extractPreview(screen),
      };
    }),
  );

  // Most recently active first, and nothing else. The session you were just in
  // has the freshest activity, so it stays on top instead of being pushed below
  // every session Claude happens to be waiting on. Those still stand out by
  // their dot; they no longer jerk to the top and back as a turn starts and
  // finishes, which is what made the order feel unpredictable.
  return summaries
    .filter((s): s is SessionSummary => s !== null)
    .sort((a, b) => b.lastActivityEpoch - a.lastActivityEpoch);
}

/**
 * Orders directories by how many sessions sit in them, most used first.
 *
 * The create dialog defaults to the first entry, and in practice one project
 * dominates, so the common case needs no input at all. Ties fall back to
 * alphabetical order to keep the list from reshuffling between polls.
 */
export function rankDirectories(paths: string[]): string[] {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const trimmed = path.trim();
    if (trimmed) counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort(([aPath, aCount], [bPath, bCount]) => bCount - aCount || aPath.localeCompare(bPath))
    .map(([path]) => path);
}

/** Directories of the current sessions, most used first. */
export async function recentDirectories(): Promise<string[]> {
  // A dedicated call rather than a field on LIST_FORMAT: a path could contain
  // the separator, and only the session name is allowed to do that.
  const listed = await tmux(["list-sessions", "-F", "#{pane_current_path}"]);
  if (!listed.ok) return [];
  return rankDirectories(listed.stdout.split("\n"));
}

/**
 * Every live session name, web sessions included.
 *
 * Used to decide whether a requested name is taken. Cheaper than listSessions,
 * which runs capture-pane per session, and deliberately unfiltered: colliding
 * with one of this app's own attach points would fail just as hard.
 */
export async function sessionNames(): Promise<string[]> {
  const listed = await tmux(["list-sessions", "-F", "#{session_name}"]);
  if (!listed.ok) return [];
  return listed.stdout.split("\n").filter(Boolean);
}
