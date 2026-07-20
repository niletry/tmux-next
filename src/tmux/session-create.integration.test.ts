import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, LAUNCH_COMMAND } from "./session-create";
import { tmux } from "./run";

/** Long-lived but inert, so a leaked session cannot burn CPU. */
const IDLE = "sleep 120";

const made: string[] = [];

async function create(dir: string, requested?: string | null, existing: string[] = []) {
  const result = await createSession(dir, requested, existing, IDLE);
  if (result.ok) made.push(result.name);
  return result;
}

afterEach(async () => {
  for (const name of made.splice(0)) {
    await tmux(["kill-session", "-t", `=${name}`]);
  }
});

function scratch() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "create-")));
  // A predictable leaf name keeps the generated session name checkable.
  const dir = join(base, `probe-${crypto.randomUUID().slice(0, 8)}`);
  mkdirSync(dir);
  return { base, dir, leaf: dir.slice(dir.lastIndexOf("/") + 1) };
}

test("creating a session names it after the directory", async () => {
  const { base, dir, leaf } = scratch();
  try {
    const result = await create(dir);
    expect(result).toEqual({ ok: true, name: leaf, created: true });

    const listed = await tmux(["list-sessions", "-F", "#{session_name}"]);
    expect(listed.stdout.split("\n")).toContain(leaf);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the new session starts in the requested directory", async () => {
  const { base, dir, leaf } = scratch();
  try {
    await create(dir);
    // list-panes, not display-message: the latter needs a client attached and
    // answers with an empty string here.
    const path = await tmux(["list-panes", "-t", `=${leaf}`, "-F", "#{pane_current_path}"]);
    expect(path.stdout.trim()).toBe(dir);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("requesting a name that already exists reuses it instead of creating", async () => {
  const { base, dir, leaf } = scratch();
  try {
    await create(dir);
    const again = await create(dir, leaf, [leaf]);
    expect(again).toEqual({ ok: true, name: leaf, created: false });

    const listed = await tmux(["list-sessions", "-F", "#{session_name}"]);
    const count = listed.stdout.split("\n").filter((n) => n === leaf).length;
    expect(count).toBe(1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a generated name steps aside for an existing one", async () => {
  const { base, dir, leaf } = scratch();
  try {
    const result = await create(dir, undefined, [leaf]);
    expect(result).toEqual({ ok: true, name: `${leaf}-2`, created: true });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a rejected name creates nothing", async () => {
  const { base, dir } = scratch();
  try {
    const result = await create(dir, "web-123");
    expect(result).toEqual({ ok: false, reason: "reserved" });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a nonexistent directory fails instead of creating a stray session", async () => {
  // tmux itself is no help: `new-session -c /nonexistent` exits 0 and creates
  // the session anyway, so the check has to happen here.
  const result = await create("/definitely/not/here/at/all");
  expect(result).toEqual({ ok: false, reason: "baddir" });
});

/**
 * The launch command is otherwise never exercised: the tests above swap it out
 * so they don't start a real Claude Code. This checks the part that actually
 * matters — that a login shell finds `claude` even from a bare environment,
 * which is why the command uses one.
 */
test("the launch command resolves claude through a login shell", async () => {
  const probe = LAUNCH_COMMAND.replace("exec ", "").replace("-lc claude", "-lc 'command -v claude'");
  const shell = Bun.spawn(["sh", "-c", probe], {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: "/usr/bin:/bin", SHELL: process.env.SHELL ?? "/bin/zsh", HOME: process.env.HOME! },
  });
  const out = await new Response(shell.stdout).text();
  await shell.exited;
  expect(out.trim()).toMatch(/claude$/);
});

test("the skip-permissions launch reaches tmux as the pane's command", async () => {
  // Asserting the constant's text only proves the string; this proves the flag
  // survives tmux's own `sh -c` handling and lands on the pane.
  const { base, dir } = scratch();
  const name = `skipflag-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const { LAUNCH_COMMAND_SKIP_PERMISSIONS } = await import("./session-create");
    const result = await createSession(dir, name, [], LAUNCH_COMMAND_SKIP_PERMISSIONS);
    expect(result.ok).toBe(true);
    if (result.ok) made.push(result.name);

    const shown = await tmux([
      "display-message", "-p", "-t", `=${name}:`, "#{pane_start_command}",
    ]);
    expect(shown.stdout).toContain("--dangerously-skip-permissions");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the default launch carries no such flag", async () => {
  const { base, dir } = scratch();
  const name = `noflag-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const result = await createSession(dir, name, [], LAUNCH_COMMAND);
    expect(result.ok).toBe(true);
    if (result.ok) made.push(result.name);

    const shown = await tmux([
      "display-message", "-p", "-t", `=${name}:`, "#{pane_start_command}",
    ]);
    expect(shown.stdout).not.toContain("dangerously");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
