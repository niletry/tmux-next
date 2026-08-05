import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

/**
 * A small on-disk log of notifications that were sent, so a push swiped away on
 * the phone can still be found in the web UI. One JSONL line per notification,
 * trimmed to the most recent MAX so the file can't grow without bound.
 */

export type NotificationRecord = {
  ts: number; // epoch seconds
  event: string;
  session: string;
  title: string;
  body: string;
};

/** How many notifications the log keeps. */
export const MAX_NOTIFICATIONS = 200;

function notificationsPath(): string {
  return (
    process.env.TMUX_NEXT_NOTIFICATIONS_PATH ||
    join(homedir(), ".tmux-next", "notifications.jsonl")
  );
}

async function readAll(): Promise<NotificationRecord[]> {
  const file = Bun.file(notificationsPath());
  if (!(await file.exists())) return [];
  const text = await file.text();
  const out: NotificationRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as NotificationRecord);
    } catch {
      // skip a torn line
    }
  }
  return out;
}

/** Appends a record, keeping only the most recent MAX. */
export async function recordNotification(rec: NotificationRecord): Promise<void> {
  const path = notificationsPath();
  const kept = [...(await readAll()), rec].slice(-MAX_NOTIFICATIONS);
  await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
  await Bun.write(path, kept.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** The most recent notifications, newest first, at most `limit`. */
export async function readNotifications(limit = 50): Promise<NotificationRecord[]> {
  const all = await readAll();
  return all.slice(-limit).reverse();
}
