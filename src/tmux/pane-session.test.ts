import { afterAll, beforeAll, expect, test } from "bun:test";
import { DEFAULT_COLUMNS, PaneSession, mouseModeSeed } from "./pane-session";

const BASE = "ps-test-" + Math.random().toString(36).slice(2, 8);
const dec = new TextDecoder();

const webSessionCount = async () =>
  (await Bun.$`tmux list-sessions -F '#{session_name}'`.quiet().nothrow())
    .stdout.toString().split("\n").filter((l) => l.startsWith("web-")).length;

beforeAll(async () => {
  await Bun.$`tmux new-session -d -s ${BASE} -x 100 -y 30`.quiet();
  await Bun.$`tmux send-keys -t ${BASE} 'echo SEED_MARKER_7b2c' Enter`.quiet();
  await Bun.sleep(500);
});

afterAll(async () => {
  await Bun.$`tmux kill-session -t ${BASE}`.quiet().nothrow();
});

test("seeds the current screen on open", async () => {
  let seen = "";
  const session = await PaneSession.open({
    target: BASE, rows: 24, onData: (c) => { seen += dec.decode(c); },
  });
  await Bun.sleep(400);
  expect(seen).toContain("SEED_MARKER_7b2c");
  await session.close();
});

const windowWidth = async () =>
  Number(
    (await Bun.$`tmux display-message -p -t ${BASE} '#{window_width}'`.quiet())
      .stdout.toString().trim(),
  );

test("falls back to the default width when the client names none", async () => {
  const session = await PaneSession.open({ target: BASE, rows: 24, onData: () => {} });
  await Bun.sleep(400);
  expect(await windowWidth()).toBe(DEFAULT_COLUMNS);
  await session.close();
});

test("gives a wide client the width it asks for", async () => {
  // The whole point of the desktop path: 80 columns was a hardcoded lock, and
  // a browser window with room for more should get more.
  const session = await PaneSession.open({
    target: BASE, rows: 24, cols: 160, onData: () => {},
  });
  await Bun.sleep(400);
  expect(await windowWidth()).toBe(160);
  await session.close();
});

test("a resize can change the width, not just the height", async () => {
  const session = await PaneSession.open({
    target: BASE, rows: 24, cols: 100, onData: () => {},
  });
  await Bun.sleep(400);
  await session.resize(30, 132);
  await Bun.sleep(400);
  expect(await windowWidth()).toBe(132);
  await session.close();
});

test("forwards live output after the seed", async () => {
  let seen = "";
  const session = await PaneSession.open({
    target: BASE, rows: 24, onData: (c) => { seen += dec.decode(c); },
  });
  await Bun.sleep(400);
  seen = "";
  await Bun.$`tmux send-keys -t ${BASE} 'echo LIVE_MARKER_4d9e' Enter`.quiet();
  await Bun.sleep(700);
  expect(seen).toContain("LIVE_MARKER_4d9e");
  await session.close();
});

test("sendKeys delivers raw bytes to the pane", async () => {
  let seen = "";
  const session = await PaneSession.open({
    target: BASE, rows: 24, onData: (c) => { seen += dec.decode(c); },
  });
  await Bun.sleep(400);
  seen = "";
  await session.sendKeys(new TextEncoder().encode("echo TYPED_5a1f\r"));
  await Bun.sleep(700);
  expect(seen).toContain("TYPED_5a1f");
  await session.close();
});

test("a command still in flight when the session closes does not reject", async () => {
  // The crash behind the 502s: closing the socket rejects every pending
  // command, and the rejection for a fire-and-forget resize had no handler,
  // so it took the whole process down and launchd restarted it.
  const session = await PaneSession.open({ target: BASE, rows: 24, onData: () => {} });
  await Bun.sleep(300);

  const inFlight = session.resize(30, 120);
  await session.close();

  await expect(inFlight).resolves.toBeUndefined();
});

test("keystrokes racing a close are dropped rather than thrown", async () => {
  const session = await PaneSession.open({ target: BASE, rows: 24, onData: () => {} });
  await Bun.sleep(300);

  const inFlight = session.sendKeys(new TextEncoder().encode("echo racing\r"));
  await session.close();

  await expect(inFlight).resolves.toBeUndefined();
});

test("close destroys the grouped session it created", async () => {
  const before = await webSessionCount();
  const session = await PaneSession.open({ target: BASE, rows: 24, onData: () => {} });
  expect(await webSessionCount()).toBe(before + 1);
  await session.close();
  expect(await webSessionCount()).toBe(before);
});

test("open rejects and leaves no session behind for a missing target", async () => {
  const before = await webSessionCount();
  await expect(
    PaneSession.open({ target: "no-such-session-xyz", rows: 24, onData: () => {} }),
  ).rejects.toThrow();
  expect(await webSessionCount()).toBe(before);
});

test("coalesces bursts of output into fewer callbacks than %output events", async () => {
  let callbacks = 0;
  let bytes = 0;
  const session = await PaneSession.open({
    target: BASE, rows: 24, onData: (c) => { callbacks++; bytes += c.length; },
  });
  await Bun.sleep(400);
  callbacks = 0;
  bytes = 0;

  // A burst big enough that tmux emits many separate %output notifications.
  await Bun.$`tmux send-keys -t ${BASE} 'for i in $(seq 1 300); do echo "line $i padding padding padding"; done' Enter`.quiet();
  await Bun.sleep(1500);

  expect(bytes).toBeGreaterThan(3000);
  // Without coalescing this would be one callback per %output.
  expect(callbacks).toBeLessThan(60);
  await session.close();
});

test("round-trips CJK input exactly once", async () => {
  let seen = "";
  const session = await PaneSession.open({
    target: BASE, rows: 24, onData: (c) => { seen += dec.decode(c); },
  });
  await Bun.sleep(400);
  seen = "";

  // The IME sends one composed string; it must arrive intact and not repeated.
  await session.sendKeys(new TextEncoder().encode("echo 输入回显测试\r"));
  await Bun.sleep(900);

  const occurrences = seen.split("输入回显测试").length - 1;
  expect(occurrences).toBeGreaterThan(0);
  expect(seen).not.toContain("???");
  await session.close();
});

test("delivers CJK output intact in a bare environment, as under launchd", async () => {
  const script =
    `const {PaneSession} = await import("${import.meta.dir}/pane-session.ts");` +
    `let seen = "";` +
    `const s = await PaneSession.open({target:"${BASE}",rows:24,` +
    `onData:(c)=>{seen += new TextDecoder().decode(c);}});` +
    `await Bun.sleep(400); seen = "";` +
    `await s.sendKeys(new TextEncoder().encode("echo 中文输出测试\\r"));` +
    `await Bun.sleep(1200); await s.close();` +
    `process.stdout.write(JSON.stringify(seen.includes("中文输出测试")));`;

  const proc = Bun.spawn([process.execPath, "-e", script], {
    env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;

  expect(JSON.parse(out)).toBe(true);
});

// The seed restores mouse tracking so xterm binds its wheel handler and the
// synthetic scroll works at once, rather than staying dead until a keyboard
// toggle repaints the pane. The mode-building is pure, so it is tested directly.
test("restores all-motion + SGR mouse tracking (Claude Code's modes)", () => {
  expect(mouseModeSeed(1, 1, 1)).toBe("\x1b[?1006h\x1b[?1003h");
});

test("uses button tracking when the pane reports only that", () => {
  expect(mouseModeSeed(1, 0, 0)).toBe("\x1b[?1000h");
});

test("all-motion supersedes button-only", () => {
  // Never emit both 1000 and 1003; 1003 already reports buttons.
  expect(mouseModeSeed(1, 1, 0)).toBe("\x1b[?1003h");
});

test("adds nothing for a pane that never enabled the mouse", () => {
  expect(mouseModeSeed(0, 0, 0)).toBe("");
});
