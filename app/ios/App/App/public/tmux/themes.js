// @ts-check
/**
 * The terminal colour themes, as data.
 *
 * Pure values and pure functions, no DOM: theme-sheet.js writes these into CSS
 * custom properties and terminal.js reads them back out to build an xterm
 * ITheme. Keeping the values here — in one place, importable by the test suite —
 * is what lets `themes.test.ts` assert contrast ratios on them. A palette
 * hard-coded across a stylesheet and a script cannot be checked by anything.
 *
 * Every colour is `#rrggbb`. The test rejects any other form, because the
 * contrast maths parses these six digits directly.
 */

/**
 * @typedef {object} Theme
 * @property {string} label            shown in the picker
 * @property {string} background
 * @property {string} foreground
 * @property {string} cursor
 * @property {string} cursorAccent     text drawn *under* a block cursor
 * @property {string} selectionBackground
 * @property {string} onAccent         text pressed onto an accent-coloured fill
 * @property {string[]} ansi           16 entries: black..white, then bright*
 */

/**
 * Why the `brightBlack` of every theme below departs from its upstream value.
 *
 * Claude Code draws its secondary information in bright black — the `⏵⏵ …`
 * status line, the `⎿` prefixes, timestamps. Every one of these four palettes
 * ships a bright black between 1.69:1 and 2.46:1 against its own background,
 * which is invisible on a phone outdoors. Each is replaced by a lighter step
 * from the *same* upstream palette (Tokyo Night's comment range, Catppuccin's
 * overlay1, …) so the hue is untouched and only the luminance moves.
 *
 * The threshold is WCAG AA, not AAA. Measured against their own backgrounds
 * One Dark's foreground is 6.6:1 and two of Nord's colours fall under 4.5:1 —
 * an AAA bar would disqualify two of the four established themes, which says
 * the bar is wrong rather than the themes.
 */

/** @type {Record<string, Theme>} */
export const THEMES = {
  "tokyo-night": {
    label: "Tokyo Night",
    background: "#1a1b26",
    foreground: "#c0caf5",
    cursor: "#c0caf5",
    cursorAccent: "#1a1b26",
    selectionBackground: "#33467c",
    onAccent: "#1a1b26",
    ansi: [
      "#15161e", "#f7768e", "#9ece6a", "#e0af68",
      "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6",
      // upstream #414868 → 1.91:1
      "#6272a4", "#f7768e", "#9ece6a", "#e0af68",
      "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5",
    ],
  },

  "catppuccin-mocha": {
    label: "Catppuccin Mocha",
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    cursor: "#f5e0dc",
    cursorAccent: "#1e1e2e",
    selectionBackground: "#414459",
    onAccent: "#1e1e2e",
    ansi: [
      "#45475a", "#f38ba8", "#a6e3a1", "#f9e2af",
      "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de",
      // upstream #585b70 → 2.46:1
      "#7f849c", "#f38ba8", "#a6e3a1", "#f9e2af",
      "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8",
    ],
  },

  "one-dark": {
    label: "One Dark",
    background: "#282c34",
    foreground: "#abb2bf",
    cursor: "#528bff",
    cursorAccent: "#282c34",
    selectionBackground: "#3e4451",
    onAccent: "#282c34",
    ansi: [
      "#3f4451", "#e06c75", "#98c379", "#e5c07b",
      "#61afef", "#c678dd", "#56b6c2", "#abb2bf",
      // upstream #5c6370 → 2.32:1
      "#7f8794", "#e06c75", "#98c379", "#e5c07b",
      "#61afef", "#c678dd", "#56b6c2", "#ffffff",
    ],
  },

  nord: {
    label: "Nord",
    background: "#2e3440",
    foreground: "#d8dee9",
    cursor: "#d8dee9",
    cursorAccent: "#2e3440",
    selectionBackground: "#434c5e",
    onAccent: "#2e3440",
    ansi: [
      "#3b4252", "#bf616a", "#a3be8c", "#ebcb8b",
      "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0",
      // upstream #4c566a → 1.69:1
      "#7b8aa4", "#bf616a", "#a3be8c", "#ebcb8b",
      "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4",
    ],
  },
};

export const DEFAULT_THEME = "tokyo-night";

/** ANSI slot order, doubling as the CSS variable suffix for each. */
export const ANSI_NAMES = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "bright-black", "bright-red", "bright-green", "bright-yellow",
  "bright-blue", "bright-magenta", "bright-cyan", "bright-white",
];

/** Picker order. Object key order would work, but relying on it is fragile. */
export const THEME_ORDER = ["tokyo-night", "catppuccin-mocha", "one-dark", "nord"];

/**
 * A theme by name, falling back to the default.
 *
 * Total on purpose: the name reaches here from disk and from localStorage, and
 * a stale or hand-edited value should degrade to the default rather than leave
 * the page unstyled.
 *
 * @param {string | null | undefined} name
 * @returns {Theme}
 */
export function themeOf(name) {
  return (name && THEMES[name]) || THEMES[DEFAULT_THEME];
}

/**
 * A theme flattened into the CSS custom properties the stylesheet consumes.
 *
 * The `--term-*` names are the contract between this module, style.css and
 * terminal.js. Anything reading a colour reads it from here.
 *
 * @param {string | null | undefined} name
 * @returns {Record<string, string>}
 */
export function themeVars(name) {
  const t = themeOf(name);
  /** @type {Record<string, string>} */
  const vars = {
    "--term-bg": t.background,
    "--term-fg": t.foreground,
    "--term-cursor": t.cursor,
    "--term-cursor-accent": t.cursorAccent,
    "--term-selection": t.selectionBackground,
    "--on-accent": t.onAccent,
  };
  ANSI_NAMES.forEach((slot, i) => {
    vars[`--term-${slot}`] = t.ansi[i];
  });
  return vars;
}

/**
 * The xterm.js ITheme for a theme.
 *
 * Built from the same data the CSS variables come from, so the terminal and the
 * page chrome cannot drift apart. All 23 fields xterm accepts are covered
 * except `extendedAnsi`, which only matters for the 256-colour cube — xterm
 * derives that from its own defaults and no palette here overrides it.
 *
 * @param {string | null | undefined} name
 * @returns {Record<string, string>}
 */
export function xtermTheme(name) {
  const t = themeOf(name);
  const [
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow,
    brightBlue, brightMagenta, brightCyan, brightWhite,
  ] = t.ansi;
  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    cursorAccent: t.cursorAccent,
    selectionBackground: t.selectionBackground,
    // Left to xterm: it renders an unfocused selection from the focused one,
    // and selectionForeground unset means the text keeps its own colour, which
    // is what makes a selection over coloured output still readable.
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow,
    brightBlue, brightMagenta, brightCyan, brightWhite,
  };
}
