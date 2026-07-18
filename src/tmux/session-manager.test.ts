import { afterAll, beforeAll, expect, test } from "bun:test";
import { tmux } from "./run";
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

test("reap removes web sessions this process does not own", async () => {
  // Simulates a leftover from a previous server run: it carries the web prefix
  // but was never handed out by createWebSession.
  const stray = WEB_SESSION_PREFIX + "stray" + Math.random().toString(36).slice(2, 6);
  await tmux(["new-session", "-d", "-t", BASE, "-s", stray]);
  expect(await exists(stray)).toBe(true);

  const reaped = await reapOrphanWebSessions();
  expect(reaped).toContain(stray);
  expect(await exists(stray)).toBe(false);
  expect(await exists(BASE)).toBe(true);
});

test("reap leaves a web session that is currently in use", async () => {
  const inUse = await createWebSession(BASE);
  try {
    const reaped = await reapOrphanWebSessions();
    expect(reaped).not.toContain(inUse);
    expect(await exists(inUse)).toBe(true);
  } finally {
    await destroyWebSession(inUse);
  }
});

test("reap collects a session whose control client leaked and left it attached", async () => {
  const stray = WEB_SESSION_PREFIX + "leak" + Math.random().toString(36).slice(2, 6);
  await tmux(["new-session", "-d", "-t", BASE, "-s", stray]);
  // A leaked `tmux -C attach` holds the session attached, which is exactly the
  // case an "unattached only" reaper could never collect.
  const leaked = Bun.spawn(["tmux", "-C", "attach", "-t", stray], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  await Bun.sleep(400);

  const reaped = await reapOrphanWebSessions();
  expect(reaped).toContain(stray);
  expect(await exists(stray)).toBe(false);
  leaked.kill();
});

test("createWebSession rejects for a target that does not exist", async () => {
  await expect(createWebSession("no-such-session-xyz")).rejects.toThrow();
});

test("destroyWebSession refuses to touch a session outside the web prefix", async () => {
  await expect(destroyWebSession(BASE)).rejects.toThrow(/refusing/);
  expect(await exists(BASE)).toBe(true);
});
