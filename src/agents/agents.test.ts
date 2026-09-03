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

test("availability is probed through a login shell, as launching will be", async () => {
  const { agentAvailability } = await import("./availability");
  const found = await agentAvailability();

  for (const id of AGENT_IDS) expect(typeof found[id]).toBe("boolean");

  // The probe must use the same lookup the launch does — `$SHELL -lc` — not the
  // server's own PATH. Under launchd those differ sharply, and an agent present
  // in one but not the other is exactly the case that produced a session that
  // vanished on creation with nothing reported.
  const { PROBE_SHELL_FLAGS } = await import("./availability");
  expect(PROBE_SHELL_FLAGS).toEqual(["-lc"]);
});

/**
 * readyMarker 跟 idleMarker 是两件事，这几条断言就是为了钉住这个区别。
 *
 * 起因是一次实测证伪：claude 的 idleMarker 匹配的是「一轮跑完了」（"✻ Sautéed for 9s"），
 * 一个刚起来、还没跑过任何一轮的会话**从来不打印这行**。照 idleMarker 去判断"能不能敲
 * 字了"，对 claude 会 100% 走到超时。下面三段屏幕都是从真实会话抓下来的。
 */

// 空闲等待中的 claude：屏幕底部就是孤零零一行 ❯。
const READY_SCREEN = `  ⎿  Read lib/ledger.rb (111 lines)

──────────────────────────────────── 查看单子问题 ─
❯
────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)`;

// 刚跑完一轮、但输入框里已经有字：idleMarker 命中，readyMarker 不该命中。
const DONE_SCREEN = `  没有待办。五个 PR 开着、CI 全绿。

✻ Sautéed for 9s · done 3:05 PM

────────────────────────────────────────────────────
❯ 清理 worktree 和容器
────────────────────────────────────────────────────`;

// 弹着选择菜单：两个标记都不该命中——菜单亮着的时候敲字会变成对菜单的回答。
const MENU_SCREEN = `  4. Type something.
──────────────────────────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel`;

const hits = (screen: string, re: RegExp) => screen.split("\n").some((line) => re.test(line));

test("每个 agent 都声明了 readyMarker", () => {
  for (const id of ["claude", "pi", "opencode"]) {
    expect(agentOf(id).screen.readyMarker).toBeInstanceOf(RegExp);
  }
});

test("空提示行是 claude 的就绪信号", () => {
  expect(hits(READY_SCREEN, agentOf("claude").screen.readyMarker)).toBe(true);
});

test("「一轮跑完了」不等于就绪：输入框里有字时不该敲进去", () => {
  expect(hits(DONE_SCREEN, agentOf("claude").screen.idleMarker)).toBe(true);
  expect(hits(DONE_SCREEN, agentOf("claude").screen.readyMarker)).toBe(false);
});

test("弹着菜单时两个标记都不命中", () => {
  expect(hits(MENU_SCREEN, agentOf("claude").screen.readyMarker)).toBe(false);
  expect(hits(MENU_SCREEN, agentOf("claude").screen.idleMarker)).toBe(false);
});
