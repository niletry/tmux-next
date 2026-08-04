import { test, expect } from "bun:test";
import {
  LAUNCH_COMMAND,
  LAUNCH_COMMAND_SKIP_PERMISSIONS,
  launchCommand,
  resumeCommand,
} from "./session-create";

test("the default launch asks Claude Code for permission as usual", () => {
  expect(LAUNCH_COMMAND).not.toContain("dangerously");
});

test("the opt-in launch carries the flag", () => {
  expect(LAUNCH_COMMAND_SKIP_PERMISSIONS).toContain("--dangerously-skip-permissions");
});

test("skipping permissions is off unless asked for", () => {
  expect(launchCommand(undefined)).toBe(LAUNCH_COMMAND);
  expect(launchCommand(false)).toBe(LAUNCH_COMMAND);
  expect(launchCommand(null)).toBe(LAUNCH_COMMAND);
});

test("only a real boolean true turns it on", () => {
  // The value arrives as untrusted JSON: a truthy string must not enable a
  // flag that lets Claude Code act without asking.
  expect(launchCommand(true)).toBe(LAUNCH_COMMAND_SKIP_PERMISSIONS);
  for (const truthy of ["true", "yes", 1, {}, [], "on"]) {
    expect(launchCommand(truthy)).toBe(LAUNCH_COMMAND);
  }
});

test("both commands stay constants with nothing interpolatable", () => {
  // tmux hands these to `sh -c`. The whole reason they are constants is that
  // caller input must never reach a shell; a placeholder would break that.
  for (const cmd of [LAUNCH_COMMAND, LAUNCH_COMMAND_SKIP_PERMISSIONS]) {
    expect(cmd).not.toMatch(/\$\{|`/);
    expect(cmd.startsWith('exec "$SHELL" -lc ')).toBe(true);
  }
});

test("resumeCommand builds a --resume launch for an id-safe id", () => {
  const id = "53102e0e-58d4-4223-8343-7e260c917651";
  expect(resumeCommand(id, undefined)).toBe(`exec "$SHELL" -lc "claude --resume ${id}"`);
});

test("resumeCommand adds the skip-permissions flag only for a real true", () => {
  const id = "abc-123";
  expect(resumeCommand(id, true)).toBe(
    `exec "$SHELL" -lc "claude --resume ${id} --dangerously-skip-permissions"`,
  );
  expect(resumeCommand(id, "true")).toBe(`exec "$SHELL" -lc "claude --resume ${id}"`);
});

test("resumeCommand refuses anything that isn't an id-safe string", () => {
  for (const bad of [
    "", // empty
    "a b", // space
    "a;rm -rf /", // shell metacharacters
    "a.b", // dot
    "id$(whoami)",
    "`id`",
    "../../etc",
    "x".repeat(65), // too long
    undefined,
    null,
    42,
    {},
  ]) {
    expect(resumeCommand(bad, false)).toBeNull();
  }
});
