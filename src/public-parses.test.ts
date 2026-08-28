import { test, expect } from "bun:test";
import { readdirSync, existsSync } from "node:fs";

/**
 * Every browser module must at least parse.
 *
 * These files never run under `bun test` — only a browser loads them — so a
 * plain syntax error ships silently. That is not hypothetical: redeclaring a
 * name that was already a function parameter in `drawCrumb` took the whole
 * create sheet down with an uncaught SyntaxError, and the suite stayed green
 * because the file was imported by nothing.
 *
 * Bundling is the cheapest check that covers the whole directory. It catches
 * syntax and static-resolution errors, not runtime behaviour.
 */
const dir = new URL("../public/", import.meta.url).pathname;
const pluginsDir = new URL("../plugins/", import.meta.url).pathname;

/**
 * public/ 和每个插件的 public/。插件页面同样只有浏览器加载，语法错误同样会
 * 静悄悄发布——这个文件存在的理由一字不差地适用于它们。
 */
const modules = [
  ...readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => dir + f),
  ...readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const pub = `${pluginsDir}${d.name}/public/`;
      if (!existsSync(pub)) return [];
      return readdirSync(pub).filter((f) => f.endsWith(".js")).map((f) => pub + f);
    }),
  ...readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(`${pluginsDir}${d.name}/plugin.js`))
    .map((d) => `${pluginsDir}${d.name}/plugin.js`),
];

test("the public directory has browser modules to check", () => {
  expect(modules.length).toBeGreaterThan(0);
});

/**
 * A plugin page's `../../foo.js` is written for how the *browser* resolves
 * it — from the URL the page is served at (`/p/<id>/…`), one segment
 * shallower than the file's real home on disk (`plugins/<id>/public/…`),
 * because `public/` is a directory name that exists on disk but never in a
 * URL. Left to Bun.build's plain on-disk resolution, that specifier looks
 * broken even though it is exactly right for the page that will load it.
 * This plugin re-derives the same `/p/<id>/…` mapping src/server.ts uses, so
 * the build sees what a browser actually would; unrelated specifiers (e.g.
 * i18n.js's own single-level "../plugins/registry.js") already resolve fine
 * on disk and are left alone.
 */
const pluginPageResolve: import("bun").BunPlugin = {
  name: "resolve like a plugin page's browser url",
  setup(build) {
    build.onResolve({ filter: /^\.\.\/\.\.\// }, (args) => {
      const importerId = args.importer.match(new RegExp(`^${pluginsDir}([^/]+)/public/`));
      if (!importerId) return undefined; // not a plugin page; default resolution applies
      const served = new URL(args.path, `http://x/p/${importerId[1]}/`).pathname;
      const asPage = served.match(/^\/p\/([^/]+)\/(.*)$/);
      if (asPage) return { path: `${pluginsDir}${asPage[1]}/public/${asPage[2]}` };
      const asManifest = served.match(/^\/plugins\/([^/]+)\/plugin\.js$/);
      if (asManifest) return { path: `${pluginsDir}${asManifest[1]}/plugin.js` };
      if (served === "/plugins/registry.js") return { path: `${pluginsDir}registry.js` };
      return { path: dir + served.slice(1) }; // everything else lives in public/
    });
  },
};

test.each(modules)("%s parses as a browser module", async (file) => {
  const built = await Bun.build({ entrypoints: [file], target: "browser", plugins: [pluginPageResolve] });
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
    entrypoints: [file],
    target: "browser",
    minify: { identifiers: true, syntax: false, whitespace: false },
    plugins: [pluginPageResolve],
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
