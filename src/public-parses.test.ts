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

/**
 * Every name a browser module uses must be one it can actually reach.
 *
 * Bundling catches syntax and unresolved *imports*; it does not catch a name
 * that was never imported at all — `tr(...)` with no import is valid JavaScript
 * and fails only when the line runs. That shipped: list.js called `tr` 25 times
 * with no import from the very first i18n commit, and the page died on render
 * while the whole suite stayed green.
 *
 * Bun's minifier renames every local, so a shared helper still appearing under
 * its original name in the output was never bound in that file.
 */
test.each(modules)("%s references no undefined name", async (file) => {
  const built = await Bun.build({
    entrypoints: [dir + file],
    target: "browser",
    minify: { identifiers: true, syntax: false, whitespace: false },
  });
  expect(built.success).toBe(true);
  const code = await built.outputs[0]!.text();

  // Checked by name rather than by scanning every call: the shared helpers are
  // few and known, and a targeted check gives a failure that names the missing
  // import instead of a list of suspects to sift through.
  const suspects = new Set<string>();
  for (const name of ["tr", "t", "initLang", "initTheme", "el"]) {
    const usedBare = new RegExp(`(^|[^.\\w$])${name}\\s*\\(`).test(code);
    const declared = new RegExp(
      `(function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\b|\\b${name}\\s*(?:,|\\s)*[^)]*\\)\\s*=>|import[^;]*\\b${name}\\b)`,
    ).test(code);
    if (usedBare && !declared) suspects.add(name);
  }
  expect([...suspects]).toEqual([]);
});
