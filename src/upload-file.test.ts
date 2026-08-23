import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { tmux } from "./tmux/run";
import { sessionCwd, saveSessionUpload, MAX_SESSION_UPLOAD_BYTES } from "./upload-file";

/** A fresh session parked in a throwaway directory. */
async function sessionIn(dir: string): Promise<string> {
  const name = `upfile-${crypto.randomUUID().slice(0, 8)}`;
  await tmux(["new-session", "-d", "-s", name, "-c", dir, "-x", "80", "-y", "24", "sleep 30"]);
  return name;
}

test("sessionCwd resolves the pane's working directory", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "tn-cwd-")));
  const name = await sessionIn(dir);
  try {
    expect(await sessionCwd(name)).toBe(dir);
  } finally {
    await tmux(["kill-session", "-t", `=${name}`]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("sessionCwd is null for a session that does not exist", async () => {
  expect(await sessionCwd("no-such-session-xyz")).toBe(null);
});

test("saveSessionUpload writes into the session cwd and dedupes", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "tn-upfile-")));
  const name = await sessionIn(dir);
  try {
    const first = await saveSessionUpload(name, "doc.txt", new TextEncoder().encode("one"));
    expect(first).toEqual({ ok: true, path: join(dir, "doc.txt") });
    const second = await saveSessionUpload(name, "doc.txt", new TextEncoder().encode("two"));
    expect(second).toEqual({ ok: true, path: join(dir, "doc-2.txt") });
    expect(await readFile(join(dir, "doc.txt"), "utf8")).toBe("one");
    expect(await readFile(join(dir, "doc-2.txt"), "utf8")).toBe("two");
  } finally {
    await tmux(["kill-session", "-t", `=${name}`]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveSessionUpload refuses a name that could climb out", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "tn-upfile-")));
  const name = await sessionIn(dir);
  try {
    expect(await saveSessionUpload(name, "../escape.txt", new TextEncoder().encode("x"))).toEqual({
      ok: false,
      reason: "name",
    });
  } finally {
    await tmux(["kill-session", "-t", `=${name}`]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveSessionUpload reports a missing session", async () => {
  expect(
    await saveSessionUpload("no-such-session-xyz", "x.txt", new TextEncoder().encode("x")),
  ).toEqual({ ok: false, reason: "session" });
});

test("the upload cap is a sane constant the endpoint enforces", () => {
  expect(MAX_SESSION_UPLOAD_BYTES).toBe(20 * 1024 * 1024);
});
