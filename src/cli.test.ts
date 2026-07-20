import { test, expect } from "bun:test";
import { MIN_TMUX, meetsMinimum, parseArgs, parseTmuxVersion } from "./cli";

test("no arguments runs on the default port", () => {
  expect(parseArgs([])).toEqual({ kind: "run", port: 7682, host: "127.0.0.1" });
});

test("--port overrides the default", () => {
  expect(parseArgs(["--port", "9000"])).toMatchObject({ kind: "run", port: 9000 });
});

test("--host lets the service bind somewhere other than loopback", () => {
  expect(parseArgs(["--host", "0.0.0.0"])).toMatchObject({ host: "0.0.0.0" });
});

test("--help and --version short-circuit", () => {
  expect(parseArgs(["--help"]).kind).toBe("help");
  expect(parseArgs(["-h"]).kind).toBe("help");
  expect(parseArgs(["--version"]).kind).toBe("version");
});

test("a port that is not a number is refused with a usable message", () => {
  const r = parseArgs(["--port", "abc"]);
  expect(r.kind).toBe("error");
  if (r.kind === "error") expect(r.message).toContain("--port");
});

test("a port outside the valid range is refused", () => {
  expect(parseArgs(["--port", "0"]).kind).toBe("error");
  expect(parseArgs(["--port", "70000"]).kind).toBe("error");
});

test("--port with nothing after it is refused rather than silently defaulting", () => {
  expect(parseArgs(["--port"]).kind).toBe("error");
});

test("an unknown flag is refused instead of ignored", () => {
  const r = parseArgs(["--colour"]);
  expect(r.kind).toBe("error");
  if (r.kind === "error") expect(r.message).toContain("--colour");
});

test("tmux version strings parse, letter suffixes and all", () => {
  expect(parseTmuxVersion("tmux 3.7b")).toEqual({ major: 3, minor: 7 });
  expect(parseTmuxVersion("tmux 3.2a\n")).toEqual({ major: 3, minor: 2 });
  expect(parseTmuxVersion("tmux 2.8")).toEqual({ major: 2, minor: 8 });
  expect(parseTmuxVersion("tmux next-3.4")).toEqual({ major: 3, minor: 4 });
  expect(parseTmuxVersion("tmux 4.0")).toEqual({ major: 4, minor: 0 });
});

test("an unparseable version is null rather than a wrong guess", () => {
  expect(parseTmuxVersion("")).toBe(null);
  expect(parseTmuxVersion("command not found")).toBe(null);
});

test("the minimum is 3.2, where refresh-client took the comma form", () => {
  // `refresh-client -C 80,24` is how every resize is sent; before 3.2 that
  // syntax is not understood and sizing silently does nothing.
  expect(MIN_TMUX).toEqual({ major: 3, minor: 2 });
  expect(meetsMinimum({ major: 3, minor: 2 }, MIN_TMUX)).toBe(true);
  expect(meetsMinimum({ major: 3, minor: 1 }, MIN_TMUX)).toBe(false);
  expect(meetsMinimum({ major: 2, minor: 9 }, MIN_TMUX)).toBe(false);
  expect(meetsMinimum({ major: 4, minor: 0 }, MIN_TMUX)).toBe(true);
});

test("the running tmux on this machine satisfies the minimum", async () => {
  const proc = Bun.spawn(["tmux", "-V"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const v = parseTmuxVersion(out);
  expect(v).not.toBe(null);
  expect(meetsMinimum(v!, MIN_TMUX)).toBe(true);
});
