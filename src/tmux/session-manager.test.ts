import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  WEB_SESSION_PREFIX,
  createWebSession,
  destroyWebSession,
  reapOrphanWebSessions,
} from "./session-manager";

const BASE = "sm-test-" + Math.random().toString(36).slice(2, 8);

const exists = async (name: string) =>
  (await Bun.$`tmux has-session -t ${name}`.quiet().nothrow()).exitCode === 0;

const query = async (target: string, format: string) =>
  (await Bun.$`tmux display-message -p -t ${target} ${format}`.quiet()).stdout.toString().trim();

beforeAll(async () => {
  await Bun.$`tmux new-session -d -s ${BASE} -x 120 -y 40`.quiet();
});

afterAll(async () => {
  await Bun.$`tmux kill-session -t ${BASE}`.quiet().nothrow();
  await reapOrphanWebSessions();
});

test("creates a grouped session sharing the target's windows", async () => {
  const name = await createWebSession(BASE);
  expect(name.startsWith(WEB_SESSION_PREFIX)).toBe(true);
  expect(await exists(name)).toBe(true);
  expect(await query(name, "#{window_id}")).toBe(await query(BASE, "#{window_id}"));
  await destroyWebSession(name);
});

test("sets aggressive-resize so unshared windows keep their own size", async () => {
  const name = await createWebSession(BASE);
  const opt = (await Bun.$`tmux show-options -t ${name} aggressive-resize`.quiet())
    .stdout.toString();
  expect(opt).toContain("on");
  await destroyWebSession(name);
});

test("does not change the target window size on creation", async () => {
  const before = await query(BASE, "#{window_width}x#{window_height}");
  const name = await createWebSession(BASE);
  expect(await query(BASE, "#{window_width}x#{window_height}")).toBe(before);
  await destroyWebSession(name);
});

test("destroy removes the session", async () => {
  const name = await createWebSession(BASE);
  await destroyWebSession(name);
  expect(await exists(name)).toBe(false);
});

test("reap removes unattached web sessions and leaves other sessions alone", async () => {
  const name = await createWebSession(BASE);
  const reaped = await reapOrphanWebSessions();
  expect(reaped).toContain(name);
  expect(await exists(name)).toBe(false);
  expect(await exists(BASE)).toBe(true);
});

test("createWebSession rejects for a target that does not exist", async () => {
  await expect(createWebSession("no-such-session-xyz")).rejects.toThrow();
});

test("destroyWebSession refuses to touch a session outside the web prefix", async () => {
  await expect(destroyWebSession(BASE)).rejects.toThrow(/refusing/);
  expect(await exists(BASE)).toBe(true);
});
