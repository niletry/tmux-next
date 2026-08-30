import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer } from "./server";

/**
 * Exercises the reconnect contract the phone depends on: after the socket
 * drops, a fresh connection must rebuild the whole screen from tmux rather
 * than replaying a buffer.
 */

const BASE = "rc-test-" + Math.random().toString(36).slice(2, 8);
let server: { stop(): void; port: number };
const dec = new TextDecoder();

type Session = { ws: WebSocket; text(): string; reset(): void };

async function open(target: string): Promise<Session> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  ws.binaryType = "arraybuffer";
  await new Promise<void>((resolve) => {
    ws.onopen = () => resolve();
  });

  let received = "";
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) received += dec.decode(new Uint8Array(e.data));
  };
  ws.send(JSON.stringify({ t: "open", target, rows: 24 }));
  await Bun.sleep(900);

  return {
    ws,
    text: () => received,
    reset: () => {
      received = "";
    },
  };
}

beforeAll(async () => {
  await Bun.$`tmux new-session -d -s ${BASE} -x 100 -y 30`.quiet();
  server = startServer(0);
});

afterAll(async () => {
  server.stop();
  await Bun.$`tmux kill-session -t ${BASE}`.quiet().nothrow();
});

test("a reconnect redraws content produced while disconnected", async () => {
  const first = await open(BASE);
  first.ws.close();
  await Bun.sleep(500);

  // Work continues in tmux while nobody is watching.
  await Bun.$`tmux send-keys -t ${BASE} 'echo WHILE_AWAY_8e2d' Enter`.quiet();
  await Bun.sleep(600);

  const second = await open(BASE);
  expect(second.text()).toContain("WHILE_AWAY_8e2d");
  second.ws.close();
  await Bun.sleep(400);
});

test("the seed starts with a clear so no stale rows survive a redraw", async () => {
  const session = await open(BASE);
  // \x1b[2J clears, \x1b[H homes the cursor: together they guarantee the
  // reconnected screen is not drawn on top of whatever was there before.
  expect(session.text().startsWith("\x1b[2J\x1b[H")).toBe(true);
  session.ws.close();
  await Bun.sleep(400);
});

test("the seed ends by positioning the cursor", async () => {
  const session = await open(BASE);
  expect(session.text()).toMatch(/\x1b\[\d+;\d+H/);
  session.ws.close();
  await Bun.sleep(400);
});

test("repeated reconnects leave no orphan web sessions", async () => {
  for (let i = 0; i < 3; i++) {
    const session = await open(BASE);
    session.ws.close();
    await Bun.sleep(500);
  }
  // Scoped to this process's own sessions: the tmux server is shared, and a real
  // tmux-next serving someone's phone has web sessions of its own that are not
  // this test's leak to find. The pid in the name is what tells them apart — the
  // same discriminator the orphan reaper uses, and the one the kill test below
  // already relies on.
  const listed = (await Bun.$`tmux list-sessions -F '#{session_name}'`.quiet().nothrow())
    .stdout.toString().split("\n").filter((l) => l.startsWith(`web-${process.pid}-`));
  expect(listed).toEqual([]);
});

test("the window returns to its own size after the client disconnects", async () => {
  const width = async () =>
    Number(
      (await Bun.$`tmux display-message -p -t ${BASE} '#{window_width}'`.quiet())
        .stdout.toString().trim(),
    );

  const session = await open(BASE);
  expect(await width()).toBe(80);

  session.ws.close();
  await Bun.sleep(600);

  // With `window-size latest` and no client left, tmux falls back to the
  // session's own size rather than staying pinned at the phone's 80 columns.
  expect(await width()).toBe(100);
});

/**
 * A dead control client must reach the browser as a closed socket.
 *
 * The tmux subprocess can die on its own — the tmux server is replaced, or the
 * session it is attached to is destroyed from another terminal. When that
 * happened the read loop simply ended: nothing told PaneSession, nothing closed
 * the WebSocket, and the page sat showing "connected" with a live socket that
 * would never carry another byte. The only way out was a manual reload.
 *
 * Closing the socket is the whole fix, because the client already knows how to
 * handle that: onclose drives a backoff reconnect, and a reconnect reseeds from
 * capture-pane. This test guards the one link that was missing.
 */
test("a session destroyed underneath us closes the socket", async () => {
  const watcher = await open(BASE);
  expect(watcher.ws.readyState).toBe(WebSocket.OPEN);

  const closed = new Promise<number>((resolve) => {
    watcher.ws.onclose = (e) => resolve(e.code);
  });

  // What the control client is actually attached to is the grouped web session
  // it made for this socket — not the target. Destroying that is precisely the
  // event the fix is about: every one of them went away at once when the tmux
  // server was replaced.
  const listed = await Bun.$`tmux list-sessions -F '#{session_name}'`.quiet().nothrow();
  const mine = listed.stdout
    .toString()
    .split("\n")
    .find((n) => n.startsWith(`web-${process.pid}-`));
  expect(mine).toBeTruthy();
  await Bun.$`tmux kill-session -t =${mine}`.quiet().nothrow();

  const outcome = await Promise.race([
    closed,
    Bun.sleep(5000).then(() => "still open" as const),
  ]);
  expect(outcome).not.toBe("still open");
});
