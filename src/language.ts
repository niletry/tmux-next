import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { LANGS, DEFAULT_LANG, pickLang } from "../public/i18n.js";

/**
 * Which language this machine's interface is in.
 *
 * Machine-level for the same reason the theme is: "what this machine looks
 * like" is a different question from "how big this screen is". Pick English on
 * your phone and the desktop follows.
 *
 * A separate file from theme.json rather than a field inside it — that name
 * describes a colour scheme, and folding unrelated settings into it only gets
 * worse with the third one.
 */
export function languagePath(): string {
  return process.env.TMUX_NEXT_LANG_PATH || join(homedir(), ".tmux-next", "language.json");
}

export function isKnownLang(lang: unknown): lang is string {
  return typeof lang === "string" && LANGS.includes(lang);
}

/**
 * The stored language, or null if nothing has been chosen yet.
 *
 * Null is distinct from the default: it is what lets the first request guess
 * from Accept-Language instead of forcing English on someone whose browser
 * clearly says otherwise.
 */
export async function readLanguage(): Promise<string | null> {
  try {
    const data = (await Bun.file(languagePath()).json()) as { lang?: unknown };
    return isKnownLang(data?.lang) ? data.lang : null;
  } catch {
    return null;
  }
}

export async function writeLanguage(lang: unknown): Promise<boolean> {
  if (!isKnownLang(lang)) return false;
  const path = languagePath();
  await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
  await Bun.write(path, JSON.stringify({ lang }));
  return true;
}

/**
 * The language to serve, guessing from the browser on first use.
 *
 * The guess is persisted so it happens once: a later request from a different
 * browser should not silently flip the machine's language.
 */
export async function resolveLanguage(acceptLanguage: string | undefined): Promise<string> {
  const stored = await readLanguage();
  if (stored) return stored;

  const guessed = pickLang(acceptLanguage);
  await writeLanguage(guessed).catch(() => {});
  return guessed;
}

export { DEFAULT_LANG };
