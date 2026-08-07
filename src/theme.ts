import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { THEMES, DEFAULT_THEME } from "../public/themes.js";

/**
 * Which colour theme this machine's terminals use.
 *
 * On the machine rather than in a browser, for the same reason pins are: the
 * list and the terminals belong to this machine, so how they look is a property
 * of the machine — pick a theme on your phone and the desktop follows. Font
 * size stays in localStorage, because that one really is per-screen.
 *
 * Only the name is stored. The colours live in public/themes.js, which the
 * browser also imports, so there is exactly one copy of every value.
 */
export function themePath(): string {
  return process.env.TMUX_NEXT_THEME_PATH || join(homedir(), ".tmux-next", "theme.json");
}

/** A name we ship; anything else is refused rather than stored and puzzled over later. */
export function isKnownTheme(name: unknown): name is string {
  return typeof name === "string" && Object.hasOwn(THEMES, name);
}

/**
 * The stored theme name, or the default.
 *
 * Total: a missing file (first run), unreadable JSON, or a name from a build
 * that shipped a theme we since removed all mean "use the default" — none of
 * them is worth failing a page load over.
 */
export async function readTheme(): Promise<string> {
  try {
    const data = (await Bun.file(themePath()).json()) as { name?: unknown };
    return isKnownTheme(data?.name) ? data.name : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Stores a theme name; returns false for one we do not ship. */
export async function writeTheme(name: unknown): Promise<boolean> {
  if (!isKnownTheme(name)) return false;
  const path = themePath();
  // The directory exists in any real install, but a fresh machine may hit this
  // before anything else has written to ~/.tmux-next.
  await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
  await Bun.write(path, JSON.stringify({ name }));
  return true;
}
