import { test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";

/**
 * 响应式那一层的结构性约束。
 *
 * 这里断言的不是"页面长什么样"——CSS 在无头环境里不排版，那种断言写不出来。
 * 断言的是**布局在哪些条件下切换**，因为那正是这一层唯一会悄悄坏掉的地方：
 * 一个字面量写错，页面在某个特定窗口宽度才裂开，读代码看不出来，跑测试也不会红。
 *
 * 扫的文件跟 src/themes.test.ts 一样，是内核加上每个插件自己的样式表——样式
 * 归插件目录所有（见 CLAUDE.md），只扫内核那份等于给插件开了后门。
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

const label = (sheet: string) => sheet.split("/").slice(-3).join("/");

/**
 * 先把注释剥掉再扫。
 *
 * 这个文件里的注释大量地在谈 @media 和断点——那是它们该谈的事——而一条
 * `/@media[^{]+/` 会把整段解释连着后面真正的查询一起吞进来当成违规。第一次跑
 * 就是这么红的：报出来的"违规查询"是一整段中文散文。
 */
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * 允许的宽度断点，全站只有一个。
 *
 * 写在这里而不是某个共享模块里：CSS 读不到 TypeScript 常量，多一个模块换不来
 * 单一事实来源，只多一个要同步的地方。这张单子本身就是那个事实来源。
 *
 * 为什么只准一个值：原生 CSS 的 @media 里用不了自定义属性，于是 900px 这个
 * 字面量在三张样式表里各写一遍，没有任何机制阻止第二个人写 768px、第三个人写
 * 1024px。三个文件在三个不同宽度换布局，症状是把窗口拖到某个区间时卡片已经
 * 两列了而工具条还堆着——只在那一段宽度里存在，谁也不会正好停在那儿。
 *
 * 加一个值到这里之前，先想清楚为什么现有的这个不够用。
 */
const ALLOWED_WIDTHS = new Set(["900px"]);

test.each(styleSheets)("%s 只用允许的宽度断点", (sheet) => {
  const source = strip(readFileSync(sheet, "utf8"));
  const found = new Set(
    [...source.matchAll(/\((?:min|max)-width:\s*([^)]+)\)/g)].map((m) => m[1]!.trim()),
  );
  const offenders = [...found].filter((w) => !ALLOWED_WIDTHS.has(w));
  expect({ sheet: label(sheet), offenders }).toEqual({ sheet: label(sheet), offenders: [] });
});

/**
 * 指针能力的查询必须带 pointer: fine。
 *
 * 带触摸屏的 Windows 笔记本 hover 和 pointer 两项都报 true，只查 hover 会把它
 * 当成纯鼠标设备——于是那台机器上的软键盘条被收掉，而它是真的能用手指戳屏幕的。
 * 两个条件都问，才是在问"有没有一个精确的指针"。
 */
test.each(styleSheets)("%s 的指针查询都带 pointer: fine", (sheet) => {
  const source = strip(readFileSync(sheet, "utf8"));
  const offenders = [...source.matchAll(/@media[^{]+/g)]
    .map((m) => m[0].trim())
    .filter((q) => /hover:\s*hover/.test(q) && !/pointer:\s*fine/.test(q));
  expect({ sheet: label(sheet), offenders }).toEqual({ sheet: label(sheet), offenders: [] });
});

/**
 * 宽度和指针是两个正交的判断，不许合成一个。
 *
 * 反例两边都真实存在：iPad 横屏是宽的但没有鼠标，把软键盘条绑在宽度上，那台
 * 设备就失去 Esc / Tab / 方向键——而它恰恰最需要这几个键；把窗口拖窄一半的 Mac
 * 有鼠标但不宽，把 hover 绑在宽度上，鼠标反馈就凭空消失。
 *
 * 一个 @media 同时写 min-width 和 hover 就是把两者绑死了，所以直接拦掉。
 */
test.each(styleSheets)("%s 没有把宽度和指针绑进同一个查询", (sheet) => {
  const source = strip(readFileSync(sheet, "utf8"));
  const offenders = [...source.matchAll(/@media[^{]+/g)]
    .map((m) => m[0].trim())
    .filter((q) => /(?:min|max)-width/.test(q) && /(?:hover|pointer):/.test(q));
  expect({ sheet: label(sheet), offenders }).toEqual({ sheet: label(sheet), offenders: [] });
});

/**
 * 内核样式表不认识任何一个插件。
 *
 * CLAUDE.md 立的规矩，但在此之前没有东西拦它。这次差点就破了：宽屏要把卡片的
 * margin 清零交给网格，而工单卡片是 .jira-card 不是 .card，顺手在内核里多写一个
 * 选择器是最自然的动作——写下去内核就依赖上了一个可以被 TMUX_NEXT_DISABLE_PLUGINS
 * 关掉、也可以被整个目录删掉的东西。正确的做法是那条规则搬进插件自己的样式表。
 */
test("内核样式表里不出现插件 id", () => {
  const kernel = readFileSync(new URL("../public/style.css", import.meta.url).pathname, "utf8");
  const ids = readdirSync(new URL("../plugins/", import.meta.url).pathname, {
    withFileTypes: true,
  })
    .filter((e) => e.isDirectory() && existsSync(`${new URL("../plugins/", import.meta.url).pathname}${e.name}/plugin.js`))
    .map((e) => e.name);
  const offenders = ids.filter((id) => new RegExp(`[.#]${id}\\b|\\b${id}-`).test(kernel));
  expect(offenders).toEqual([]);
});
