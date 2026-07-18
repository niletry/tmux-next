import { expect, test } from "bun:test";
import { tmux } from "./run";
import { extractPreview, listSessions, rankDirectories, sessionNames } from "./session-list";

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

test("killSession removes a real session", async () => {
  const { killSession } = await import("./session-list");
  const victim = "kill-test-" + Math.random().toString(36).slice(2, 8);
  await tmux(["new-session", "-d", "-s", victim, "-x", "80", "-y", "24"]);

  const result = await killSession(victim);
  expect(result).toEqual({ ok: true });
  expect((await tmux(["has-session", "-t", victim])).ok).toBe(false);
});

test("killSession refuses to touch this app's own web sessions", async () => {
  const { killSession } = await import("./session-list");
  const { createWebSession, destroyWebSession } = await import("./session-manager");
  const target = (await listSessions())[0]!.name;
  const web = await createWebSession(target);
  try {
    const result = await killSession(web);
    expect(result.ok).toBe(false);
    expect((await tmux(["has-session", "-t", web])).ok).toBe(true);
  } finally {
    await destroyWebSession(web);
  }
});

test("killSession reports a session that does not exist", async () => {
  const { killSession } = await import("./session-list");
  const result = await killSession("no-such-session-xyz");
  expect(result.ok).toBe(false);
  expect(result.reason).toBe("missing");
});

test("killSession handles a name containing shell metacharacters", async () => {
  const { killSession } = await import("./session-list");
  // Would be catastrophic if the name ever reached a shell.
  const result = await killSession("nope; tmux kill-server");
  expect(result.ok).toBe(false);
  expect((await tmux(["list-sessions"])).ok).toBe(true);
});

test("killSession matches the name exactly, never by prefix", async () => {
  const { killSession } = await import("./session-list");
  const full = "exact-test-" + Math.random().toString(36).slice(2, 8);
  await tmux(["new-session", "-d", "-s", full, "-x", "80", "-y", "24"]);
  try {
    // tmux resolves a bare target by prefix, so this would otherwise kill `full`.
    const result = await killSession(full.slice(0, full.length - 3));
    expect(result.ok).toBe(false);
    expect((await tmux(["has-session", "-t", `=${full}`])).ok).toBe(true);
  } finally {
    await tmux(["kill-session", "-t", `=${full}`]);
  }
});

test("killSession refuses a glob pattern", async () => {
  const { killSession } = await import("./session-list");
  const full = "glob-test-" + Math.random().toString(36).slice(2, 8);
  await tmux(["new-session", "-d", "-s", full, "-x", "80", "-y", "24"]);
  try {
    const result = await killSession("glob-test-*");
    expect(result.ok).toBe(false);
    expect((await tmux(["has-session", "-t", `=${full}`])).ok).toBe(true);
  } finally {
    await tmux(["kill-session", "-t", `=${full}`]);
  }
});

test("directories are ranked by how many sessions use them", () => {
  expect(rankDirectories(["/a", "/b", "/a", "/c", "/a", "/b"])).toEqual(["/a", "/b", "/c"]);
});

test("ranking drops duplicates", () => {
  expect(rankDirectories(["/a", "/a"])).toEqual(["/a"]);
});

test("ties are broken alphabetically so the order is stable", () => {
  expect(rankDirectories(["/b", "/a"])).toEqual(["/a", "/b"]);
});

test("blank paths are ignored", () => {
  expect(rankDirectories(["", "/a", "  "])).toEqual(["/a"]);
});

test("session names include every live session", async () => {
  const marker = `probe-names-${crypto.randomUUID().slice(0, 8)}`;
  await tmux(["new-session", "-d", "-s", marker, "sleep 30"]);
  try {
    expect(await sessionNames()).toContain(marker);
  } finally {
    await tmux(["kill-session", "-t", `=${marker}`]);
  }
});
