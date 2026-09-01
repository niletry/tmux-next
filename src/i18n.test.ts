import { test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { DICTS, LANGS, DEFAULT_LANG, t, pickLang } from "../public/i18n.js";

/**
 * The safety net this whole change rests on.
 *
 * terminal.js, list.js and new.js are not type-checked (checkJs is
 * false), so `t("newSesion")` with a missing letter raises nothing at all — the
 * interface simply shows a blank. Across ~200 mechanical replacements that is
 * not a risk, it is a certainty.
 *
 * The reverse case is worse: if the English dictionary is missing a key that
 * the Chinese one has, only English users see the fallback and the author never
 * finds out. So key sets are compared both ways.
 */

const dir = new URL("../public/", import.meta.url).pathname;
const srcDir = new URL("../src/", import.meta.url).pathname;

/**
 * Every key referenced anywhere, however it is referenced.
 *
 * Both trees, not just the browser: push notification text is built on the
 * server from the same dictionary, and scanning only public/ reported those
 * keys as dead. A dead-key check that cries wolf gets ignored, which costs more
 * than not having one.
 */
function usedKeys(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const pluginsDir = new URL("../plugins/", import.meta.url).pathname;
  const pluginFiles = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const out = [`${pluginsDir}${d.name}/plugin.js`];
      const pub = `${pluginsDir}${d.name}/public/`;
      if (existsSync(pub)) {
        out.push(...readdirSync(pub).filter((f) => /\.(js|html)$/.test(f)).map((f) => pub + f));
      }
      return out.filter((f) => existsSync(f));
    });
  const files = [
    ...readdirSync(dir).filter((f) => /\.(js|html)$/.test(f)).map((f) => dir + f),
    ...readdirSync(srcDir).filter((f) => /\.ts$/.test(f) && !f.includes(".test.")).map((f) => srcDir + f),
    ...pluginFiles,
  ];
  for (const path of files) {
    const file = path.slice(path.lastIndexOf("/") + 1);
    const source = readFileSync(path, "utf8");
    const patterns = [
      // Both spellings: `t(key, lang)` in the pure module, `tr(key)` in the
      // browser wrapper that already knows the active language.
      /\bt\(\s*"([A-Za-z0-9_.]+)"/g,
      /\btr\(\s*"([A-Za-z0-9_.]+)"/g,
      // Keys chosen inline, e.g. tr(pinned ? "list.unpin" : "list.pin").
      // Without this they read as dead and the check cries wolf — which is
      // worse than not checking, because a noisy check gets ignored.
      /\btr?\([^)]*\?[^)]*"([A-Za-z0-9_.]+)"\s*:\s*"([A-Za-z0-9_.]+)"/g,
      /data-i18n(?:-aria|-title|-placeholder)?="([A-Za-z0-9_.]+)"/g,
      // Server side: t("push.waiting", lang)
      /\bt\(\s*"([A-Za-z0-9_.]+)"\s*,/g,
      // 插件清单里的标题键：titleKey: "jira.title"。它是真实使用点——顶栏和页面
      // 标题都读它——只是不长成 t()/tr()/data-i18n 的样子。页面外壳改由内核从清单
      // 生成之后，这就成了这些键唯一的引用处。
      /\btitleKey:\s*"([A-Za-z0-9_.]+)"/g,
    ];
    for (const re of patterns) {
      for (const m of source.matchAll(re)) {
        // A pattern may capture two keys (the ternary form); record every group.
        for (const key of m.slice(1).filter(Boolean)) {
          found.set(key, [...(found.get(key) ?? []), file]);
        }
      }
    }
  }
  return found;
}

test("both languages are declared and the default is one of them", () => {
  expect(LANGS.length).toBeGreaterThanOrEqual(2);
  expect(LANGS).toContain(DEFAULT_LANG);
  for (const lang of LANGS) expect(DICTS[lang]).toBeDefined();
});

test("the dictionaries define exactly the same keys", () => {
  const [first, ...rest] = LANGS;
  const base = Object.keys(DICTS[first!]!).sort();
  for (const lang of rest) {
    const other = Object.keys(DICTS[lang]!).sort();
    // Reported as a diff rather than a boolean so a failure names the key.
    expect({ lang, missing: base.filter((k) => !other.includes(k)) })
      .toEqual({ lang, missing: [] });
    expect({ lang, extra: other.filter((k) => !base.includes(k)) })
      .toEqual({ lang, extra: [] });
  }
});

test("every key used in the browser exists in every dictionary", () => {
  const used = usedKeys();
  expect(used.size).toBeGreaterThan(0);

  const missing: string[] = [];
  for (const [key, files] of used) {
    for (const lang of LANGS) {
      if (!(key in DICTS[lang]!)) missing.push(`${key} (${lang}) used in ${files.join(", ")}`);
    }
  }
  expect(missing).toEqual([]);
});

test("no dictionary entry is unreferenced", () => {
  const used = new Set(usedKeys().keys());
  const dead = Object.keys(DICTS[DEFAULT_LANG]!).filter((k) => !used.has(k));
  // A dead key is not dangerous, but it is a translation someone maintains for
  // nothing — and usually a leftover from a replacement that missed its site.
  expect(dead).toEqual([]);
});

test("t falls back to the key rather than rendering nothing", () => {
  // A blank interface hides the mistake; the key itself makes it obvious.
  expect(t("no.such.key", "en")).toBe("no.such.key");
  expect(t("no.such.key", "zh")).toBe("no.such.key");
});

test("t returns the right language, and an unknown language degrades", () => {
  const anyKey = Object.keys(DICTS[DEFAULT_LANG]!)[0]!;
  expect(t(anyKey, "en")).toBe(DICTS.en![anyKey]!);
  expect(t(anyKey, "zh")).toBe(DICTS.zh![anyKey]!);
  expect(t(anyKey, "klingon")).toBe(DICTS[DEFAULT_LANG]![anyKey]!);
});

test("pickLang reads an Accept-Language header the way browsers send it", () => {
  expect(pickLang("zh-CN,zh;q=0.9,en;q=0.8")).toBe("zh");
  expect(pickLang("en-GB,en;q=0.9")).toBe("en");
  expect(pickLang("zh-Hant-TW")).toBe("zh");
  // Nothing recognisable, or nothing at all: English, because that is what the
  // README and the npm page are in.
  expect(pickLang("fr-FR,de;q=0.8")).toBe("en");
  expect(pickLang("")).toBe("en");
  expect(pickLang(undefined)).toBe("en");
});
