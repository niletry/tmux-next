import { afterAll, beforeAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
// Redirect key-usage storage to a throwaway file so the suite never touches a
// real ~/.tmux-next/key-usage.json. Read lazily by the module, so setting it
// here — before any request — is enough.
process.env.TMUX_NEXT_KEY_USAGE_PATH = joinPath(
  tmpdir(),
  `ku-test-${Math.random().toString(36).slice(2, 10)}.json`,
);
process.env.TMUX_NEXT_GALLERY_DIR = joinPath(
  tmpdir(),
  `gallery-test-${Math.random().toString(36).slice(2, 10)}`,
);
process.env.TMUX_NEXT_PINS_PATH = joinPath(
  tmpdir(),
  `pins-test-${Math.random().toString(36).slice(2, 10)}.json`,
);
process.env.TMUX_NEXT_SESSIONS_DIR = joinPath(
  tmpdir(),
  `sessions-test-${Math.random().toString(36).slice(2, 10)}`,
);
process.env.CLAUDE_PROJECTS_DIR = joinPath(
  tmpdir(),
  `projects-test-${Math.random().toString(36).slice(2, 10)}`,
);
process.env.TMUX_NEXT_PUSH_DIR = joinPath(
  tmpdir(),
  `push-test-${Math.random().toString(36).slice(2, 10)}`,
);
process.env.TMUX_NEXT_VAPID_PATH = joinPath(
  tmpdir(),
  `vapid-test-${Math.random().toString(36).slice(2, 10)}.json`,
);
process.env.TMUX_NEXT_NOTIFICATIONS_PATH = joinPath(
  tmpdir(),
  `notif-test-${Math.random().toString(36).slice(2, 10)}.jsonl`,
);
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { startServer, isLoopback } from "./server";
import { encodeProjectDir } from "./claude-history";

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

const rnBody = (name: string) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name }),
});

test("renames a session; the old name is gone and the new one exists", async () => {
  const from = "rn-" + Math.random().toString(36).slice(2, 8);
  const to = from + "-renamed";
  await Bun.$`tmux new-session -d -s ${from} -x 80 -y 24`.quiet();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${from}/rename`, rnBody(to));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe(to);
    expect((await Bun.$`tmux has-session -t ${"=" + to}`.quiet().nothrow()).exitCode).toBe(0);
    expect((await Bun.$`tmux has-session -t ${"=" + from}`.quiet().nothrow()).exitCode).not.toBe(0);
  } finally {
    await Bun.$`tmux kill-session -t ${"=" + to}`.quiet().nothrow();
    await Bun.$`tmux kill-session -t ${"=" + from}`.quiet().nothrow();
  }
});

test("refuses to rename to a reserved web- name", async () => {
  const from = "rn-" + Math.random().toString(36).slice(2, 8);
  await Bun.$`tmux new-session -d -s ${from} -x 80 -y 24`.quiet();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${from}/rename`, rnBody("web-evil"));
    expect(res.status).toBe(400);
  } finally {
    await Bun.$`tmux kill-session -t ${"=" + from}`.quiet().nothrow();
  }
});

test("refuses to rename onto an existing session name", async () => {
  const from = "rn-" + Math.random().toString(36).slice(2, 8);
  await Bun.$`tmux new-session -d -s ${from} -x 80 -y 24`.quiet();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${from}/rename`, rnBody(BASE));
    expect(res.status).toBe(409);
  } finally {
    await Bun.$`tmux kill-session -t ${"=" + from}`.quiet().nothrow();
  }
});

test("renaming a session that does not exist is a 404", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions/no-such-xyz/rename`, rnBody("whatever"));
  expect(res.status).toBe(404);
});

test("ending a renamed session still reaps its grouped web sessions", async () => {
  // The regression guard: a group's id is frozen at creation, so after a rename
  // the grouped web session's group no longer equals the current name. Ending
  // the session must still take it down, or its processes would be orphaned.
  const from = "rn-" + Math.random().toString(36).slice(2, 8);
  const to = from + "-renamed";
  const web = `web-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await Bun.$`tmux new-session -d -s ${from} -x 80 -y 24`.quiet();
  await Bun.$`tmux new-session -d -s ${web} -t ${"=" + from}`.quiet();
  try {
    expect((await fetch(`http://127.0.0.1:${server.port}/api/sessions/${from}/rename`, rnBody(to))).status).toBe(200);
    // still attached, now grouped under the frozen id rather than the new name
    expect((await Bun.$`tmux has-session -t ${"=" + web}`.quiet().nothrow()).exitCode).toBe(0);

    const del = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${to}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect((await Bun.$`tmux has-session -t ${"=" + web}`.quiet().nothrow()).exitCode).not.toBe(0);
    expect((await Bun.$`tmux has-session -t ${"=" + to}`.quiet().nothrow()).exitCode).not.toBe(0);
  } finally {
    await Bun.$`tmux kill-session -t ${"=" + web}`.quiet().nothrow();
    await Bun.$`tmux kill-session -t ${"=" + to}`.quiet().nothrow();
    await Bun.$`tmux kill-session -t ${"=" + from}`.quiet().nothrow();
  }
});

test("records toolbar key usage and reads it back, highest first", async () => {
  const base = `http://127.0.0.1:${server.port}/api/key-usage`;
  const post = (counts: Record<string, number>) =>
    fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ counts }),
    });
  await post({ enter: 3, esc: 1 });
  await post({ enter: 2 });

  const totals = (await (await fetch(base)).json()) as { key: string; count: number }[];
  const map = Object.fromEntries(totals.map((t) => [t.key, t.count]));
  expect(map.enter).toBe(5);
  expect(map.esc).toBe(1);
  expect(totals[0]!.key).toBe("enter"); // sorted highest first
});

test("a malformed usage beacon is swallowed, not an error", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/key-usage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json at all",
  });
  expect(res.status).toBe(204);
});

test("gallery lists its files newest first with a kind", async () => {
  const dir = process.env.TMUX_NEXT_GALLERY_DIR!;
  await Bun.$`mkdir -p ${dir}`.quiet();
  await Bun.write(joinPath(dir, "old.png"), "PNGDATA");
  await Bun.sleep(20);
  await Bun.write(joinPath(dir, "new.html"), "<h1>hi</h1>");

  const items = (await (
    await fetch(`http://127.0.0.1:${server.port}/api/gallery`)
  ).json()) as { name: string; kind: string }[];

  const byName = Object.fromEntries(items.map((i) => [i.name, i.kind]));
  expect(byName["old.png"]).toBe("image");
  expect(byName["new.html"]).toBe("html");
  // Newest (new.html) sorts before old.png.
  const names = items.map((i) => i.name);
  expect(names.indexOf("new.html")).toBeLessThan(names.indexOf("old.png"));
});

test("gallery serves a file's bytes with a type from its extension", async () => {
  const dir = process.env.TMUX_NEXT_GALLERY_DIR!;
  await Bun.$`mkdir -p ${dir}`.quiet();
  await Bun.write(joinPath(dir, "page.html"), "<h1>artifact</h1>");

  const res = await fetch(`http://127.0.0.1:${server.port}/api/gallery/file?name=page.html`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(await res.text()).toContain("artifact");
});

test("gallery refuses a name that tries to climb out", async () => {
  for (const name of ["../../etc/passwd", "sub/x.png", "..%2Fx"]) {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/gallery/file?name=${encodeURIComponent(name)}`,
    );
    expect(res.status).toBe(400);
  }
});

test("gallery is a 404 for a name that does not exist", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/gallery/file?name=nope.png`);
  expect(res.status).toBe(404);
});

test("pinning a session marks it and sorts it to the top", async () => {
  const base = `http://127.0.0.1:${server.port}`;
  const pin = (p: boolean) =>
    fetch(`${base}/api/sessions/${BASE}/pin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: p }),
    });

  expect((await pin(true)).status).toBe(204);
  let list = (await (await fetch(`${base}/api/sessions`)).json()) as {
    name: string;
    pinned: boolean;
  }[];
  expect(list[0]!.name).toBe(BASE);
  expect(list[0]!.pinned).toBe(true);

  expect((await pin(false)).status).toBe(204);
  list = (await (await fetch(`${base}/api/sessions`)).json()) as {
    name: string;
    pinned: boolean;
  }[];
  expect(list.find((s) => s.name === BASE)!.pinned).toBe(false);
});

test("lists a dead session's record as restorable, but not a live one", async () => {
  const dir = process.env.TMUX_NEXT_SESSIONS_DIR!;
  await Bun.$`mkdir -p ${dir}`.quiet();
  await Bun.write(
    joinPath(dir, "aaa.json"),
    JSON.stringify({ id: "dead-uuid-1", session: "no-such-restorable-xyz", cwd: "/tmp" }),
  );
  await Bun.write(joinPath(dir, "bbb.json"), JSON.stringify({ id: "live-uuid-2", session: BASE }));

  const list = (await (
    await fetch(`http://127.0.0.1:${server.port}/api/restorable`)
  ).json()) as { session: string; id: string }[];
  const names = list.map((r) => r.session);
  expect(names).toContain("no-such-restorable-xyz");
  expect(names).not.toContain(BASE); // BASE is a live session
});

// --- history + resume -------------------------------------------------------

const jsonl = (aiTitle: string, cwd: string) =>
  [
    JSON.stringify({ type: "ai-title", aiTitle }),
    JSON.stringify({ type: "user", cwd, message: { role: "user", content: "hi" } }),
  ].join("\n");

test("history lists a directory's past conversations, newest first", async () => {
  const work = realpathSync(mkdtempSync(joinPath(tmpdir(), "hwork-")));
  const folder = joinPath(process.env.CLAUDE_PROJECTS_DIR!, encodeProjectDir(work));
  mkdirSync(folder, { recursive: true });
  const old = joinPath(folder, "aaaa1111-old.jsonl");
  const fresh = joinPath(folder, "bbbb2222-new.jsonl");
  writeFileSync(old, jsonl("旧对话", work));
  writeFileSync(fresh, jsonl("新对话", work));
  // Make "fresh" the more recently modified one, deterministically.
  const { utimesSync } = await import("node:fs");
  utimesSync(old, 1000, 1000);
  utimesSync(fresh, 2000, 2000);

  const res = await fetch(
    `http://127.0.0.1:${server.port}/api/history?dir=${encodeURIComponent(work)}`,
  );
  expect(res.status).toBe(200);
  const { conversations } = (await res.json()) as {
    conversations: { id: string; title: string; mtime: number }[];
  };
  expect(conversations.map((c) => c.title)).toEqual(["新对话", "旧对话"]);
  expect(conversations[0]!.id).toBe("bbbb2222-new");
});

test("history is 400 for a directory that does not exist", async () => {
  const res = await fetch(
    `http://127.0.0.1:${server.port}/api/history?dir=${encodeURIComponent("/no/such/dir/xyz")}`,
  );
  expect(res.status).toBe(400);
});

test("creating with a bad resume id is rejected, not started", async () => {
  const work = realpathSync(mkdtempSync(joinPath(tmpdir(), "rbad-")));
  const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir: work, name: "resume-bad-xyz", resume: "a.b; rm -rf /" }),
  });
  expect(res.status).toBe(400);
  const alive = await Bun.$`tmux has-session -t =resume-bad-xyz`.quiet().nothrow();
  expect(alive.exitCode).not.toBe(0); // nothing was created
});

test("creating with a resume id launches claude --resume in the new session", async () => {
  const work = realpathSync(mkdtempSync(joinPath(tmpdir(), "rgood-")));
  const name = `resume-ok-${Math.random().toString(36).slice(2, 8)}`;
  const id = "00000000-0000-4000-8000-000000000000";
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: work, name, resume: id }),
    });
    expect(res.status).toBe(200);
    const shown = await Bun.$`tmux display-message -p -t ${"=" + name + ":"} ${"#{pane_start_command}"}`
      .quiet()
      .nothrow();
    const cmd = shown.stdout.toString();
    expect(cmd).toContain("--resume");
    expect(cmd).toContain(id);
  } finally {
    await Bun.$`tmux kill-session -t ${"=" + name}`.quiet().nothrow();
  }
});

// --- push notifications -----------------------------------------------------

test("isLoopback accepts only local addresses", () => {
  for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(isLoopback(a)).toBe(true);
  for (const a of ["192.168.1.5", "10.0.0.1", "::ffff:8.8.8.8", undefined]) {
    expect(isLoopback(a)).toBe(false);
  }
});

test("push key endpoint returns a VAPID public key", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/push/key`);
  expect(res.status).toBe(200);
  const { key } = (await res.json()) as { key: string };
  expect(typeof key).toBe("string");
  expect(key.length).toBeGreaterThan(80); // base64url of a 65-byte point
});

test("subscribe rejects a malformed subscription and accepts a valid one", async () => {
  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${server.port}/api/push/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  expect((await post({ endpoint: "http://x", keys: {} })).status).toBe(400);
  const ok = await post({
    endpoint: "https://push.example.com/abc",
    keys: { p256dh: "BPk", auth: "xyz" },
  });
  expect(ok.status).toBe(204);
});

test("notify rejects a bad event and accepts a valid one over loopback", async () => {
  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${server.port}/api/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  expect((await post({ event: "bogus", session: "s" })).status).toBe(400);
  expect((await post({ event: "ended", session: "" })).status).toBe(400);
  // A valid event over loopback is accepted (no subscriptions → nothing sent).
  const ok = await post({ event: "ended", session: "notify-test-sess" });
  expect(ok.status).toBe(202);
});

test("a sent notification is logged and readable from /api/notifications", async () => {
  await fetch(`http://127.0.0.1:${server.port}/api/notify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: "ended", session: "hist-test-sess" }),
  });
  const res = await fetch(`http://127.0.0.1:${server.port}/api/notifications`);
  expect(res.status).toBe(200);
  const { notifications } = (await res.json()) as {
    notifications: { session: string; body: string }[];
  };
  const found = notifications.find((n) => n.session === "hist-test-sess");
  expect(found).toBeDefined();
  expect(found!.body).toBe("会话已结束");
});
