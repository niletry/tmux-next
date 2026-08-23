import { tmux } from "./run";
import { validateRequestedName } from "./session-create";
import { WEB_SESSION_PREFIX } from "./session-manager";
import { readPins, setPin, renamePin } from "../pins";
import {
  forgetSession,
  renameSessionRecords,
  readSessionRecords,
  dedupeBySession,
} from "../claude-sessions";
import { nextStamp, type ActivityEntry } from "./activity-stamp";
import { agentOf, DEFAULT_AGENT } from "../agents";
import { agentVersion, versionFromCommand } from "../agents/version";

export type SessionSummary = {
  name: string;
  windowWidth: number;
  windowHeight: number;
  lastActivityEpoch: number;
  attached: boolean;
  preview: string[];
  pendingInput: string | null;
  idle: boolean;
  pinned: boolean;
  // The Claude conversation id bound to this session by the SessionStart hook,
  // if one is on record. Absent for sessions started before the hook was set
  // up, and for anything that isn't Claude Code.
  claudeId: string | null;
  // The latest thing this conversation was asked to do, from its transcript.
  // Null when the session is not Claude, has no binding record, or predates
  // Claude Code writing the record at all.
  task: string | null;
  // The agent the binding record names, and its display label. A record that
  // predates multi-agent support is Claude Code's — its hook wrote it without
  // an agent field — so it resolves to the default. Only sessions with no
  // record at all are null: the client shows no marker then, rather than
  // guessing what runs in a session it never saw launched.
  agent: string | null;
  agentLabel: string | null;
  // The agent's build, as precisely as it can be known: Claude's pane command
  // is its versioned binary, opencode and pi answer `--version` (cached). Null
  // when neither applies — the client shows the plain label then.
  version: string | null;
};

const PREVIEW_LINES = 4;

/**
 * Reads a screen, using the calling agent's idea of what its own TUI looks like.
 *
 * Defaults to Claude Code so every existing caller and test keeps its previous
 * behaviour; sessions started under another agent pass that agent's rules.
 */
export function extractPreview(
  screen: string,
  agentId?: unknown,
): {
  preview: string[];
  pendingInput: string | null;
  idle: boolean;
} {
  const { chrome: CHROME, idleMarker: IDLE_MARKER } = agentOf(agentId).screen;
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
// window_activity, not session_activity: the latter only advances while a
// client is attached, so on the detached sessions this app lists it stays
// frozen at creation time. window_activity tracks pane output regardless of
// attachment — but it advances on any repaint (spinner, status line), so on its
// own it reads "just now" for every live Claude session. We use it only as the
// seed for a session first seen this process; the shown time then follows
// actual visible-content changes (see activity-stamp and the capture loop).
//
// pane_current_command rides along for free: for a Claude session it is the
// versioned binary name (2.1.223), which is the version marker. The name stays
// last so it keeps any `|` of its own; the command sits before it and is a
// process basename, which cannot contain the separator in practice.
const LIST_FORMAT =
  "#{window_width}|#{window_height}|#{window_activity}|#{session_attached}|#{pane_current_command}|#{session_name}";

// Per-session record of the last visible-screen change, keyed by session name.
// Lives for the life of the server process; seeded from window_activity on
// first sight so a restart doesn't reset every session to "just now". Pruned to
// the live sessions on each poll so it can't grow without bound.
const activityStore = new Map<string, ActivityEntry>();

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
  if (killed.ok) {
    await setPin(name, false); // drop a pin for a session that's gone
    await forgetSession(name); // and its restore record — this end was deliberate
  }
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
  if (renamed.ok) {
    await renamePin(from, checked.name); // keep a pin with its session
    await renameSessionRecords(from, checked.name); // and its restore record
  }
  return renamed.ok ? { ok: true, name: checked.name } : { ok: false, reason: "failed" };
}

export async function listSessions(): Promise<SessionSummary[]> {
  const listed = await tmux(["list-sessions", "-F", LIST_FORMAT]);
  if (!listed.ok) return [];

  const rows = listed.stdout.trim().split("\n").filter(Boolean);
  const pinnedSet = new Set(await readPins());

  // The hook records one file per Claude launch; dedupe keeps the newest per
  // session name, which is the conversation currently running under that name.
  // Joined by the live session name, so a rename (which rewrites the record)
  // still lines up.
  const recordByName = new Map(
    dedupeBySession(await readSessionRecords()).map((r) => [r.session, r]),
  );
  const claudeIdByName = new Map(
    [...recordByName].map(([name, r]) => [name, r.id]),
  );

  const now = Math.floor(Date.now() / 1000);

  const summaries = await Promise.all(
    rows.map(async (row): Promise<SessionSummary | null> => {
      const parts = row.split(FIELD_SEP);
      if (parts.length < 6) return null;
      const [width, height, activity, attached, command] = parts as [
        string,
        string,
        string,
        string,
        string,
      ];
      const name = parts.slice(5).join(FIELD_SEP);

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
      const parsed = extractPreview(screen);

      // "Last updated" tracks when the *shown* content last changed — the
      // preview lines, with chrome already stripped — not every repaint.
      // Hashing the raw screen instead let a cursor blink, a spinner, or a
      // global redraw (tmux repaints many windows at once) count as an update,
      // which stamped whole batches of idle sessions with one identical time. A
      // failed capture is not a change: keep the prior stamp (or the
      // window_activity seed) rather than reading the empty string as one.
      let lastActivityEpoch: number;
      if (captured.ok) {
        const entry = nextStamp(
          activityStore.get(name),
          String(Bun.hash(parsed.preview.join("\n"))),
          Number(activity),
          now,
        );
        activityStore.set(name, entry);
        lastActivityEpoch = entry.epoch;
      } else {
        lastActivityEpoch = activityStore.get(name)?.epoch ?? Number(activity);
      }

      // What the conversation was last asked to do. Only a tail read, and only
      // where the hook recorded both an id and a cwd — the two together locate
      // the transcript without having to search for it.
      const record = recordByName.get(name);
      // Whichever agent the binding record names. Records without an agent
      // field were written by Claude Code's hook before multi-agent support,
      // so they are Claude Code; only a missing record stays unknown.
      const agentId = record ? (record.agent ?? DEFAULT_AGENT) : null;
      const agent = agentOf(record?.agent);
      const task =
        record?.cwd !== undefined && agent.readTask
          ? await agent.readTask(record.cwd, record.id)
          : null;

      // Precise build: Claude's pane command is its versioned binary, and
      // opencode / pi answer --version (cached per process). Anything else
      // stays null — the client shows the plain label then.
      const commandVersion = versionFromCommand(command);
      const version =
        commandVersion ??
        (agentId === "opencode" || agentId === "pi" ? await agentVersion(agentId) : null);

      return {
        name,
        windowWidth: Number(width),
        windowHeight: Number(height),
        lastActivityEpoch,
        attached: attached === "1",
        pinned: pinnedSet.has(name),
        claudeId: claudeIdByName.get(name) ?? null,
        task,
        // Expose the record's agent so the list can mark it; null keeps an
        // unmarked card for sessions with no record at all.
        agent: agentId,
        agentLabel: agentId ? agent.label : null,
        version,
        ...parsed,
      };
    }),
  );

  // Forget sessions that are gone so the store can't grow without bound. Web
  // sessions never enter it (skipped above), so the live set is the user names.
  const live = new Set(summaries.filter((s): s is SessionSummary => s !== null).map((s) => s.name));
  for (const name of activityStore.keys()) {
    if (!live.has(name)) activityStore.delete(name);
  }

  // Pinned first, then most recently active. Pinning is the one deliberate
  // override of the recency order; within each group the freshest leads, so the
  // session you were just in still rises to the top of its group. Sessions
  // waiting on you stand out by their dot rather than by reordering.
  return summaries
    .filter((s): s is SessionSummary => s !== null)
    .sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivityEpoch - a.lastActivityEpoch,
    );
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
