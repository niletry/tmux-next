import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staleHooks, staleHookMessage } from "./hook-freshness";

/**
 * Why this check exists at all.
 *
 * `tmux-next hook` *copies* the scripts into ~/.claude/hooks. Upgrading the npm
 * package therefore updates the copy inside node_modules and leaves the
 * installed one untouched — so a fix to a hook does not reach anyone who
 * already ran the installer. The grouped-session bug was exactly that shape and
 * exactly that invisible: nothing errored, bindings and pushes just silently
 * stopped for sessions a browser had open.
 *
 * A line at startup is the cheapest thing that turns a silent staleness into
 * something someone can act on.
 */

function fixture(): { home: string; packaged: string } {
  const home = mkdtempSync(join(tmpdir(), "fresh-home-"));
  const packaged = mkdtempSync(join(tmpdir(), "fresh-pkg-"));
  mkdirSync(join(home, ".claude", "hooks"), { recursive: true });
  return { home, packaged };
}

const NAMES = ["tmux-next-session.sh", "tmux-next-notify.sh"];

test("reports nothing when no hook is installed", async () => {
  const { home, packaged } = fixture();
  for (const n of NAMES) writeFileSync(join(packaged, n), "new\n");
  // Never installed: the user does not use the feature, so there is nothing to
  // nag about. Suggesting an install here would be advertising, not a warning.
  expect(await staleHooks(home, packaged)).toEqual([]);
});

test("reports nothing when the installed copies match", async () => {
  const { home, packaged } = fixture();
  for (const n of NAMES) {
    writeFileSync(join(packaged, n), "same\n");
    writeFileSync(join(home, ".claude", "hooks", n), "same\n");
  }
  expect(await staleHooks(home, packaged)).toEqual([]);
});

test("reports the scripts whose installed copy differs", async () => {
  const { home, packaged } = fixture();
  writeFileSync(join(packaged, NAMES[0]!), "new\n");
  writeFileSync(join(home, ".claude", "hooks", NAMES[0]!), "old\n");
  writeFileSync(join(packaged, NAMES[1]!), "same\n");
  writeFileSync(join(home, ".claude", "hooks", NAMES[1]!), "same\n");

  expect(await staleHooks(home, packaged)).toEqual([NAMES[0]!]);
});

test("reports only the installed one when just one of the two exists", async () => {
  const { home, packaged } = fixture();
  for (const n of NAMES) writeFileSync(join(packaged, n), "new\n");
  writeFileSync(join(home, ".claude", "hooks", NAMES[1]!), "old\n");
  expect(await staleHooks(home, packaged)).toEqual([NAMES[1]!]);
});

test("an unreadable packaged directory reports nothing rather than throwing", async () => {
  const { home } = fixture();
  // A published package always ships hooks/, but a check that can crash the
  // server on startup is worse than a check that quietly gives up.
  expect(await staleHooks(home, join(tmpdir(), "no-such-pkg-" + Math.random()))).toEqual([]);
});

test("staleHookMessage stays silent when nothing is stale", () => {
  expect(staleHookMessage([])).toBeNull();
});

test("staleHookMessage names the scripts and the command that fixes them", () => {
  const msg = staleHookMessage(["tmux-next-session.sh"])!;
  expect(msg).toContain("tmux-next-session.sh");
  expect(msg).toContain("bunx tmux-next hook");
  // The reason matters more than the fact: a stale hook is invisible, so the
  // line has to say what is quietly not happening.
  expect(msg).toContain("silently");
});
