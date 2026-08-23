import { test, expect } from "bun:test";
import { createSession, pickName, validateRequestedName } from "./session-create";
import { tmux } from "./run";
import { tmpdir } from "node:os";

test("an unused directory name is used as is", () => {
  expect(pickName("/mnt/data/orbit/orbit-spec", [])).toBe("orbit-spec");
});

test("a taken directory name gets a suffix", () => {
  expect(pickName("/mnt/data/orbit/orbit-spec", ["orbit-spec"])).toBe("orbit-spec-2");
});

test("suffixes keep climbing past existing ones", () => {
  expect(pickName("/a/orbit-spec", ["orbit-spec", "orbit-spec-2", "orbit-spec-3"])).toBe(
    "orbit-spec-4",
  );
});

test("a trailing slash does not swallow the directory name", () => {
  expect(pickName("/home/sam/projects/tmux-next/", [])).toBe("tmux-next");
});

test("a requested name is accepted", () => {
  expect(validateRequestedName("PROJ-1088")).toEqual({ ok: true, name: "PROJ-1088" });
});

test("surrounding whitespace is trimmed off a requested name", () => {
  expect(validateRequestedName("  PROJ-1088 ")).toEqual({ ok: true, name: "PROJ-1088" });
});

test("an absent name means generate one", () => {
  expect(validateRequestedName(undefined)).toEqual({ ok: true, name: null });
});

test("a name of only whitespace is an error, not a request to generate", () => {
  expect(validateRequestedName("   ")).toEqual({ ok: false, reason: "empty" });
});

test("the web- prefix is refused because the reaper collects those", () => {
  expect(validateRequestedName("web-123")).toEqual({ ok: false, reason: "reserved" });
});

test("a name containing a colon is refused because tmux targets use it", () => {
  expect(validateRequestedName("ENG:42788")).toEqual({ ok: false, reason: "invalid" });
});

test("a name containing a dot is refused for the same reason", () => {
  expect(validateRequestedName("my.session")).toEqual({ ok: false, reason: "invalid" });
});

test("a directory name with dots yields a targetable session name", () => {
  // /a/foo.bar.baz would otherwise create a session tmux can never look up.
  expect(pickName("/a/foo.bar.baz", [])).toBe("foo-bar-baz");
});

test("a directory at the filesystem root still yields a usable name", () => {
  expect(pickName("/", [])).toBe("session");
});

/**
 * tmux exits 0 once the session is created, which says nothing about whether
 * the thing inside it survived. A command that dies on startup — a missing
 * binary, a working directory the tmux server may not read — left the old code
 * returning `{ ok: true, created: true }` for a session tmux had already
 * destroyed, and the browser navigated to a terminal that was not there.
 *
 * This is the real case that shipped: bun (started by launchd) could stat a
 * directory on an external volume, so the pre-flight check passed, but the tmux
 * server had no macOS privacy grant for that volume and Claude exited EPERM the
 * instant it started. The check and the execution ran in two different
 * permission contexts.
 */
test("a command that dies on startup is reported, not called created", async () => {
  const name = `create-death-${process.pid}`;
  const result = await createSession(tmpdir(), name, [], "false");

  expect(result).toEqual({ ok: false, reason: "startfailed" });

  // And nothing is left behind for the next list to show.
  const survivors = await tmux(["has-session", "-t", `=${name}`]);
  expect(survivors.ok).toBe(false);
});

test("a command that keeps running is created normally", async () => {
  const name = `create-alive-${process.pid}`;
  try {
    const result = await createSession(tmpdir(), name, [], "sleep 30");
    expect(result).toEqual({ ok: true, name, created: true });
  } finally {
    await tmux(["kill-session", "-t", `=${name}`]);
  }
});
