import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLanguage, writeLanguage, resolveLanguage, isKnownLang } from "./language";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lang-test-"));
  process.env.TMUX_NEXT_LANG_PATH = join(dir, "language.json");
});

test("nothing stored reads as null, not as the default", async () => {
  // The distinction matters: null is what allows a first-visit guess, whereas
  // a default would force English on a browser that clearly asked for Chinese.
  expect(await readLanguage()).toBeNull();
});

test("a stored language round-trips", async () => {
  expect(await writeLanguage("zh")).toBe(true);
  expect(await readLanguage()).toBe("zh");
});

test("an unsupported language is refused and nothing is written", async () => {
  expect(await writeLanguage("klingon")).toBe(false);
  expect(await writeLanguage(42)).toBe(false);
  expect(await writeLanguage(null)).toBe(false);
  expect(await readLanguage()).toBeNull();
});

test("unreadable JSON reads as null rather than throwing", async () => {
  await Bun.write(process.env.TMUX_NEXT_LANG_PATH!, "{ broken");
  expect(await readLanguage()).toBeNull();
});

test("the first visit guesses from the browser and remembers it", async () => {
  expect(await resolveLanguage("zh-CN,zh;q=0.9,en;q=0.8")).toBe("zh");
  // Persisted, so a later request from a different browser cannot flip the
  // machine's language behind the user's back.
  expect(await readLanguage()).toBe("zh");
  expect(await resolveLanguage("en-GB,en;q=0.9")).toBe("zh");
});

test("a browser asking for neither language gets English", async () => {
  expect(await resolveLanguage("fr-FR,de;q=0.8")).toBe("en");
});

test("isKnownLang accepts only what we ship", () => {
  expect(isKnownLang("zh")).toBe(true);
  expect(isKnownLang("en")).toBe(true);
  expect(isKnownLang("toString")).toBe(false);
  expect(isKnownLang(undefined)).toBe(false);
});
