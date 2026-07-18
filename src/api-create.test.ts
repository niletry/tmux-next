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

test("a directory outside the allowed roots is refused", async () => {
  // /etc exists and is a directory, so only the root check can reject it.
  const res = await post({ dir: "/etc" });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "baddir" });
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

test("browsing outside the allowed roots is refused", async () => {
  const res = await fetch(api(`/api/dirs?path=${encodeURIComponent("/etc")}`));
  expect(res.status).toBe(403);
});

test("browsing cannot climb out with ..", async () => {
  const escape = join(homedir(), "..", "..", "etc");
  const res = await fetch(api(`/api/dirs?path=${encodeURIComponent(escape)}`));
  expect(res.status).toBe(403);
});

test("browsing a root reports no parent", async () => {
  const res = await fetch(api(`/api/dirs?path=${encodeURIComponent(homedir())}`));
  const body = (await res.json()) as { parent: string | null };
  expect(body.parent).toBe(null);
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

test("the temp directory is outside the roots, so tests cannot create there", async () => {
  // Guards the guard: if tmpdir() ever fell inside a root, the refusal tests
  // above would pass for the wrong reason.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "outside-")));
  try {
    expect((await post({ dir: base })).status).toBe(400);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
