import { afterAll, beforeAll, expect, test } from "bun:test";
import { tmux } from "./run";

const SESSION = "run-test-" + Math.random().toString(36).slice(2, 8);
const SPACED = "run test spaced " + Math.random().toString(36).slice(2, 6);

beforeAll(async () => {
  await tmux(["new-session", "-d", "-s", SESSION, "-x", "80", "-y", "24"]);
  await tmux(["new-session", "-d", "-s", SPACED, "-x", "80", "-y", "24"]);
});

afterAll(async () => {
  await tmux(["kill-session", "-t", SESSION]);
  await tmux(["kill-session", "-t", SPACED]);
});

test("preserves a tab separator inside a format string", async () => {
  const result = await tmux([
    "display-message", "-p", "-t", SESSION, "#{session_name}\t#{window_width}",
  ]);
  expect(result.ok).toBe(true);
  expect(result.stdout.trim()).toBe(`${SESSION}\t80`);
  expect(result.stdout).not.toContain("_");
});

test("preserves a tab separator in a bare environment, as under launchd", async () => {
  // Regression: Bun.$ rewrote the tab to an underscore when the environment
  // was minimal, so the bug only appeared once the service ran under launchd.
  const script =
    `const {tmux} = await import("${import.meta.dir}/run.ts");` +
    `const r = await tmux(["display-message","-p","-t","${SESSION}","#{session_name}\\t#{window_width}"]);` +
    `process.stdout.write(JSON.stringify(r.stdout.trim()));`;

  const proc = Bun.spawn([process.execPath, "-e", script], {
    env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;

  expect(JSON.parse(out)).toBe(`${SESSION}\t80`);
});

test("handles a session name containing spaces", async () => {
  const result = await tmux(["display-message", "-p", "-t", SPACED, "#{session_name}"]);
  expect(result.ok).toBe(true);
  expect(result.stdout.trim()).toBe(SPACED);
});

test("reports failure without throwing", async () => {
  const result = await tmux(["has-session", "-t", "no-such-session-xyz"]);
  expect(result.ok).toBe(false);
  expect(result.stderr).toContain("can't find session");
});
