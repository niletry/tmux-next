import { test, expect } from "bun:test";
import { pickName, validateRequestedName } from "./session-create";

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
