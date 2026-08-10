import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmux } from "./tmux/run";

/**
 * The Claude hooks, driven against a real tmux server.
 *
 * These scripts are the only part of the project that runs outside it — Claude
 * spawns them — so nothing else can catch a regression in them. They are also
 * where the grouped-session bug lived: both begin by asking tmux which session
 * the current pane belongs to, and a pane shared with a `web-*` mount point
 * answers with the mount point rather than the user's session.
 *
 * HOME is redirected per test, which is enough to keep the real
 * ~/.tmux-next/sessions untouched: the scripts derive their paths from it.
 */

const SCRIPT_SESSION = new URL("../hooks/tmux-next-session.sh", import.meta.url).pathname;
const SCRIPT_NOTIFY = new URL("../hooks/tmux-next-notify.sh", import.meta.url).pathname;

const made: string[] = [];

/** The server this suite talks to, as the scripts' tmux clients must find it. */
const socketPath = Bun.spawnSync(["tmux", "display-message", "-p", "#{socket_path}"])
  .stdout.toString().trim();

/** Only ever targets a name this file created. Never kill-server. */
afterEach(async () => {
  for (const name of made.splice(0)) {
    await tmux(["kill-session", "-t", `=${name}`]);
  }
});

async function makeSession(prefix: string): Promise<{ name: string; pane: string }> {
  const name = `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
  const created = await tmux(["new-session", "-d", "-s", name, "-x", "80", "-y", "24", "sleep 60"]);
  expect(created.ok).toBe(true);
  made.push(name);
  const listed = await tmux(["list-panes", "-t", `${name}:`, "-F", "#{pane_id}"]);
  return { name, pane: listed.stdout.trim() };
}

/** Attaches a `web-*` grouped session to `target`, as PaneSession.open would. */
async function attachWebSession(target: string): Promise<string> {
  const name = `web-99999-${Math.random().toString(36).slice(2, 8)}`;
  const created = await tmux(["new-session", "-d", "-t", `=${target}`, "-s", name]);
  expect(created.ok).toBe(true);
  made.push(name);
  return name;
}

function runHook(script: string, home: string, pane: string, payload: unknown, env = {}) {
  return Bun.spawnSync(["bash", script], {
    stdin: Buffer.from(JSON.stringify(payload)),
    env: {
      ...process.env,
      HOME: home,
      // Must be the real socket, not a placeholder: the scripts only check
      // that TMUX is non-empty, but every tmux client they invoke *parses* it
      // and connects to the socket named there. A fake path makes each of
      // those calls fail silently, which looks exactly like the bug under test.
      TMUX: `${socketPath},0,0`,
      TMUX_PANE: pane,
      ...env,
    },
  });
}

/** The single record the SessionStart hook should have written, if any. */
function readRecord(home: string): { session?: string; id?: string; cwd?: string } | null {
  const dir = join(home, ".tmux-next", "sessions");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return null;
  return JSON.parse(readFileSync(join(dir, files[0]!), "utf8"));
}

test("SessionStart records the binding for an ordinary session", async () => {
  const { name, pane } = await makeSession("hooktest");
  const home = mkdtempSync(join(tmpdir(), "hookhome-"));

  runHook(SCRIPT_SESSION, home, pane, {
    session_id: "11111111-2222-3333-4444-555555555555",
    cwd: "/tmp",
    hook_event_name: "SessionStart",
  });

  expect(readRecord(home)?.session).toBe(name);
});

/**
 * The regression that cost three sessions.
 *
 * With a browser watching, tmux resolves the pane's session to the `web-*`
 * mount point — grouped onto the same window and created later, and tmux hands
 * back the most recent match. The hook then sees a name starting with `web-`,
 * concludes it was triggered by tmux-next's own attach point, and exits without
 * recording anything. The session it was actually called for is left with no
 * binding, so it cannot be restored after a tmux restart.
 */
test("SessionStart records the user's session even while a web client watches it", async () => {
  const { name, pane } = await makeSession("hooktest");
  await attachWebSession(name);
  const home = mkdtempSync(join(tmpdir(), "hookhome-"));

  runHook(SCRIPT_SESSION, home, pane, {
    session_id: "66666666-7777-8888-9999-000000000000",
    cwd: "/tmp",
    hook_event_name: "SessionStart",
  });

  expect(readRecord(home)?.session).toBe(name);
});

test("SessionStart still ignores a pane that only lives in a web session", async () => {
  // A pane belonging to nothing but a web-* session has no user session to
  // attribute, and must stay unrecorded rather than be filed under the mount
  // point. Created standalone, without a target, so web-* is its only owner.
  const name = `web-99999-${Math.random().toString(36).slice(2, 8)}`;
  await tmux(["new-session", "-d", "-s", name, "-x", "80", "-y", "24", "sleep 60"]);
  made.push(name);
  const listed = await tmux(["list-panes", "-t", `${name}:`, "-F", "#{pane_id}"]);
  const home = mkdtempSync(join(tmpdir(), "hookhome-"));

  runHook(SCRIPT_SESSION, home, listed.stdout.trim(), {
    session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    cwd: "/tmp",
    hook_event_name: "SessionStart",
  });

  expect(readRecord(home)).toBeNull();
});

test("Stop notifies for the user's session even while a web client watches it", async () => {
  const { name, pane } = await makeSession("hooktest");
  await attachWebSession(name);
  const home = mkdtempSync(join(tmpdir(), "hookhome-"));

  const seen: { event?: string; session?: string }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (new URL(req.url).pathname === "/api/notify") seen.push(await req.json());
      return new Response(null, { status: 202 });
    },
  });

  try {
    runHook(SCRIPT_NOTIFY, home, pane, { hook_event_name: "Stop" }, {
      TMUX_NEXT_PORT: String(server.port),
    });
    // The script backgrounds curl so Claude is never delayed by it.
    await Bun.sleep(700);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ event: "waiting", session: name });
  } finally {
    server.stop(true);
  }
});

/**
 * A subagent finishing is not a turn finishing.
 *
 * Claude converts a `Stop` registration into `SubagentStop` when the hook fires
 * inside a Task-tool subagent, so the script is handed events it never asked
 * for. It dispatches on `hook_event_name` and falls through to a silent exit,
 * which is the only reason a run with ten subagents does not buzz the phone ten
 * times. Nothing else in the suite would notice that changing.
 */
test("a subagent finishing does not notify", async () => {
  const { name, pane } = await makeSession("hooksub");
  const home = mkdtempSync(join(tmpdir(), "hookhome-"));

  const seen: { event?: string; session?: string }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (new URL(req.url).pathname === "/api/notify") seen.push(await req.json());
      return new Response(null, { status: 202 });
    },
  });

  try {
    const port = { TMUX_NEXT_PORT: String(server.port) };
    runHook(SCRIPT_NOTIFY, home, pane, { hook_event_name: "SubagentStop" }, port);
    runHook(SCRIPT_NOTIFY, home, pane, { hook_event_name: "SubagentStart" }, port);
    await Bun.sleep(700);
    expect(seen).toEqual([]);

    // The real Stop that follows still gets through, so this is a filter and
    // not simply a broken script.
    runHook(SCRIPT_NOTIFY, home, pane, { hook_event_name: "Stop" }, port);
    await Bun.sleep(700);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ event: "waiting", session: name });
  } finally {
    server.stop(true);
  }
});
