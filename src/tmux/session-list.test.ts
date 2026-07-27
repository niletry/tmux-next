import { expect, test } from "bun:test";
import { dirname } from "node:path";
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

test("lists a session with its geometry and a bounded preview", async () => {
  // Creates its own session rather than trusting the machine to have one — on
  // a clean box (CI) there are none, and asserting length > 0 failed there.
  const name = `list-shape-${crypto.randomUUID().slice(0, 8)}`;
  await tmux(["new-session", "-d", "-s", name, "-x", "80", "-y", "24", "sleep 30"]);
  try {
    const mine = (await listSessions()).find((s) => s.name === name);
    expect(mine).toBeDefined();
    expect(mine!.windowWidth).toBeGreaterThan(0);
    expect(mine!.preview.length).toBeLessThanOrEqual(4);
  } finally {
    await tmux(["kill-session", "-t", `=${name}`]);
  }
});

test("orders sessions by most recent activity", async () => {
  const sessions = await listSessions();
  // Non-increasing activity from top to bottom: the freshest session leads, so
  // the one just used is found at the top rather than sorted by its idle state.
  for (let i = 1; i < sessions.length; i++) {
    expect(sessions[i - 1]!.lastActivityEpoch).toBeGreaterThanOrEqual(
      sessions[i]!.lastActivityEpoch,
    );
  }
});

test("excludes this app's own web sessions from the list", async () => {
  const { createWebSession, destroyWebSession } = await import("./session-manager");
  // A dedicated target, not whatever happened to be first: on a clean box
  // there is no first session to grab.
  const target = `web-exclude-${crypto.randomUUID().slice(0, 8)}`;
  await tmux(["new-session", "-d", "-s", target, "-x", "80", "-y", "24", "sleep 30"]);
  const web = await createWebSession(target);
  try {
    const names = (await listSessions()).map((s) => s.name);
    expect(names).not.toContain(web);
  } finally {
    await destroyWebSession(web);
    await tmux(["kill-session", "-t", `=${target}`]);
  }
});

test("parses every field in a bare environment, as under launchd", async () => {
  // Regression: tmux rewrites a tab in a format string to `_` when no locale
  // is set, which silently collapsed every field into the session name. The
  // service only hits this once launchd starts it with an empty environment.
  const name = `bare-env-${crypto.randomUUID().slice(0, 8)}`;
  await tmux(["new-session", "-d", "-s", name, "-x", "80", "-y", "24", "sleep 30"]);

  // Reproduce the bare launchd environment without hardcoding a PATH: keep the
  // real tmux reachable by including its directory, but strip LANG/LC_* so the
  // no-locale rewrite this test guards against is actually in force.
  // Bun.which resolves tmux on PATH with no shell at all — earlier attempts
  // via Bun.$ tripped over its built-in shell (no `$(...)`, then no `command`
  // builtin), which differed between macOS and the CI runner.
  const tmuxPath = Bun.which("tmux");
  if (!tmuxPath) throw new Error("tmux not found on PATH");
  const tmuxDir = dirname(tmuxPath);
  // The subprocess reports its own outcome as JSON on stdout — including any
  // failure — so the reason survives CI's log grouping, which swallows a
  // thrown assertion message.
  const script =
    `try {` +
    `const {listSessions} = await import("${import.meta.dir}/session-list.ts");` +
    `const s = (await listSessions()).find((x) => x.name === ${JSON.stringify(name)});` +
    `process.stdout.write(JSON.stringify({ok: true, s: s ? {name: s.name, width: s.windowWidth} : null}));` +
    `} catch (e) { process.stdout.write(JSON.stringify({ok: false, error: String(e)})); }`;

  try {
    // A bare PATH and HOME, matching what launchd actually hands the service —
    // not a fully empty environment, which launchd never produces. The locale
    // is inherited rather than stripped: dropping it made run.ts fall back to
    // en_US.UTF-8, a locale the Linux CI runner has not generated.
    const proc = Bun.spawn([process.execPath, "-e", script], {
      env: {
        PATH: `${tmuxDir}:/usr/bin:/bin`,
        HOME: process.env.HOME!,
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? "C.UTF-8",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;

    let result: { ok: boolean; s?: { name: string; width: number } | null; error?: string };
    try {
      result = JSON.parse(out);
    } catch {
      throw new Error(`subprocess exit ${code}; stdout=${JSON.stringify(out)}; stderr=${err}`);
    }
    if (!result.ok) throw new Error(`subprocess threw: ${result.error}`);

    expect(result.s, "subprocess found no matching session").not.toBeNull();
    expect(result.s!.name).not.toContain("_");
    expect(result.s!.name).toBe(name);
    expect(result.s!.width).toBeGreaterThan(0);
  } finally {
    await tmux(["kill-session", "-t", `=${name}`]);
  }
});

test("killSession removes a real session", async () => {
  const { killSession } = await import("./session-list");
  const victim = "kill-test-" + Math.random().toString(36).slice(2, 8);
  await tmux(["new-session", "-d", "-s", victim, "-x", "80", "-y", "24"]);

  const result = await killSession(victim);
  expect(result).toEqual({ ok: true });
  expect((await tmux(["has-session", "-t", victim])).ok).toBe(false);
});

test("killSession stops the processes even while a web session is attached", async () => {
  // A grouped web session shares the target's windows, so killing the target
  // alone leaves its processes running under the web session. The kill has to
  // take the web session too, or "stop this session" would silently not.
  const { killSession } = await import("./session-list");
  const { createWebSession } = await import("./session-manager");
  // A unique sleep duration is the marker: it is a single valid argument (so
  // the process actually starts) and greppable (so we can tell if it died).
  const marker = `sleep ${800000 + Math.floor(Math.random() * 99999)}`;
  const victim = `kill-attached-${crypto.randomUUID().slice(0, 8)}`;
  await tmux(["new-session", "-d", "-s", victim, "-x", "80", "-y", "24", marker]);
  const web = await createWebSession(victim);
  const alive = async () =>
    (await Bun.$`pgrep -f ${marker}`.quiet().nothrow()).stdout.toString().trim().length > 0;

  try {
    expect(await alive()).toBe(true);
    const result = await killSession(victim);
    expect(result).toEqual({ ok: true });
    await Bun.sleep(300);
    expect(await alive()).toBe(false);
    expect((await tmux(["has-session", "-t", `=${web}`])).ok).toBe(false);
  } finally {
    await Bun.$`pkill -f ${marker}`.quiet().nothrow();
    await tmux(["kill-session", "-t", `=${victim}`]).catch(() => {});
    await tmux(["kill-session", "-t", `=${web}`]).catch(() => {});
  }
});

test("killSession refuses to touch this app's own web sessions", async () => {
  const { killSession } = await import("./session-list");
  const { createWebSession, destroyWebSession } = await import("./session-manager");
  const target = `web-refuse-${crypto.randomUUID().slice(0, 8)}`;
  await tmux(["new-session", "-d", "-s", target, "-x", "80", "-y", "24", "sleep 30"]);
  const web = await createWebSession(target);
  try {
    const result = await killSession(web);
    expect(result.ok).toBe(false);
    expect((await tmux(["has-session", "-t", web])).ok).toBe(true);
  } finally {
    await destroyWebSession(web);
    await tmux(["kill-session", "-t", `=${target}`]);
  }
});

test("killSession reports a session that does not exist", async () => {
  const { killSession } = await import("./session-list");
  const result = await killSession("no-such-session-xyz");
  // Narrowed rather than asserted: `reason` only exists on the failure arm, so
  // reading it off the union is exactly the mistake the types should catch.
  expect(result).toEqual({ ok: false, reason: "missing" });
});

test("killSession handles a name containing shell metacharacters", async () => {
  const { killSession } = await import("./session-list");
  // A live session proves the server survived; list-sessions exits non-zero
  // when no server is running, which on a clean box is not the same as harm.
  const guard = `meta-guard-${crypto.randomUUID().slice(0, 8)}`;
  await tmux(["new-session", "-d", "-s", guard, "-x", "80", "-y", "24", "sleep 30"]);
  try {
    // Would be catastrophic if the name ever reached a shell.
    const result = await killSession("nope; tmux kill-server");
    expect(result.ok).toBe(false);
    expect((await tmux(["has-session", "-t", `=${guard}`])).ok).toBe(true);
  } finally {
    await tmux(["kill-session", "-t", `=${guard}`]);
  }
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

test("a listed session carries the text on its screen", async () => {
  // Asserting preview.length <= 4 is what let a permanently empty preview
  // through: an empty array satisfies it. This pins actual content instead.
  const name = `probe-preview-${crypto.randomUUID().slice(0, 8)}`;
  const marker = "PREVIEW_MARKER_7c1d";
  await tmux(["new-session", "-d", "-s", name, `echo ${marker}; sleep 30`]);
  try {
    const listed = await listSessions();
    const found = listed.find((s) => s.name === name);
    expect(found?.preview.join("\n")).toContain(marker);
  } finally {
    await tmux(["kill-session", "-t", `=${name}`]);
  }
});
