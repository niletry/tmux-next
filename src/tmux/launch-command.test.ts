import { test, expect } from "bun:test";
import { LAUNCH_COMMAND, LAUNCH_COMMAND_SKIP_PERMISSIONS, launchCommand } from "./session-create";

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
