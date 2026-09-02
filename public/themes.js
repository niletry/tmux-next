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

// --- 页面 chrome 的角色色 ---------------------------------------------------

/**
 * 十六进制通道读写。这个模块里所有颜色都是 `#rrggbb`，别的形式在 themes.test.ts
 * 里就被拒了，所以这里不做容错。
 * @param {string} hex
 * @param {number} i
 * @returns {number}
 */
const chan = (hex, i) => parseInt(hex.slice(i, i + 2), 16);

/**
 * @param {number} n
 * @returns {string}
 */
const byte = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");

/**
 * 线性插值两个颜色，`p` 是 `a` 的占比。
 * @param {string} a
 * @param {string} b
 * @param {number} p
 * @returns {string}
 */
function mix(a, b, p) {
  return "#" + [1, 3, 5].map((i) => byte(chan(a, i) * p + chan(b, i) * (1 - p))).join("");
}

/**
 * WCAG 相对亮度。
 * @param {string} hex
 * @returns {number}
 */
function luminance(hex) {
  /** @param {number} i */
  const ch = (i) => {
    const c = chan(hex, i) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function contrast(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * 从 `from` 朝 `to` 走，取仍然满足对比度下限的那一步。
 *
 * 这个函数是整套角色色的关键。次要文字色以前取的是 ANSI 的 bright black——一个
 * 为终端挑的槽位，没有任何东西保证它在**卡片**上读得清，实测四套主题在 chip 上
 * 是 1.89–2.35:1。这里改成算：从前景色开始往背景色压暗，压到再压一步就掉到线
 * 以下为止。于是"够不够读得清"不再是碰巧，而是构造出来的。
 *
 * 一步都走不动（连 `from` 自己都不达标）时返回 `from`：那说明这套主题的这个颜色
 * 本身就不合格，应该由测试报出来，而不是在这里悄悄换成一个不属于该主题的颜色。
 *
 * @param {string} from  起点，通常是最高对比度的那一端
 * @param {string} to    终点，通常是它所在的表面
 * @param {string} on    实际用来量对比度的背景
 * @param {number} floor 对比度下限
 * @returns {string}
 */
function dimTo(from, to, on, floor) {
  let best = from;
  for (let step = 100; step >= 0; step -= 2) {
    const c = mix(from, to, step / 100);
    if (contrast(c, on) < floor) break;
    best = c;
  }
  return best;
}

/**
 * 从 `from` 提亮到达标为止，用来救那些太暗的语义色。
 * @param {string} from
 * @param {string} toward
 * @param {string} on
 * @param {number} floor
 * @returns {string}
 */
function liftTo(from, toward, on, floor) {
  for (let step = 100; step >= 0; step -= 2) {
    const c = mix(from, toward, step / 100);
    if (contrast(c, on) >= floor) return c;
  }
  return toward;
}

/** 正文级：WCAG AA。 */
const TEXT_FLOOR = 4.5;
/** 非正文的着色标记（状态点、单个字形、边框）：WCAG AA 的非文本档。 */
const MARK_FLOOR = 3.0;

/**
 * 页面 chrome 的角色色，按 Radix 12 级色阶的语义分层生成。
 *
 * 为什么是"生成"而不是"写死"：这四套主题各有身份，手写四套 chrome 配色就是四份
 * 会各自漂移的数据；而以前那种在 style.css 里 `color-mix()` 的做法，值要到浏览器
 * 里才算得出来，对比度测试根本够不着——CLAUDE.md 早就写着"颜色字面量会从对比度
 * 测试里隐身"，一个算出来的颜色同样会隐身，只是换了个形式。放在这里出真实
 * hex，测试才第一次能量到页面自己的表面。
 *
 * 分层对应 Radix：1-2 底色，3-5 组件表面（常态/悬停/按下），6-8 边框，
 * 9-10 实心填充及其悬停，11-12 文字。终端那 23 个字段一个不动——`themeVars` 和
 * `xtermTheme` 都不经过这里。
 *
 * 文字和语义色以 surface-4 为准绳：chip、卡片里的按钮、悬停态都坐在它上面，而它
 * 是常用表面里最亮的一层，也就是对浅色文字最不利的那一层。在它上面过线，在更暗
 * 的表面上只会更好。
 *
 * @param {string | null | undefined} name
 * @returns {Record<string, string>}
 */
export function uiVars(name) {
  const t = themeOf(name);
  const bg = t.background;
  const fg = t.foreground;

  const s1 = bg;
  const s2 = mix(bg, fg, 0.96);
  const s3 = mix(bg, fg, 0.91);
  const s4 = mix(bg, fg, 0.86);
  const s5 = mix(bg, fg, 0.81);

  // 强调色当文字用：先试主蓝，再试亮蓝，都不够就从亮蓝朝前景色提。三级而不是
  // 一步到位，是为了尽量停在调色板自己的颜色上——朝前景色提会把蓝拉灰，那是
  // 最后手段。
  const accentText =
    contrast(t.ansi[4], s4) >= TEXT_FLOOR
      ? t.ansi[4]
      : contrast(t.ansi[12], s4) >= TEXT_FLOOR
        ? t.ansi[12]
        : liftTo(t.ansi[12], fg, s4, TEXT_FLOOR);

  return {
    "--surface-1": s1,
    "--surface-2": s2,
    "--surface-3": s3,
    "--surface-4": s4,
    "--surface-5": s5,

    // 6-7：分隔线和可交互边框。不用半透明——半透明的实际颜色取决于它压在什么
    // 上面，于是同一条边在卡片上和在浮层上是两个颜色，谁也量不了。
    "--border-1": mix(fg, bg, 0.16),
    "--border-2": mix(fg, bg, 0.32),

    // 9-10：实心填充及其悬停。悬停用同主题的亮蓝，而不是随手调亮——留在调色板里。
    "--accent": t.ansi[4],
    "--accent-hover": t.ansi[12],
    // 强调色当**文字**用（链接、"进入"、主动作的字），这是正文级的要求，跟当填充
    // 是两回事。太暗就朝亮蓝提，提不动再朝前景色提。
    "--accent-text": accentText,
    // 第二个分类色。不是"某个插件要用紫色"——是"当一个界面需要第二种可区分的
    // 着色时用哪个"，跟 --accent-text 一样是正文级的要求。工单页拿它标史诗。
    "--accent-alt-text": liftTo(t.ansi[13], fg, s4, TEXT_FLOOR),
    "--on-accent": t.onAccent,

    // 11-12：文字。text-2 是次要文字（状态、时间、字段名），text-3 是更弱的那一档
    // （占位、禁用）。两者都算到刚好过线为止，见 dimTo。
    "--text-1": fg,
    "--text-2": dimTo(fg, s4, s4, TEXT_FLOOR),
    "--text-3": dimTo(fg, s4, s4, MARK_FLOOR),

    // 语义色。先取该主题自己的亮色槽（它已经被现有测试保过在背景上达标），在
    // surface-4 上不够就朝亮白提——只动亮度，不动色相。
    "--ok": liftTo(t.ansi[10], t.ansi[15], s4, MARK_FLOOR),
    "--warn": liftTo(t.ansi[11], t.ansi[15], s4, MARK_FLOOR),
    "--danger": liftTo(t.ansi[9], t.ansi[15], s4, MARK_FLOOR),
  };
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
