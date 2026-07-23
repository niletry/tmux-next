import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer } from "./server";

const BASE = "srv-test-" + Math.random().toString(36).slice(2, 8);
let server: { stop(): void; port: number };

const webSessions = async () =>
  (await Bun.$`tmux list-sessions -F '#{session_name}'`.quiet().nothrow())
    .stdout.toString().split("\n").filter((l) => l.startsWith("web-"));

const openSocket = async (): Promise<WebSocket> => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  ws.binaryType = "arraybuffer";
  await new Promise<void>((resolve) => {
    ws.onopen = () => resolve();
  });
  return ws;
};

beforeAll(async () => {
  await Bun.$`tmux new-session -d -s ${BASE} -x 100 -y 30`.quiet();
  server = startServer(0);
});

afterAll(async () => {
  server.stop();
  await Bun.$`tmux kill-session -t ${BASE}`.quiet().nothrow();
});

test("serves the session list as JSON", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { name: string }[];
  expect(body.some((s) => s.name === BASE)).toBe(true);
});

test("serves the list page HTML at the root", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
});

test("returns 404 for an unknown path", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/nope.txt`);
  expect(res.status).toBe(404);
});

test("streams terminal data over the websocket after open", async () => {
  const ws = await openSocket();
  let received = "";
  const dec = new TextDecoder();
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) received += dec.decode(new Uint8Array(e.data));
  };

  ws.send(JSON.stringify({ t: "open", target: BASE, rows: 24 }));
  await Bun.sleep(1200);

  expect(received.length).toBeGreaterThan(0);
  ws.close();
  await Bun.sleep(400);
});

test("reports an error for a session that does not exist", async () => {
  const ws = await openSocket();
  const message = await new Promise<string>((resolve) => {
    ws.onmessage = (e) => {
      if (typeof e.data === "string") resolve(e.data);
    };
    ws.send(JSON.stringify({ t: "open", target: "no-such-session-xyz", rows: 24 }));
  });
  expect(JSON.parse(message).t).toBe("error");
  ws.close();
  await Bun.sleep(200);
});

test("closing the websocket leaves no orphan web session", async () => {
  const ws = await openSocket();
  ws.send(JSON.stringify({ t: "open", target: BASE, rows: 24 }));
  await Bun.sleep(900);
  expect((await webSessions()).length).toBe(1);

  ws.close();
  await Bun.sleep(900);
  expect(await webSessions()).toEqual([]);
});

test("keys sent over the websocket reach the pane", async () => {
  const ws = await openSocket();
  let received = "";
  const dec = new TextDecoder();
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) received += dec.decode(new Uint8Array(e.data));
  };
  ws.send(JSON.stringify({ t: "open", target: BASE, rows: 24 }));
  await Bun.sleep(900);
  received = "";

  const bytes = new TextEncoder().encode("echo WS_TYPED_3c8b\r");
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
  ws.send(JSON.stringify({ t: "keys", hex }));
  await Bun.sleep(900);

  expect(received).toContain("WS_TYPED_3c8b");
  ws.close();
  await Bun.sleep(400);
});

test("DELETE removes a session", async () => {
  const victim = "srv-kill-" + Math.random().toString(36).slice(2, 8);
  await Bun.$`tmux new-session -d -s ${victim} -x 80 -y 24`.quiet();

  const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${victim}`, {
    method: "DELETE",
  });
  expect(res.status).toBe(204);

  const still = await Bun.$`tmux has-session -t ${victim}`.quiet().nothrow();
  expect(still.exitCode).not.toBe(0);
});

test("DELETE reports 404 for a session that does not exist", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions/no-such-session-xyz`, {
    method: "DELETE",
  });
  expect(res.status).toBe(404);
});

test("DELETE refuses an internal web session with 403", async () => {
  const { createWebSession, destroyWebSession } = await import("./tmux/session-manager");
  const web = await createWebSession(BASE);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${web}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  } finally {
    await destroyWebSession(web);
  }
});

test("a GET on the delete path does not kill anything", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${BASE}`);
  expect(res.status).toBe(404);
  const still = await Bun.$`tmux has-session -t ${BASE}`.quiet().nothrow();
  expect(still.exitCode).toBe(0);
});

test("DELETE handles a session name that needs url encoding", async () => {
  const victim = "srv kill spaced " + Math.random().toString(36).slice(2, 6);
  await Bun.$`tmux new-session -d -s ${victim} -x 80 -y 24`.quiet();

  const res = await fetch(
    `http://127.0.0.1:${server.port}/api/sessions/${encodeURIComponent(victim)}`,
    { method: "DELETE" },
  );
  expect(res.status).toBe(204);

  const still = await Bun.$`tmux has-session -t ${victim}`.quiet().nothrow();
  expect(still.exitCode).not.toBe(0);
});

test("accepts an image upload and answers with a saved path", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/upload`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  });
  expect(res.status).toBe(200);
  const { path } = (await res.json()) as { path: string };
  expect(path).toMatch(/img-[0-9a-f-]+\.png$/);
  expect(await Bun.file(path).exists()).toBe(true);
  await Bun.$`rm -f ${path}`.quiet().nothrow();
});

test("refuses to write anything that is not an allow-listed image", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/upload`, {
    method: "POST",
    headers: { "content-type": "text/html" },
    body: "<script>alert(1)</script>",
  });
  expect(res.status).toBe(415);
});
