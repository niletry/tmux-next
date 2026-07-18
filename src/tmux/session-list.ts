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

export async function listSessions(): Promise<SessionSummary[]> {
  const fmt =
    "#{session_name}\t#{window_width}\t#{window_height}\t#{session_activity}\t#{session_attached}";
  const listed = await Bun.$`tmux list-sessions -F ${fmt}`.quiet().nothrow();
  if (listed.exitCode !== 0) return [];

  const rows = listed.stdout.toString().trim().split("\n").filter(Boolean);
  const summaries = await Promise.all(
    rows.map(async (row): Promise<SessionSummary> => {
      const [name, width, height, activity, attached] = row.split("\t") as [
        string, string, string, string, string,
      ];
      // Visible screen only: -S pulls in stale wrapped scrollback (verified
      // against a session that had been squeezed to 2 columns).
      const captured = await Bun.$`tmux capture-pane -p -t ${name}`.quiet().nothrow();
      const screen = captured.exitCode === 0 ? captured.stdout.toString() : "";
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
  return summaries.sort(
    (a, b) => Number(b.idle) - Number(a.idle) || b.lastActivityEpoch - a.lastActivityEpoch,
  );
}
