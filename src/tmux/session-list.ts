import { tmux } from "./run";
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

  const killed = await tmux(["kill-session", "-t", exact]);
  return killed.ok ? { ok: true } : { ok: false, reason: "missing" };
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
      const captured = await tmux(["capture-pane", "-p", "-t", `=${name}`]);
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

  // Sessions waiting on the user first, then most recently active.
  return summaries
    .filter((s): s is SessionSummary => s !== null)
    .sort(
      (a, b) => Number(b.idle) - Number(a.idle) || b.lastActivityEpoch - a.lastActivityEpoch,
    );
}
