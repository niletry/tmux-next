import { test, expect } from "bun:test";
import { AGENTS, AGENT_IDS, DEFAULT_AGENT, agentOf, isKnownAgent } from "./index";

/**
 * The registry, and the invariant that makes it safe.
 *
 * Launch commands reach tmux through `sh -c`. The rule that keeps that safe is
 * that nothing derived from a request is ever part of one — so an agent is
 * chosen by *looking up a fixed table*, never by interpolating a name. These
 * tests exist to keep that true as agents are added.
 */

test("every declared id resolves and matches its own key", () => {
  for (const id of AGENT_IDS) {
    const agent = AGENTS[id]!;
    expect(agent.id).toBe(id);
    expect(agent.label.length).toBeGreaterThan(0);
  }
  expect(AGENT_IDS).toContain(DEFAULT_AGENT);
});

test("an unknown or hostile id never resolves", () => {
  for (const bad of [
    "claude; rm -rf ~",
    "claude ",
    "../claude",
    "CLAUDE",
    "",
    "toString",
    "constructor",
    "__proto__",
  ]) {
    expect(isKnownAgent(bad)).toBe(false);
    // agentOf falls back rather than throwing, so a stale stored value degrades
    // to the default instead of breaking the page.
    expect(agentOf(bad)).toBe(AGENTS[DEFAULT_AGENT]!);
  }
  expect(isKnownAgent(null)).toBe(false);
  expect(isKnownAgent(undefined)).toBe(false);
});

test("launch commands are constants that never embed their input", () => {
  for (const id of AGENT_IDS) {
    const agent = AGENTS[id]!;
    const plain = agent.launch({ skipPermissions: false });
    const skip = agent.launch({ skipPermissions: true });
    for (const cmd of [plain, skip]) {
      expect(typeof cmd).toBe("string");
      expect(cmd.length).toBeGreaterThan(0);
      // The agent id is a table key, not something spliced into a command.
      expect(cmd).not.toContain(";");
      expect(cmd).not.toContain("&&");
      expect(cmd).not.toContain("`");
      expect(cmd).not.toContain("$(");
    }
    // Where the agent has the mode, it must be a *different fixed string*
    // rather than a flag concatenated onto the first. Where it has no such
    // mode, both calls give the same command — verified rather than assumed,
    // because offering a switch that silently does nothing is worse than not
    // offering one: opencode has no equivalent flag, and pi's --approve means
    // something else (trusting project-local config).
    if (agent.supportsSkipPermissions) expect(skip).not.toBe(plain);
    else expect(skip).toBe(plain);
  }
});

test("resume validates the id before it can reach a shell", () => {
  for (const id of AGENT_IDS) {
    const agent = AGENTS[id]!;
    if (!agent.resume) continue;
    for (const bad of ["a b", "x;y", "../etc", "$(id)", "`id`", "", "a".repeat(65)]) {
      expect(agent.resume(bad, { skipPermissions: false })).toBeNull();
    }
    const good = agent.resume("019dd921-6a9f-716a-88b4-c97cbd43f1d1", {
      skipPermissions: false,
    });
    expect(good).toContain("019dd921-6a9f-716a-88b4-c97cbd43f1d1");
  }
});

test("every agent can parse its own screen", () => {
  for (const id of AGENT_IDS) {
    const { chrome, idleMarker } = AGENTS[id]!.screen;
    expect(Array.isArray(chrome)).toBe(true);
    expect(idleMarker).toBeInstanceOf(RegExp);
  }
});

test("claude keeps the exact launch commands it had before this abstraction", () => {
  // The existing suite pins these strings elsewhere; repeating them here makes
  // an accidental change during the refactor fail loudly rather than quietly
  // start a different program in every user's session.
  const claude = AGENTS.claude!;
  expect(claude.launch({ skipPermissions: false })).toBe('exec "$SHELL" -lc claude');
  expect(claude.launch({ skipPermissions: true })).toBe(
    'exec "$SHELL" -lc "claude --dangerously-skip-permissions"',
  );
});
