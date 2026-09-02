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
 * Why the `brightBlack` of most themes below departs from its upstream value.
 *
 * Claude Code draws its secondary information in bright black — the `⏵⏵ …`
 * status line, the `⎿` prefixes, timestamps. Six of these seven palettes ship a
 * bright black between 1.69:1 and 2.54:1 against their own background, which is
 * invisible on a phone outdoors. Each of those is replaced by a step from the
 * *same* upstream palette moved away from the background (Tokyo Night's comment
 * range, Catppuccin's overlay1, …) so the hue is untouched and only the
 * luminance moves — lighter on a dark theme, darker on a light one. Catppuccin
 * Latte is the exception: its upstream subtext0 already clears the floor at
 * 4.37:1.
 *
 * The threshold is WCAG AA, not AAA. Measured against their own backgrounds
 * One Dark's foreground is 6.6:1 and two of Nord's colours fall under 4.5:1 —
 * an AAA bar would disqualify two of the four themes this project started with,
 * which says the bar is wrong rather than the themes.
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

  // --- 浅色 ---------------------------------------------------------------
  //
  // 三套都是上游真实存在、作者专为浅底挑过的调色板。Nord 没有官方浅色版：把
  // Aurora/Frost 搬到雪白底上是 green 1.77:1、cyan 1.74:1、yellow 1.35:1，
  // 得重挑一半色相，出来的东西不是 Nord，而且无上游可引用——以后没人能判断
  // 某个值为什么是那样。所以浅色只有三套，选择器左右不对称，但不造没有的东西。

  "catppuccin-latte": {
    label: "Catppuccin Latte",
    background: "#eff1f5",
    foreground: "#4c4f69",
    // upstream rosewater #dc8a78 → 2.34:1
    cursor: "#bd7767",
    cursorAccent: "#eff1f5",
    selectionBackground: "#bcc0cc",
    onAccent: "#ffffff",
    ansi: [
      // upstream green #40a02b → 2.96:1、yellow #df8e1d → 2.31:1、
      // pink #ea76cb → 2.34:1。都是朝纯黑压——三个通道同乘一个常数，
      // 色相与 HSV 饱和度严格不变，只动亮度。
      "#5c5f77", "#d20f39", "#3f9d2a", "#c07a19",
      "#1e66f5", "#c965af", "#179299", "#acb0be",
      "#6c6f85", "#d20f39", "#3f9d2a", "#c07a19",
      "#1e66f5", "#c965af", "#179299", "#bcc0cc",
    ],
  },

  "tokyo-night-day": {
    label: "Tokyo Night Day",
    // upstream fg #3760bf → 在自己底色上 4.52:1，刚好压线，而页面的表面是朝
    // 前景色抬的，抬到 surface-5 时 --text-1 掉到 3.54:1，--text-2 连一步都
    // 走不动。这暴露了「抬升表面」一个没写下来的隐含要求：前景对底色要有余量。
    // 四套深色主题的前景是近白色（8–11:1），大到从没暴露过。朝纯黑压 18%,
    // fg/bg 升到 5.98:1，五层表面上 4.53–5.98 全部过线。
    background: "#e1e2e7",
    foreground: "#2d4f9d",
    cursor: "#2d4f9d",
    cursorAccent: "#e1e2e7",
    // upstream #99a7df → 前景对比 2.49:1
    selectionBackground: "#b9c4ec",
    onAccent: "#ffffff",
    ansi: [
      "#b4b5b9", "#f52a65", "#587539", "#8c6c3e",
      "#2e7de9", "#9854f1", "#007197", "#6172b0",
      // upstream #848cb5 → 2.54:1
      "#777ea3", "#f52a65", "#587539", "#8c6c3e",
      "#2e7de9", "#9854f1", "#007197", "#2d4f9d",
    ],
  },

  "one-light": {
    label: "One Light",
    background: "#fafafa",
    foreground: "#383a42",
    cursor: "#526fff",
    cursorAccent: "#fafafa",
    selectionBackground: "#d4d7d6",
    onAccent: "#ffffff",
    ansi: [
      "#4f525e", "#e45649", "#50a14f", "#c18401",
      "#4078f2", "#a626a4", "#0184bc", "#a0a1a7",
      // upstream #a0a1a7 → 2.47:1
      "#909196", "#e45649", "#50a14f", "#c18401",
      "#4078f2", "#a626a4", "#0184bc", "#4f525e",
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

/**
 * 选择器的顺序与分组。
 *
 * 深色四套、浅色三套——不对称是因为 Nord 没有官方浅色版（见 THEMES 里的注释）。
 * labelKey 是 i18n 的键而不是显示文本，跟插件清单里的 titleKey 是同一个做法。
 */
export const THEME_GROUPS = [
  { labelKey: "settings.themeDark", names: ["tokyo-night", "catppuccin-mocha", "one-dark", "nord"] },
  { labelKey: "settings.themeLight", names: ["tokyo-night-day", "catppuccin-latte", "one-light"] },
];

/**
 * 扁平的顺序，从分组推导。
 *
 * 保留这个导出而不是让调用方自己 flatMap：形状不变，themes.test.ts 和任何
 * 「遍历所有主题」的代码都不用动，分组只是多了一层结构。
 */
export const THEME_ORDER = THEME_GROUPS.flatMap((g) => g.names);

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
 * 从 `from` 朝 `toward` 推，取第一个达标的那一步。
 *
 * 原名 `liftTo`——「提亮」，因为端点写死是主题的亮白色，只服务深色主题。浅色
 * 主题的表面本来就接近白，朝白提只会更糟，循环走完会返回纯白端点，于是
 * `--ok`/`--warn`/`--danger` 在浅色下直接消失。方向本来就该由极性决定，
 * 名字里不该有方向。
 *
 * @param {string} from   起点
 * @param {string} toward 端点，由 `farEnd()` 按极性给出
 * @param {string} on     实际用来量对比度的背景
 * @param {number} floor  对比度下限
 * @returns {string}
 */
function pushTo(from, toward, on, floor) {
  for (let step = 100; step >= 0; step -= 2) {
    const c = mix(from, toward, step / 100);
    if (contrast(c, on) >= floor) return c;
  }
  return toward;
}

/**
 * 一套主题是深是浅。
 *
 * 算出来而不是让主题自己声明：一套主题的极性完全由它的 background 和
 * foreground 决定，再写一个 `dark: true` 字段只是制造两者打架的机会。
 *
 * @param {Theme} t
 * @returns {boolean}
 */
export function isLight(t) {
  return luminance(t.background) > luminance(t.foreground);
}

/**
 * 远离表面的那一端。所有「推到过线为止」的构造都朝它走。
 *
 * 纯黑/纯白而不是主题自己的 ansi[15]：Catppuccin Mocha 的亮白 #a6adc8 和它的
 * 蓝 #89b4fa 亮度太近，朝它推最多只能推出 1.057 的差，肉眼等于没变（见
 * Task 2 的 --accent-hover）。
 *
 * @param {Theme} t
 * @returns {string}
 */
const farEnd = (t) => (isLight(t) ? "#000000" : "#ffffff");

/** 正文级：WCAG AA。 */
const TEXT_FLOOR = 4.5;
/** 非正文的着色标记（状态点、单个字形、边框）：WCAG AA 的非文本档。 */
const MARK_FLOOR = 3.0;
/** 两块填充之间刚好可辨的一档。不是 WCAG 档位——WCAG 管字和背景，不管状态差异。 */
const HOVER_MIN = 1.15;

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

  const far = farEnd(t);

  // --accent 是填充，onAccent 压在它上面，所以这是正文级要求。上游调色板的蓝
  // 未必够：Tokyo Night Day 的 #2e7de9 白字压上去 4.02:1、深字约 4.2:1，
  // **两个方向都过不了**——不是 onAccent 选错了，是这个色当填充时本身不够。
  // 压的是角色令牌，终端的 ansi[4] 一个字节不动，这正是两组变量分开的意义。
  // 四套深色主题实测 4.64–7.79:1，循环第一步就过，值不变。
  const accent = pushTo(t.ansi[4], far, t.onAccent, TEXT_FLOOR);

  // 强调色当文字用：先试主蓝，都不够就从主蓝朝前景色推。中间那一级（试亮蓝）
  // 删掉了：七套主题的 ansi[12] **全部**等于 ansi[4]
  // （#7aa2f7 / #89b4fa / #61afef / #81a1c1，三套浅色也一样），所以第二个条件
  // 跟第一个是同一个判断，永远不可能在第一个失败之后成功——它在任何已发布的
  // 主题里都是死代码。删它不改变任何一套主题的结果。
  const accentText =
    contrast(t.ansi[4], s4) >= TEXT_FLOOR ? t.ansi[4] : pushTo(t.ansi[4], fg, s4, TEXT_FLOOR);

  return {
    "--surface-1": s1,
    "--surface-2": s2,
    "--surface-3": s3,
    "--surface-4": s4,
    "--surface-5": s5,

    // 6-7：分隔线和可交互边框。不用半透明——半透明的实际颜色取决于它压在什么
    // 上面，于是同一条边在卡片上和在浮层上是两个颜色，谁也量不了。
    // 固定配比在深色下够、浅色下不够：Latte 的 --border-2 实测 1.339，低于
    // 「边框不能是隐形的」那条 1.4 的线。改成从原配比出发推到过线为止——
    // 深色四套第一步就过，pushTo 原样返回起点，边框色逐字节不变。
    "--border-1": pushTo(mix(fg, bg, 0.16), fg, s3, 1.12),
    "--border-2": pushTo(mix(fg, bg, 0.32), fg, s4, 1.45),

    // 9-10：实心填充及其悬停。悬停：从常态填充朝远离表面的一端推，推到跟常态色差
    // 得出来为止。以前取 ansi[12]（亮蓝），而七套主题的 ansi[12] 全部等于 ansi[4]
    // ——悬停色一直等于常态色，等于没有悬停反馈。这不是浅色带来的问题，是浅色让它
    // 显眼了。「远离表面」对填充和压在它上面的字是同向的，所以 onAccent 在悬停填充
    // 上只会比在常态填充上更好（实测 5.34–9.03:1），不需要再夹一次。
    "--accent": accent,
    "--accent-hover": pushTo(accent, far, accent, HOVER_MIN),
    // 强调色当**文字**用（链接、"进入"、主动作的字），这是正文级的要求，跟当填充
    // 是两回事。太暗就朝前景色推。
    "--accent-text": accentText,
    // 第二个分类色。不是"某个插件要用紫色"——是"当一个界面需要第二种可区分的
    // 着色时用哪个"，跟 --accent-text 一样是正文级的要求。工单页拿它标史诗。
    "--accent-alt-text": pushTo(t.ansi[13], fg, s4, TEXT_FLOOR),
    "--on-accent": t.onAccent,

    // 11-12：文字。text-2 是次要文字（状态、时间、字段名），text-3 是更弱的那一档
    // （占位、禁用）。两者都算到刚好过线为止，见 dimTo。
    "--text-1": fg,
    "--text-2": dimTo(fg, s4, s4, TEXT_FLOOR),
    "--text-3": dimTo(fg, s4, s4, MARK_FLOOR),

    // 语义色。先取该主题自己的亮色槽（它已经被现有测试保过在背景上达标），在
    // surface-4 上不够就推——端点按极性走：深色朝纯白，浅色朝纯黑。写死 ansi[15]
    // 的话，浅色主题的表面本来就接近白，朝白推走完循环会返回端点本身——Latte
    // 实测 --ok 和 --warn 双双变成 #bcc0cc，对 surface-4 只有 1.30:1，等于消失。
    "--ok": pushTo(t.ansi[10], far, s4, MARK_FLOOR),
    "--warn": pushTo(t.ansi[11], far, s4, MARK_FLOOR),
    "--danger": pushTo(t.ansi[9], far, s4, MARK_FLOOR),
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
