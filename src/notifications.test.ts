import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordNotification, readNotifications, MAX_NOTIFICATIONS } from "./notifications";

let root: string;
let saved: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "notif-"));
  saved = process.env.TMUX_NEXT_NOTIFICATIONS_PATH;
  process.env.TMUX_NEXT_NOTIFICATIONS_PATH = join(root, "notifications.jsonl");
});

afterEach(async () => {
  if (saved === undefined) delete process.env.TMUX_NEXT_NOTIFICATIONS_PATH;
  else process.env.TMUX_NEXT_NOTIFICATIONS_PATH = saved;
  await rm(root, { recursive: true, force: true });
});

const rec = (session: string, ts: number) => ({
  ts,
  event: "waiting",
  session,
  title: session,
  body: "聊完了",
});

test("readNotifications is empty before anything is recorded", async () => {
  expect(await readNotifications()).toEqual([]);
});

test("recorded notifications come back newest first", async () => {
  await recordNotification(rec("a", 1000));
  await recordNotification(rec("b", 2000));
  await recordNotification(rec("c", 3000));
  const out = await readNotifications();
  expect(out.map((n) => n.session)).toEqual(["c", "b", "a"]);
});

test("readNotifications honours the limit", async () => {
  for (let i = 0; i < 5; i++) await recordNotification(rec(`s${i}`, 1000 + i));
  expect((await readNotifications(2)).map((n) => n.session)).toEqual(["s4", "s3"]);
});

test("the log is trimmed to the most recent MAX", async () => {
  for (let i = 0; i < MAX_NOTIFICATIONS + 10; i++) await recordNotification(rec(`s${i}`, i));
  const all = await readNotifications(MAX_NOTIFICATIONS + 100);
  expect(all.length).toBe(MAX_NOTIFICATIONS);
  // The oldest 10 fell off; the newest is last-written.
  expect(all[0]!.session).toBe(`s${MAX_NOTIFICATIONS + 9}`);
  expect(all.at(-1)!.session).toBe("s10");
});
