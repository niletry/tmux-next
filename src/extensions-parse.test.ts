import { test, expect } from "bun:test";
import { readdirSync } from "node:fs";

/**
 * Every agent-side extension must at least build.
 *
 * These files never run under `bun test` — they are copied into the user's
 * agent and loaded by it — so a syntax error ships silently and this suite
 * stays green. Exactly the reason public-parses.test.ts exists, and exactly the
 * failure mode extensions are worst at: a broken one is indistinguishable from
 * an agent that simply sends no notifications.
 */
const dir = new URL("../extensions/", import.meta.url).pathname;
const entries = readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => `${dir}${d.name}/tmux-next.ts`);

test("there are extensions to check", () => {
  expect(entries.length).toBeGreaterThan(0);
});

test.each(entries)("%s builds", async (entry) => {
  const built = await Bun.build({ entrypoints: [entry], target: "bun" });
  expect(built.logs.map(String)).toEqual([]);
  expect(built.success).toBe(true);
});

test.each(entries)("%s resolves the tmux session with list-panes, not display-message", async (entry) => {
  // Built output, not source: the source *explains* why display-message is
  // wrong, and a naive text search would flag that comment. Comments are gone
  // after a build, so what remains is what actually runs.
  const built = await Bun.build({ entrypoints: [entry], target: "bun" });
  const code = await built.outputs[0]!.text();

  // The bug that cost three sessions. An extension repeating it would fail
  // silently on precisely the sessions someone is watching.
  expect(code).toContain("list-panes");
  expect(code).not.toContain("display-message");
  expect(code).toContain("web-");
});

test.each(entries)("%s uses only Node built-ins, never the Bun global", async (entry) => {
  const built = await Bun.build({ entrypoints: [entry], target: "node" });
  const code = await built.outputs[0]!.text();
  // Both agents run their extensions on Node. Reaching for `Bun.` throws
  // "Bun is not defined" inside an event handler, which takes the notification
  // with it and reports nothing — the exact failure this cost an hour to find.
  expect(code).not.toMatch(/\bBun\./);
});
