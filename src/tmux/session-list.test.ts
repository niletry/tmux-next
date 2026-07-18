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

test("excludes this app's own web sessions from the list", async () => {
  const { createWebSession, destroyWebSession } = await import("./session-manager");
  const target = (await listSessions())[0]!.name;
  const web = await createWebSession(target);
  try {
    const names = (await listSessions()).map((s) => s.name);
    expect(names).not.toContain(web);
  } finally {
    await destroyWebSession(web);
  }
});

test("parses every field in a bare environment, as under launchd", async () => {
  // Regression: tmux rewrites a tab in a format string to `_` when no locale
  // is set, which silently collapsed every field into the session name. The
  // service only hits this once launchd starts it with an empty environment.
  const script =
    `const {listSessions} = await import("${import.meta.dir}/session-list.ts");` +
    `const s = (await listSessions())[0];` +
    `process.stdout.write(JSON.stringify({name: s.name, width: s.windowWidth}));`;

  const proc = Bun.spawn([process.execPath, "-e", script], {
    env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;

  const parsed = JSON.parse(out);
  expect(parsed.name).not.toContain("_");
  expect(typeof parsed.width).toBe("number");
  expect(parsed.width).toBeGreaterThan(0);
});
