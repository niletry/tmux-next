/**
 * tmux-next notifications for opencode.
 *
 * Install by adding this file's path to the `plugin` array in
 * ~/.config/opencode/opencode.json, or run `bunx tmux-next hook`.
 *
 * Same shape as the pi extension and for the same reasons — opencode loads it
 * into its own process, so it resolves the tmux session inline and never
 * throws. The difference is which events exist: opencode has a dedicated
 * `permission.ask`, which maps to "needs your confirmation" more precisely than
 * anything Claude Code exposes.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const run = promisify(execFile);

const DEFAULT_PORT = 7682;
const WEB_PREFIX = "web-";

function notifyUrl(): string {
  const parsed = Number(process.env.TMUX_NEXT_PORT);
  const port =
    Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT;
  return `http://127.0.0.1:${port}/api/notify`;
}

/** See the pi extension: list-panes, never display-message. */
async function tmuxSession(): Promise<string | null> {
  const pane = process.env.TMUX_PANE;
  if (!process.env.TMUX || !pane) return null;
  try {
    // Node built-ins only. opencode loads plugins into its own process and an
    // earlier draft used Bun.spawn here, which threw "Bun is not defined" and
    // took every notification with it — silently, because a plugin that throws
    // inside a handler reports nothing.
    const { stdout } = await run("tmux", [
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}|#{session_name}",
    ]);
    for (const line of stdout.split("\n")) {
      const sep = line.indexOf("|");
      if (sep === -1 || line.slice(0, sep) !== pane) continue;
      const name = line.slice(sep + 1).trim();
      if (name && !name.startsWith(WEB_PREFIX)) return name;
    }
  } catch {
    // not under tmux
  }
  return null;
}

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

export const server = async (input: any) => ({
  /**
   * Fires whenever opencode wants the user to approve something — the closest
   * equivalent to Claude Code's Notification event, and more precise: this one
   * only means "blocked on you", never anything else.
   */
  "permission.ask": async (_input: any, _output: any) => {
    const session = await tmuxSession();
    // No message: the server fills in the canned text in the interface
    // language. An extension cannot reach the dictionary — it runs inside
    // opencode — so hard-coding one language here would pin the lock screen
    // to it regardless of the setting.
    if (session) post({ event: "attention", session });
  },

  /**
   * The generic stream. `session.idle` is what marks a finished turn; other
   * event types are ignored rather than guessed at, since this is a tool we do
   * not control and its event set will grow.
   */
  event: async ({ event }: any) => {
    // A new conversation: bind it to its tmux session on disk — same shape and
    // directory as Claude Code's shell hook and the pi extension write — so
    // tmux-next can restore it after a reboot and mark its agent in the list.
    // opencode's session id and project directory ride on the event's info.
    if (event?.type === "session.created") {
      const info = event.properties?.info;
      if (info?.id && info?.directory) {
        const tmuxName = await tmuxSession();
        if (tmuxName) {
          try {
            const dir = join(process.env.HOME ?? "", ".tmux-next", "sessions");
            await mkdir(dir, { recursive: true });
            await writeFile(
              join(dir, `${info.id}.json`),
              JSON.stringify({
                agent: "opencode",
                id: info.id,
                session: tmuxName,
                cwd: info.directory,
              }),
            );
          } catch {
            // tmux-next not set up here; nothing to record into.
          }
        }
      }
      return;
    }
    if (event?.type !== "session.idle") return;
    const session = await tmuxSession();
    if (session) post({ event: "waiting", session });
  },
});
