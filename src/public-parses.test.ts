import { test, expect } from "bun:test";
import { readdirSync } from "node:fs";

/**
 * Every browser module must at least parse.
 *
 * These files never run under `bun test` — only a browser loads them — so a
 * plain syntax error ships silently. That is not hypothetical: redeclaring a
 * name that was already a function parameter in `drawCrumb` took the whole
 * create sheet down with an uncaught SyntaxError, and the suite stayed green
 * because `create-sheet.js` is imported by nothing.
 *
 * Bundling is the cheapest check that covers the whole directory. It catches
 * syntax and static-resolution errors, not runtime behaviour.
 */
const dir = new URL("../public/", import.meta.url).pathname;
const modules = readdirSync(dir).filter((f) => f.endsWith(".js"));

test("the public directory has browser modules to check", () => {
  expect(modules.length).toBeGreaterThan(0);
});

test.each(modules)("%s parses as a browser module", async (file) => {
  const built = await Bun.build({ entrypoints: [dir + file], target: "browser" });
  expect(built.logs.map(String)).toEqual([]);
  expect(built.success).toBe(true);
});
