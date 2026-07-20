import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server";

/**
 * Only the refusal paths are exercised here.
 *
 * A successful POST runs the real launch command, which would start an actual
 * Claude Code process. The create path itself is covered in
 * tmux/session-create.integration.test.ts, which injects an inert command.
 */
let server: { stop(): void; port: number };
const api = (path: string) => `http://127.0.0.1:${server.port}${path}`;

beforeAll(() => {
  server = startServer(0);
});

afterAll(() => {
  server.stop();
});

const post = (body: unknown) =>
  fetch(api("/api/sessions"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("a session can be created in any real directory", async () => {
  // There is no allow-list: someone who can POST here can already attach to a
  // session and cd anywhere, so refusing /etc only pretended to be a boundary.
  const res = await post({ dir: "/tmp", name: `anydir-${crypto.randomUUID().slice(0, 8)}` });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { name: string };
  await Bun.$`tmux kill-session -t ${"=" + body.name + ":"}`.quiet().nothrow();
});

test("a directory that does not exist is refused", async () => {
  const res = await post({ dir: join(homedir(), "definitely-not-here-4b2f") });
  expect(res.status).toBe(400);
});

test("a missing dir field is refused", async () => {
  expect((await post({})).status).toBe(400);
});

test("a malformed body is refused", async () => {
  const res = await fetch(api("/api/sessions"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
  expect(res.status).toBe(400);
});

test("a reserved name is refused before anything is created", async () => {
  const res = await post({ dir: homedir(), name: "web-123" });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "reserved" });
});

test("a name tmux could never target again is refused", async () => {
  const res = await post({ dir: homedir(), name: "has.dot" });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid" });
});

test("a blank name is refused rather than silently generated", async () => {
  const res = await post({ dir: homedir(), name: "   " });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "empty" });
});

test("browsing lists directories under an allowed root", async () => {
  const res = await fetch(api(`/api/dirs?path=${encodeURIComponent(homedir())}`));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; entries: { name: string }[] };
  expect(body.ok).toBe(true);
  expect(Array.isArray(body.entries)).toBe(true);
});

test("browsing reaches directories outside home", async () => {
  const res = await fetch(api(`/api/dirs?path=${encodeURIComponent("/etc")}`));
  expect(res.status).toBe(200);
});

test("browsing follows .. instead of refusing it", async () => {
  const climbed = join(homedir(), "..", "..", "etc");
  const res = await fetch(api(`/api/dirs?path=${encodeURIComponent(climbed)}`));
  expect(res.status).toBe(200);
  // realpath resolves the symlink macOS puts at /etc, which is the point of
  // resolving at all: the session starts where the path actually lands.
  const body = (await res.json()) as { path: string };
  expect(body.path).toBe(realpathSync("/etc"));
});

test("only the filesystem root reports no parent", async () => {
  const home = await (await fetch(api(`/api/dirs?path=${encodeURIComponent(homedir())}`))).json();
  expect((home as { parent: string | null }).parent).not.toBe(null);

  const root = await (await fetch(api(`/api/dirs?path=${encodeURIComponent("/")}`))).json();
  expect((root as { parent: string | null }).parent).toBe(null);
});

test("browsing a path that does not exist is a 404, not a refusal", async () => {
  const res = await fetch(api(`/api/dirs?path=${encodeURIComponent("/no/such/dir/xyz")}`));
  expect(res.status).toBe(404);
});

test("browsing hides dot directories", async () => {
  const base = realpathSync(mkdtempSync(join(homedir(), "api-dirs-")));
  try {
    mkdirSync(join(base, "visible"));
    mkdirSync(join(base, ".hidden"));
    const res = await fetch(api(`/api/dirs?path=${encodeURIComponent(base)}`));
    const body = (await res.json()) as { entries: { name: string }[] };
    expect(body.entries.map((e) => e.name)).toEqual(["visible"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the recent directories endpoint returns home and a ranked list", async () => {
  const res = await fetch(api("/api/directories"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { home: string; recent: string[] };
  expect(body.home).toBe(homedir());
  expect(Array.isArray(body.recent)).toBe(true);
});

test("a file is still refused — only directories can host a session", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "notadir-")));
  try {
    const file = join(base, "note.txt");
    await Bun.write(file, "hi");
    expect((await post({ dir: file })).status).toBe(400);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
