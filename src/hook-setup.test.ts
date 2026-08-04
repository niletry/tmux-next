import { test, expect } from "bun:test";
import { addSessionStartHook } from "./hook-setup";

const CMD = "/home/u/.claude/hooks/tmux-next-session.sh";

test("adds a SessionStart hook to empty settings", () => {
  const { settings, added } = addSessionStartHook({}, CMD);
  expect(added).toBe(true);
  expect(settings).toEqual({
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: CMD }] }] },
  });
});

test("does not add a duplicate on a second run", () => {
  const once = addSessionStartHook({}, CMD).settings;
  const { settings, added } = addSessionStartHook(once, CMD);
  expect(added).toBe(false);
  expect((settings.hooks as { SessionStart: unknown[] }).SessionStart.length).toBe(1);
});

test("preserves unrelated settings and other hook events", () => {
  const input = {
    model: "opus",
    permissions: { defaultMode: "dontAsk" },
    hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "other" }] }] },
  };
  const { settings, added } = addSessionStartHook(input, CMD);
  expect(added).toBe(true);
  expect(settings.model).toBe("opus");
  expect(settings.permissions).toEqual({ defaultMode: "dontAsk" });
  const hooks = settings.hooks as Record<string, unknown[]>;
  expect(hooks.PreToolUse.length).toBe(1); // untouched
  expect(hooks.SessionStart.length).toBe(1); // added
});

test("appends alongside an existing, different SessionStart hook", () => {
  const input = {
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "someone-elses" }] }] },
  };
  const { settings, added } = addSessionStartHook(input, CMD);
  expect(added).toBe(true);
  expect((settings.hooks as { SessionStart: unknown[] }).SessionStart.length).toBe(2);
});

import { addCommandHook } from "./hook-setup";

test("addCommandHook registers under an arbitrary event", () => {
  const { settings, added } = addCommandHook({}, "Stop", "/x/notify.sh");
  expect(added).toBe(true);
  expect(settings).toEqual({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "/x/notify.sh" }] }] },
  });
});

test("registering all four tmux-next hooks builds each event once, idempotently", () => {
  const SESSION = "/x/session.sh";
  const NOTIFY = "/x/notify.sh";
  const register = (s: Record<string, unknown>) => {
    let r = addCommandHook(s, "SessionStart", SESSION);
    for (const ev of ["Stop", "SessionEnd", "Notification"]) r = addCommandHook(r.settings, ev, NOTIFY);
    return r.settings;
  };

  const once = register({});
  const hooks = once.hooks as Record<string, unknown[]>;
  expect(Object.keys(hooks).sort()).toEqual(["Notification", "SessionEnd", "SessionStart", "Stop"]);
  expect(hooks.Stop.length).toBe(1);

  // A second run over the same settings adds nothing.
  const twice = register(once);
  const hooks2 = twice.hooks as Record<string, unknown[]>;
  for (const ev of ["SessionStart", "Stop", "SessionEnd", "Notification"]) {
    expect(hooks2[ev]!.length).toBe(1);
  }
});
