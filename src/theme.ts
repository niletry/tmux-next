import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { THEMES, DEFAULT_THEME } from "../public/themes.js";

/**
 * Which colour themes this machine uses.
 *
 * On the machine rather than in a browser, for the same reason pins are: the
 * list and the terminals belong to this machine, so how they look is a property
 * of the machine — pick a theme on your phone and the desktop follows. Font
 * size stays in localStorage, because that one really is per-screen.
 *
 * Only the names are stored. The colours live in public/themes.js, which the
 * browser also imports, so there is exactly one copy of every value.
 *
 * 两个名字，因为终端画布和页面外壳是两拨颜色：`name` 喂 `themeVars`/`xtermTheme`
 * （终端的 23 个字段），`ui` 喂 `uiVars`（表面层、文字、强调色那套角色令牌）。
 * 这两组变量本来就是分开算的，现在只是各自拿各自的名字。
 */
export type ThemeChoice = { name: string; ui: string };

export function themePath(): string {
  return process.env.TMUX_NEXT_THEME_PATH || join(homedir(), ".tmux-next", "theme.json");
}

/** A name we ship; anything else is refused rather than stored and puzzled over later. */
export function isKnownTheme(name: unknown): name is string {
  return typeof name === "string" && Object.hasOwn(THEMES, name);
}

/**
 * The stored theme names, or the default.
 *
 * Total: a missing file (first run), unreadable JSON, or a name from a build
 * that shipped a theme we since removed all mean "use the default" — none of
 * them is worth failing a page load over.
 *
 * `ui` 缺失时回落到 `name`，**不是**回落到默认主题。这是「加了一个字段却不需要
 * 迁移」的全部理由：升级前写下的文件只有 `name`，读出来两者相同，于是老机器
 * 升级后长得跟升级前一模一样。
 */
export async function readTheme(): Promise<ThemeChoice> {
  const raw = await readRaw();
  const name = isKnownTheme(raw.name) ? raw.name : DEFAULT_THEME;
  return { name, ui: isKnownTheme(raw.ui) ? raw.ui : name };
}

/** 磁盘上那份，未经回落。只有 writeTheme 需要它——见那里的注释。 */
async function readRaw(): Promise<{ name?: unknown; ui?: unknown }> {
  try {
    return (await Bun.file(themePath()).json()) as { name?: unknown; ui?: unknown };
  } catch {
    return {};
  }
}

/**
 * Stores one or both theme names; returns false for anything we do not ship.
 *
 * 收补丁而不是收整份：设置页一次只点一款，发上来的就只有一个字段，合并到已存的
 * 那份上——覆盖的话，改界面外观会把终端调色板悄悄打回默认。
 *
 * 补丁里任何一个字段不认识，整份都不写：一半写进去一半没写，是那种事后没人能
 * 解释的状态。
 */
export async function writeTheme(patch: unknown): Promise<boolean> {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return false;
  const { name, ui } = patch as { name?: unknown; ui?: unknown };
  if (name === undefined && ui === undefined) return false;
  if (name !== undefined && !isKnownTheme(name)) return false;
  if (ui !== undefined && !isKnownTheme(ui)) return false;

  // 合并的是**磁盘上**那份，不是 readTheme() 回落之后的那份：回落之后 ui 一定
  // 有值，于是在一台从没选过的机器上只改终端调色板，会把 ui 固化成默认主题——
  // 「ui 跟着 name 走」当场失效。原始字段缺失就继续缺失，回落规则留在 readTheme
  // 一处，文件也只在两者真的不同时才多出一个字段。
  const raw = await readRaw();
  const keptUi = isKnownTheme(raw.ui) ? raw.ui : undefined;
  const nextUi = ui === undefined ? keptUi : ui;
  const next: { name: string; ui?: string } = {
    name: name === undefined ? (isKnownTheme(raw.name) ? raw.name : DEFAULT_THEME) : name,
    ...(nextUi === undefined ? {} : { ui: nextUi }),
  };
  const path = themePath();
  // The directory exists in any real install, but a fresh machine may hit this
  // before anything else has written to ~/.tmux-next.
  await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
  await Bun.write(path, JSON.stringify(next));
  return true;
}
