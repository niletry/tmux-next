import { test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
// A browser module, but a `// @ts-check`ed one — its JSDoc types are real.
import {
  THEMES,
  THEME_ORDER,
  DEFAULT_THEME,
  ANSI_NAMES,
  themeOf,
  themeVars,
  uiVars,
  xtermTheme,
  isLight,
} from "../public/themes.js";

/**
 * Relative luminance, WCAG 2.x.
 *
 * Reimplemented here rather than imported from the module under test: a bug in
 * a shared helper would cancel itself out and every ratio would pass.
 */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const names = Object.keys(THEMES);
const HEX = /^#[0-9a-f]{6}$/;

test("the picker order covers exactly the defined themes", () => {
  expect([...THEME_ORDER].sort()).toEqual([...names].sort());
});

test("the default theme exists", () => {
  expect(names).toContain(DEFAULT_THEME);
});

test.each(names)("%s defines every colour as #rrggbb", (name) => {
  const t = THEMES[name]!;
  expect(t.ansi).toHaveLength(16);
  const all = [
    t.background, t.foreground, t.cursor, t.cursorAccent,
    t.selectionBackground, t.onAccent, ...t.ansi,
  ];
  for (const c of all) expect(c).toMatch(HEX);
  expect(t.label.length).toBeGreaterThan(0);
});

/**
 * The contrast floors, and why they sit where they do.
 *
 * WCAG AA, not AAA. Measured against their own backgrounds One Dark's
 * foreground is 6.6:1 and two of Nord's colours land under 4.5:1 — an AAA bar
 * would fail two of the four established palettes, which means the bar is
 * wrong, not the palettes. AA still catches what actually hurts: every one of
 * these themes ships an upstream bright black between 1.69:1 and 2.46:1, and
 * that is the colour Claude Code draws its secondary text in.
 */
const FG_MIN = 4.5;      // body text
const COLOUR_MIN = 3.0;  // short coloured marks: ✓ ✗ filenames, single glyphs
const DIM_MIN = 3.0;     // bright black — secondary text, the whole point

test.each(names)("%s: foreground is readable on its background", (name) => {
  const t = THEMES[name]!;
  expect(contrast(t.foreground, t.background)).toBeGreaterThanOrEqual(FG_MIN);
});

test.each(names)("%s: bright black is readable as secondary text", (name) => {
  const t = THEMES[name]!;
  expect(contrast(t.ansi[8]!, t.background)).toBeGreaterThanOrEqual(DIM_MIN);
});

/**
 * Black gets an identity check, not a contrast floor.
 *
 * In a dark palette colour 0 *is* the darkest ink — programs use it for fills,
 * shadows and rules, not for text, and all four upstream palettes put it at or
 * below their own background (Tokyo Night's is 1.05:1). Demanding contrast here
 * would mean rejecting the convention rather than enforcing readability.
 *
 * What is worth rejecting is black being byte-identical to the background, as
 * One Dark ships it: then a rule drawn in colour 0 is not dim, it is absent.
 */
test.each(names)("%s: black is not literally the background", (name) => {
  const t = THEMES[name]!;
  expect(t.ansi[0]).not.toBe(t.background);
});

test.each(names)("%s: every chromatic colour clears the floor", (name) => {
  const t = THEMES[name]!;
  // Slots 1-6 and 9-14: the six hues in both normal and bright form. Black,
  // white and their bright forms are covered by the tests above or are plain
  // foreground-grade greys.
  const chromatic = [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14];
  // Collected rather than asserted one by one: a failure then names every slot
  // that fell short and by how much, instead of stopping at the first.
  const short = chromatic
    .map((i) => ({ slot: ANSI_NAMES[i]!, ratio: contrast(t.ansi[i]!, t.background) }))
    .filter((r) => r.ratio < COLOUR_MIN)
    .map((r) => `${r.slot} ${r.ratio.toFixed(2)}:1`);
  expect(short).toEqual([]);
});

test.each(names)("%s: the cursor is visible and its accent readable under it", (name) => {
  const t = THEMES[name]!;
  expect(contrast(t.cursor, t.background)).toBeGreaterThanOrEqual(COLOUR_MIN);
  // A block cursor inverts: cursorAccent is the glyph drawn on top of it. One
  // glyph under a cursor is a non-text mark, not body copy, so it takes the
  // 3:1 floor — One Dark's upstream #528bff cursor lands at 4.33:1 and holding
  // it to 4.5 would mean recolouring the theme to satisfy the wrong rule.
  expect(contrast(t.cursorAccent, t.cursor)).toBeGreaterThanOrEqual(COLOUR_MIN);
});

test.each(names)("%s: selected text stays legible", (name) => {
  const t = THEMES[name]!;
  // selectionForeground is deliberately unset, so the text keeps its own
  // colour over the selection fill. Foreground-on-selection is the case that
  // has to hold for ordinary output.
  expect(contrast(t.foreground, t.selectionBackground)).toBeGreaterThanOrEqual(COLOUR_MIN);
});

test("themeOf falls back rather than returning undefined", () => {
  expect(themeOf("no-such-theme")).toBe(THEMES[DEFAULT_THEME]!);
  expect(themeOf(null)).toBe(THEMES[DEFAULT_THEME]!);
  expect(themeOf(undefined)).toBe(THEMES[DEFAULT_THEME]!);
  expect(themeOf("nord")).toBe(THEMES.nord!);
});

test("isLight 读的是调色板，不是名字", () => {
  // 用合成对象而不是真主题：这条断言要说的是「极性由两个色决定」，
  // 用真主题的话，等于在断言那套主题的取值，而不是这个函数的行为。
  const light = { background: "#ffffff", foreground: "#000000" } as never;
  const dark = { background: "#000000", foreground: "#ffffff" } as never;
  expect(isLight(light)).toBe(true);
  expect(isLight(dark)).toBe(false);
});

test.each(names)("%s: 深色主题判为深色，浅色主题判为浅色", (name) => {
  const t = THEMES[name]!;
  const shouldBeLight = ["catppuccin-latte", "tokyo-night-day", "one-light"].includes(name);
  expect(isLight(t)).toBe(shouldBeLight);
});

test.each(names)("%s: themeVars emits one variable per colour", (name) => {
  const vars = themeVars(name);
  for (const slot of ANSI_NAMES) expect(vars[`--term-${slot}`]).toMatch(HEX);
  for (const key of ["--term-bg", "--term-fg", "--term-cursor", "--term-cursor-accent",
                     "--term-selection", "--on-accent"]) {
    expect(vars[key]).toMatch(HEX);
  }
  expect(Object.keys(vars)).toHaveLength(ANSI_NAMES.length + 6);
});

/**
 * Guards the field list against xterm's ITheme, which has 23 properties. We set
 * 21: extendedAnsi and selectionForeground are left to xterm on purpose (see
 * xtermTheme). A missing field here means a colour silently falls back to
 * xterm's Tango default — exactly the bug this whole change exists to fix.
 */
test.each(names)("%s: xtermTheme covers every field we intend to set", (name) => {
  const theme = xtermTheme(name);
  const expected = [
    "background", "foreground", "cursor", "cursorAccent", "selectionBackground",
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "brightBlack", "brightRed", "brightGreen", "brightYellow",
    "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
  ];
  expect(Object.keys(theme).sort()).toEqual([...expected].sort());
  for (const v of Object.values(theme)) expect(v).toMatch(HEX);
});

// --- 页面 chrome 的角色色 ---------------------------------------------------

/**
 * 这一节是这套角色色存在的理由。
 *
 * 在它之前，本文件每一条对比度断言的基准都是**终端背景**，而页面自己的表面
 * （卡片、chip、卡片里的按钮）是 style.css 里的 `color-mix()`，值要到浏览器里
 * 才算得出来——测试够不着。实测的后果：次要文字坐在 chip 上时四套主题分别是
 * 2.77 / 3.30 / 3.05 / 2.63 在卡片上，1.98 / 2.32 / 2.35 / 1.89 在 chip 上。
 * 而那个颜色是状态、时间、字段名、以及卡片底部整排按钮的文字色。
 *
 * 现在这些值由 uiVars 从每套主题自己的颜色算出来、出真实 hex，下面逐个量。
 *
 * 基准取 --surface-4：chip、卡片里的按钮、悬停态都坐在它上面，而它是常用表面里
 * 最亮的一层，也就是对浅色文字最不利的那一层。在它上面过线，在更暗的表面上只会
 * 更好——「表面越高文字越难读」那条也在下面断言了，免得哪天层级被排反。
 */
const ui = (name: string) => uiVars(name) as Record<string, string>;

test.each(THEME_ORDER)("%s: 表面层级单调远离底色", (name) => {
  const v = ui(name);
  const light = isLight(THEMES[name]!);
  const steps = [1, 2, 3, 4, 5].map((i) => luminance(v[`--surface-${i}`]!));
  // 「抬高」在深色主题里是变亮，在浅色主题里是变暗——同一件事的两个极性。
  // 排反的话，所有以 surface-4 为基准算出来的文字色都会在别的表面上不达标，
  // 而每一条断言仍然是绿的：基准本身选错了。
  // 一次报全部而不是停在第一处：层级排错时想看的是整条阶梯长什么样。
  const wrong = steps
    .map((lum, i) => ({ step: i + 1, lum }))
    .filter((s, i) => i > 0 && (light ? s.lum >= steps[i - 1]! : s.lum <= steps[i - 1]!))
    .map((s) => `surface-${s.step}`);
  expect(wrong).toEqual([]);
});

test.each(THEME_ORDER)("%s: 次要文字在最亮的常用表面上仍是正文级", (name) => {
  const v = ui(name);
  expect(contrast(v["--text-2"]!, v["--surface-4"]!)).toBeGreaterThanOrEqual(FG_MIN);
});

test.each(THEME_ORDER)("%s: 三级文字至少够得上非文本标记", (name) => {
  const v = ui(name);
  expect(contrast(v["--text-3"]!, v["--surface-4"]!)).toBeGreaterThanOrEqual(COLOUR_MIN);
});

test.each(THEME_ORDER)("%s: 主要文字在每一层表面上都是正文级", (name) => {
  const v = ui(name);
  const short = [1, 2, 3, 4, 5]
    .map((i) => ({ surface: i, ratio: contrast(v["--text-1"]!, v[`--surface-${i}`]!) }))
    .filter((r) => r.ratio < FG_MIN)
    .map((r) => `surface-${r.surface} ${r.ratio.toFixed(2)}:1`);
  expect(short).toEqual([]);
});

// 强调色有两个身份，要求不一样：当填充时人看的是压在上面的字，当文字时人看的是
// 它自己。以前只有一个 --accent 同时干这两件事，于是「文字够不够读得清」从来没
// 被问过——链接、"进入"、主动作的字用的都是它。
test.each(THEME_ORDER)("%s: 强调色当文字用时是正文级", (name) => {
  const v = ui(name);
  expect(contrast(v["--accent-text"]!, v["--surface-4"]!)).toBeGreaterThanOrEqual(FG_MIN);
  expect(contrast(v["--accent-alt-text"]!, v["--surface-4"]!)).toBeGreaterThanOrEqual(FG_MIN);
});

test.each(THEME_ORDER)("%s: 强调色当填充时压在上面的字读得清", (name) => {
  const v = ui(name);
  expect(contrast(v["--on-accent"]!, v["--accent"]!)).toBeGreaterThanOrEqual(FG_MIN);
});

// 悬停填充必须看得出跟常态不一样。1.15 是两块填充之间刚好可辨的一档——这不是
// WCAG 的档位，WCAG 管的是文字和它的背景，不管两个状态之间的差别。
const HOVER_MIN = 1.15;

test.each(THEME_ORDER)("%s: 悬停填充跟常态填充分得出来", (name) => {
  const v = ui(name);
  expect(contrast(v["--accent"]!, v["--accent-hover"]!)).toBeGreaterThanOrEqual(HOVER_MIN);
});

test.each(THEME_ORDER)("%s: 悬停填充上的字也读得清", (name) => {
  const v = ui(name);
  expect(contrast(v["--on-accent"]!, v["--accent-hover"]!)).toBeGreaterThanOrEqual(FG_MIN);
});

// 语义色是短标记（状态点、✓ ✗、一个词的状态），所以是 3:1 那一档而不是 4.5。
// Nord 的红在这套推算之前是 2.24:1 —— 而那是"结束会话"用的颜色。
test.each(THEME_ORDER)("%s: 语义色在表面上分得出来", (name) => {
  const v = ui(name);
  const short = ["--ok", "--warn", "--danger"]
    .map((k) => ({ token: k, ratio: contrast(v[k]!, v["--surface-4"]!) }))
    .filter((r) => r.ratio < COLOUR_MIN)
    .map((r) => `${r.token} ${r.ratio.toFixed(2)}:1`);
  expect(short).toEqual([]);
});

// 边框不承担阅读，但必须看得见——一条跟自己所在表面同色的边不是"淡"，是"没有"。
// 这跟本文件上面那条「黑色不能等于背景」是同一类断言。
test.each(THEME_ORDER)("%s: 边框在它所在的表面上不是隐形的", (name) => {
  const v = ui(name);
  expect(contrast(v["--border-1"]!, v["--surface-3"]!)).toBeGreaterThan(1.1);
  expect(contrast(v["--border-2"]!, v["--surface-4"]!)).toBeGreaterThan(1.4);
});

test.each(THEME_ORDER)("%s: uiVars 的每个值都是 #rrggbb", (name) => {
  for (const [key, value] of Object.entries(ui(name))) {
    expect({ key, value }).toEqual({ key, value: expect.stringMatching(HEX) as unknown as string });
  }
});

// 触底的现场特征。pushTo 走完循环还没达标时会返回端点本身，而端点现在是纯黑
// 或纯白——一个算出来的令牌等于纯黑/纯白，就说明这套主题的这个颜色在这个极性
// 下根本推不出答案。--on-accent 要排除：它是从调色板直接抄的，三套浅色主题的
// 它正当地就是 #ffffff。
//
// 这条是防将来回归的哨兵，不是发现当下缺陷的工具：极性修好之前，语义色触底
// 返回的是 ansi[15]（Latte 的 #bcc0cc），这条根本抓不到——抓到它的是既有的
// 语义色对比度断言。
test.each(THEME_ORDER)("%s: 没有算出来的令牌触底成纯黑或纯白", (name) => {
  const bottomed = Object.entries(ui(name))
    .filter(([key]) => key !== "--on-accent")
    .filter(([, c]) => c === "#000000" || c === "#ffffff")
    .map(([key]) => key);
  expect(bottomed).toEqual([]);
});

// 选区必须跟底色分得开。前景在选区上读得清（上面已有断言）还不够——一块跟底色
// 同色的选区不是"淡"，是"选不出东西来"。Tokyo Night Day 的上游选区 #99a7df
// 前景对比只有 2.49:1，而只朝白提会一路退化到纯白：前景对比过线了，选区却跟
// #e1e2e7 的底色差 1.07。两条得同时满足。
test.each(THEME_ORDER)("%s: 选区跟底色分得出来", (name) => {
  const t = THEMES[name]!;
  expect(contrast(t.selectionBackground, t.background)).toBeGreaterThanOrEqual(1.15);
});

// 终端那一组不该被这次改动碰到：uiVars 和 themeVars 是两份互不重叠的输出，
// 混进去的话，改一个页面颜色就会顺手改掉 xterm 的调色板。
test.each(THEME_ORDER)("%s: 角色色和终端调色板互不重叠", (name) => {
  const shared = Object.keys(ui(name)).filter((k) => k in themeVars(name));
  expect(shared).toEqual(["--on-accent"]);
});

/**
 * 深色主题的角色令牌逐键钉住，防止 uiVars 的推导方式变了却没人发现。
 *
 * 上面那些断言只查对比度是否过线，不查具体色值——推导方式一换，只要新算出来
 * 的颜色仍然过线，所有断言照样全绿。Task 3 就踩过这个坑：把 `uiVars()` 里
 * 「朝端点推到过线为止」的构造从按主题深浅各写一遍改成按极性统一取端点，
 * Nord 的 `--danger` 从 `#cb868e` 悄悄变成了 `#ce878e`，靠的是人工复算才发现，
 * 不是测试报的。这条断言就是补那个缺口。
 *
 * 这次漂移本身是裁定过的、可接受的例外，原样记在这里而不是回避：
 * Nord 的 `ansi[9]`（#bf616a）对 `--surface-4` 只有 2.108:1，不到 MARK_FLOOR
 * （3.0）——是四套深色主题 × 三个语义色槽位一共 12 个里，唯一第一步就不过线、
 * 必须真的朝端点插值的那个。端点从旧的 `ansi[15]` 换成统一的 `far`（纯白）之后，
 * 落点从 #cb868e 变成 #ce878e：对比度从 3.0142 提到 3.0720，变好，肉眼不可辨。
 * 其余 11 个第一步就过线，pushTo 直接返回起点，所以字节不变——「逐字节不变」
 * 是这 11 个的巧合，不是这个函数的性质，Nord 的 --danger 才是真正测到分支的那个。
 * 这条断言钉的就是裁定之后的新值：#ce878e。
 *
 * 这条清单变红时，第一反应不是把数字改回来配合断言——先问「这次改动本来就该
 * 改这个颜色吗」。如果答案是"改了实现，颜色确实该变"，才更新这里的期望值，
 * 并把理由记下来，就像这段注释记录 Nord 的例外一样。
 *
 * 只钉四套深色主题（tokyo-night / catppuccin-mocha / one-dark / nord）。浅色
 * 主题还在开发中——Task 4 还要再加两套——现在钉死只会让浅色主题的每次调整都
 * 变成一次无意义的返工，等浅色主题定稿了再补。
 */
test("深色主题的角色令牌逐键钉住", () => {
  const darkThemes = ["tokyo-night", "catppuccin-mocha", "one-dark", "nord"];
  const actual = Object.fromEntries(darkThemes.map((name) => [name, uiVars(name)]));
  expect(actual).toEqual({
    "tokyo-night": {
      "--surface-1": "#1a1b26",
      "--surface-2": "#21222e",
      "--surface-3": "#292b39",
      "--surface-4": "#313443",
      "--surface-5": "#3a3c4d",
      "--border-1": "#353747",
      "--border-2": "#4f5368",
      "--accent": "#7aa2f7",
      "--accent-hover": "#8daff8",
      "--accent-text": "#7aa2f7",
      "--accent-alt-text": "#bb9af7",
      "--on-accent": "#1a1b26",
      "--text-1": "#c0caf5",
      "--text-2": "#959dc0",
      "--text-3": "#797f9c",
      "--ok": "#9ece6a",
      "--warn": "#e0af68",
      "--danger": "#f7768e",
    },
    "catppuccin-mocha": {
      "--surface-1": "#1e1e2e",
      "--surface-2": "#252536",
      "--surface-3": "#2e2f40",
      "--surface-4": "#37384a",
      "--surface-5": "#3f4154",
      "--border-1": "#3a3b4e",
      "--border-2": "#56596d",
      "--accent": "#89b4fa",
      "--accent-hover": "#9ec2fb",
      "--accent-text": "#89b4fa",
      "--accent-alt-text": "#f5c2e7",
      "--on-accent": "#1e1e2e",
      "--text-1": "#cdd6f4",
      "--text-2": "#9da3be",
      "--text-3": "#7f849c",
      "--ok": "#a6e3a1",
      "--warn": "#f9e2af",
      "--danger": "#f38ba8",
    },
    "one-dark": {
      "--surface-1": "#282c34",
      "--surface-2": "#2d313a",
      "--surface-3": "#343841",
      "--surface-4": "#3a3f47",
      "--surface-5": "#41454e",
      "--border-1": "#3d414a",
      "--border-2": "#525760",
      "--accent": "#61afef",
      "--accent-hover": "#7abcf2",
      "--accent-text": "#6aafe9",
      "--accent-alt-text": "#b2a3c7",
      "--on-accent": "#282c34",
      "--text-1": "#abb2bf",
      "--text-2": "#a4abb8",
      "--text-3": "#828994",
      "--ok": "#98c379",
      "--warn": "#e5c07b",
      "--danger": "#e06c75",
    },
    "nord": {
      "--surface-1": "#2e3440",
      "--surface-2": "#353b47",
      "--surface-3": "#3d434f",
      "--surface-4": "#464c58",
      "--surface-5": "#4e5460",
      "--border-1": "#494f5b",
      "--border-2": "#646a76",
      "--accent": "#81a1c1",
      "--accent-hover": "#93aeca",
      "--accent-text": "#abbed4",
      "--accent-alt-text": "#c7b8cc",
      "--on-accent": "#2e3440",
      "--text-1": "#d8dee9",
      "--text-2": "#b8bec9",
      "--text-3": "#959ba6",
      "--ok": "#a3be8c",
      "--warn": "#ebcb8b",
      "--danger": "#ce878e", // 裁定接受的漂移：旧值 #cb868e，见上方注释。
    },
  });
});

// --- 颜色字面量 -------------------------------------------------------------

/**
 * 样式表里不许出现颜色字面量。
 *
 * CLAUDE.md 一直写着这条，但在此之前没有任何东西在拦它——规矩只存在于散文里，
 * 于是 style.css 里攒下了几处。字面量的危害很具体：上面那些对比度断言只看得见
 * themes.js 里的值，一个写死的颜色对它们是隐形的，四套主题里坏掉三套也不会红。
 *
 * 插件的样式表一并扫：样式搬进插件目录之后，只扫内核那份等于给插件开了后门。
 */
const styleSheets = (() => {
  const out = [new URL("../public/style.css", import.meta.url).pathname];
  const plugins = new URL("../plugins/", import.meta.url).pathname;
  for (const entry of readdirSync(plugins, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = `${plugins}${entry.name}/public/style.css`;
    if (existsSync(path)) out.push(path);
  }
  return out;
})();

/**
 * 还没能主题化的那几个值。
 *
 * 这张单子从 22 条缩到 4 条：其余的在角色色（--surface-* / --text-* / --border-* /
 * 语义色）落地时全部换掉了，因为它们本来就是在手搓表面层级和状态色——只是搓的
 * 结果没人量得到。剩下的这几条是真的不该主题化：
 *
 * - #fff 是画廊全屏查看器里 iframe 的底色。里面渲染的是用户自己的 HTML 制品，
 *   那份文档假定自己躺在白纸上，跟本站的主题无关。
 * - 三个纯黑半透明是遮罩和投影。遮罩按定义就是黑的——它的作用是把身后的东西压
 *   暗，换成主题色只会让它在浅色主题下压不住。
 *
 * 单子只会变短，不该变长：往这里加一行之前，先想清楚为什么那个值不能来自主题。
 */
const GRANDFATHERED = new Set([
  "#fff",
  "rgba(0, 0, 0, .45)",
  "rgba(0, 0, 0, 0.55)",
  "rgba(0, 0, 0, 0.6)",
]);

test.each(styleSheets)("%s 里没有新的颜色字面量", (sheet) => {
  const source = readFileSync(sheet, "utf8");
  // 调色板兜底块是唯一允许写死的地方——它就是那些值的家。
  const body = source.replace(/^:root \{[\s\S]*?\n\}/m, "");
  const found = new Set(
    [...body.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)/g)].map((m) => m[0].toLowerCase()),
  );
  const offenders = [...found].filter((c) => !GRANDFATHERED.has(c));
  expect({ sheet: sheet.split("/").slice(-3).join("/"), offenders }).toEqual({
    sheet: sheet.split("/").slice(-3).join("/"),
    offenders: [],
  });
});
