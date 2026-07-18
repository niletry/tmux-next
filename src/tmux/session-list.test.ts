import { expect, test } from "bun:test";
import { extractPreview, listSessions } from "./session-list";

// Taken verbatim from a real Claude Code session on this machine.
const CLAUDE_SCREEN = [
  "  - 看一下 PR 的 CI 状态 / 有没有评论",
  "  要哪个说一声。",
  "",
  "✻ Cogitated for 1m 21s",
  "",
  "──────────────────────────────────────────────────────────────",
  "❯ rebase 到最新 master 并检查冲突",
  "──────────────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent",
].join("\n");

test("drops box drawing, blank lines and known chrome", () => {
  const { preview } = extractPreview(CLAUDE_SCREEN);
  expect(preview).toEqual([
    "  - 看一下 PR 的 CI 状态 / 有没有评论",
    "  要哪个说一声。",
    "✻ Cogitated for 1m 21s",
  ]);
});

test("pulls the prompt line out as pending input", () => {
  expect(extractPreview(CLAUDE_SCREEN).pendingInput).toBe("rebase 到最新 master 并检查冲突");
});

test("reports an empty prompt as no pending input", () => {
  const screen = ["✻ Brewed for 3m 55s", "❯ ", "──────────"].join("\n");
  expect(extractPreview(screen).pendingInput).toBe(null);
});

test("detects idle from the completion marker", () => {
  expect(extractPreview(CLAUDE_SCREEN).idle).toBe(true);
  expect(extractPreview("still working...").idle).toBe(false);
});

test("keeps at most four preview lines, taking the last ones", () => {
  const screen = ["l1", "l2", "l3", "l4", "l5", "l6"].join("\n");
  expect(extractPreview(screen).preview).toEqual(["l3", "l4", "l5", "l6"]);
});

test("survives a screen with nothing but chrome", () => {
  const screen = ["──────────", "", "  ⏵⏵ bypass permissions on"].join("\n");
  const result = extractPreview(screen);
  expect(result.preview).toEqual([]);
  expect(result.pendingInput).toBe(null);
});

test("lists the real sessions on this machine", async () => {
  const sessions = await listSessions();
  expect(sessions.length).toBeGreaterThan(0);
  for (const s of sessions) {
    expect(s.name).toBeTruthy();
    expect(s.windowWidth).toBeGreaterThan(0);
    expect(s.preview.length).toBeLessThanOrEqual(4);
  }
});

test("sorts sessions waiting on the user first", async () => {
  const sessions = await listSessions();
  const firstBusy = sessions.findIndex((s) => !s.idle);
  const lastIdle = sessions.map((s) => s.idle).lastIndexOf(true);
  if (firstBusy !== -1 && lastIdle !== -1) expect(lastIdle).toBeLessThan(firstBusy);
});
