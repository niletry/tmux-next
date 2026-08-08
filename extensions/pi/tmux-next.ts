/**
 * tmux-next notifications for pi.
 *
 * Copy to ~/.pi/agent/extensions/tmux-next.ts (or run `bunx tmux-next hook`).
 *
 * pi loads extensions into its own process, which runs on Node — so this uses
 * only Node built-ins. An earlier draft used `Bun.spawn` and failed with
 * "Bun is not defined", silently, because an extension that throws inside an
 * event handler takes no notifications with it and says nothing.
 */

import { execFile } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const DEFAULT_PORT = 7682;
const WEB_PREFIX = "web-";

function notifyUrl(): string {
  const parsed = Number(process.env.TMUX_NEXT_PORT);
  const port = Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT;
  return `http://127.0.0.1:${port}/api/notify`;
}

/**
 * The user session this pane belongs to.
 *
 * `list-panes -a`, never `display-message -t <pane> '#{session_name}'`: a pane
 * belongs to every session grouped onto its window, and that second form
 * collapses the set to the most recently created — which is always tmux-next's
 * own `web-*` mount point while a browser is watching. Using it made the Claude
 * hooks skip precisely the sessions someone had open, silently.
 */
async function tmuxSession(): Promise<string | null> {
  const pane = process.env.TMUX_PANE;
  if (!process.env.TMUX || !pane) return null;
  try {
    const { stdout } = await run("tmux", [
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}|#{session_name}",
    ]);
    for (const line of stdout.split("\n")) {
      const sep = line.indexOf("|");
      if (sep === -1 || line.slice(0, sep) !== pane) continue;
      // pane_id first and the name last, so a `|` inside a name survives.
      const name = line.slice(sep + 1).trim();
      if (name && !name.startsWith(WEB_PREFIX)) return name;
    }
  } catch {
    // tmux absent, or not running under it.
  }
  return null;
}

/** Fire-and-forget: pi must never wait on this, and a failure is not actionable. */
function post(body: unknown): void {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  fetch(notifyUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}

export default function tmuxNext(pi: any) {
  /**
   * Bind this conversation to its tmux session, so tmux-next can bring it back
   * after a reboot and show what it is working on.
   *
   * Written to disk rather than posted: the record has to outlive tmux-next not
   * running, which is the entire reason it exists. Same shape and directory as
   * Claude Code's shell hook writes.
   *
   * The id lives on ctx.sessionManager — not on the event, which carries only
   * `{type, reason}`.
   */
  pi.on("session_start", async (_event: any, ctx: any) => {
    const session = await tmuxSession();
    const id = ctx?.sessionManager?.sessionId;
    if (!session || !id) return;
    try {
      const dir = join(process.env.HOME ?? "", ".tmux-next", "sessions");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${id}.json`),
        JSON.stringify({ agent: "pi", id, session, cwd: ctx?.cwd ?? process.cwd() }),
      );
    } catch {
      // tmux-next not set up here; nothing to record into.
    }
  });

  /**
   * Waiting on the user.
   *
   * `agent_settled`, not `turn_end`. pi repeats a turn for every tool the model
   * calls, so turn_end fires many times inside one reply and would push a
   * notification for each. agent_settled is documented as "no retry, compaction
   * or follow-up left" — where control genuinely comes back, which is what
   * Claude Code's Stop means. Verified against a real session: turn_end fired
   * before agent_end, and agent_settled last.
   */
  pi.on("agent_settled", async () => {
    const session = await tmuxSession();
    if (session) post({ event: "waiting", session });
  });

  pi.on("session_shutdown", async () => {
    const session = await tmuxSession();
    if (session) post({ event: "ended", session });
  });
}
