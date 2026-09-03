import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 可点目标不能小到点不中。
 *
 * 这条不是风格偏好，是量出来的问题：某一版之前每个可点元素都是 17–23px 高
 * （11–13px 字加 2–5px 内边距），而这是个手机优先的界面。收紧密度的那几轮改动
 * 一路把它们压到了可点的下限以下，而没有任何东西会因此变红。
 *
 * 底线取 WCAG 2.5.8「目标尺寸（最小）」的 24×24 CSS px，不是 2.5.5 的 44×44——
 * 跟 themes.test.ts 只卡 AA 不卡 AAA 同一条理由：44px 会把这份列表赖以成立的密度
 * 整个吃掉。独立控件（浮层按钮、选择行）另按 44，因为那里不牺牲任何东西。
 *
 * 用扫描 CSS 而不是真排版：这里要防的具体错误是"某个可点选择器没有声明高度下限"，
 * 扫描直接对应这件事，而且把 min-height 那行删掉就一定会红。真排版要跑无头浏览器，
 * 脆而且慢，换不来更强的结论。
 */

// 先剥注释再解析：不剥的话，一条规则前面那段说明会跟第一个选择器黏成一个串，
// `.item-title` 于是永远匹配不上——而这个仓库几乎每条规则前面都有注释。
const CSS = readFileSync(join(import.meta.dir, "..", "public", "style.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** 这个选择器被哪些规则块声明过 min-height，取其中最大的那个值。 */
function minHeightOf(selector: string): number | null {
  let best: number | null = null;
  // 规则块：选择器列表 { ... }。选择器可能跟别的并列在同一个块里。
  for (const block of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = block[1]!.split(",").map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    const found = block[2]!.match(/min-height:\s*(\d+)px/);
    if (found) {
      const px = Number(found[1]);
      if (best === null || px > best) best = px;
    }
  }
  return best;
}

/** 密集行里的可点元素：WCAG AA 的 24px 下限。 */
const DENSE = [
  ".facet.has-detail",
  ".filter-chip",
  "a.item-source.is-link",
  ".item-new",
  ".item-refresh",
];

/** 独立控件：没有密度包袱，按 44px。 */
// .item-link 和 .item-archive 曾经在这张密集清单里，因为它们当时是卡片行上的
// 小 pill。现在这两个动作挪进了动作弹层，跟「取消」并排戴 .btn——在弹层里它们
// 是独立控件，不再有密度包袱，所以归属换了一档而不是放宽了要求。
//
// 把 .btn 补进来是这次移动的另一半：只把那两个选择器删掉的话，覆盖会悄悄少一
// 块——删断言换绿灯，正是这张清单存在要防的事。.btn 是弹层和表单里所有主按钮
// 的基类（结束会话的确认、新建、保存、发送），一条就把它们全盖住了。
const STANDALONE = [".sheet-close", ".sheet-create", ".field-remove", ".pick-row", ".btn",
  // 配置页的节标题从一行字变成了折叠开关。整行都是点击区（拇指用），所以它归
  // 独立控件这一档——一个点不中的折叠开关，等于那一节的配置都够不着。
  ".settings-head"];

/** 工具条：一页只有一行，代价只付一次。 */
// 工具条那几个控件收敛成了一个共享类。以前这里按名字列举，而列举挡不住"新加
// 一个控件时忘了给它挂样式"——#session-filter 就是这么漏掉外观规则的（它在这张
// 清单里，却没有任何外观规则）。DOM 那一侧由 src/items-toolbar.test.ts 断言每个
// 控件都戴了这个类，两条合起来才是完整的：一条管"戴了类的够高"，一条管"每个
// 控件都戴了类"。
const TOOLBAR = [".toolbar-control", ".field-btn", "#field-picker"];

for (const selector of DENSE) {
  test(`${selector} 至少 24px 高（WCAG 2.5.8 AA）`, () => {
    const px = minHeightOf(selector);
    expect(px).not.toBeNull();
    expect(px!).toBeGreaterThanOrEqual(24);
  });
}

for (const selector of TOOLBAR) {
  test(`${selector} 至少 32px 高`, () => {
    const px = minHeightOf(selector);
    expect(px).not.toBeNull();
    expect(px!).toBeGreaterThanOrEqual(32);
  });
}

for (const selector of STANDALONE) {
  test(`${selector} 至少 44px 高（WCAG 2.5.5 AAA）`, () => {
    const px = minHeightOf(selector);
    expect(px).not.toBeNull();
    expect(px!).toBeGreaterThanOrEqual(44);
  });
}

/**
 * 声明了 min-height 就必须一起声明 box-sizing。
 *
 * 这几个元素全都有内边距和边框。默认的 content-box 下，min-height 管的是内容盒，
 * 实际高度会比声明的大——看着"达标了"，但达标的是一个不是你以为的数字，而下一次
 * 有人把内边距调小时，真实高度会跟着掉下去而这些断言仍然是绿的。
 */
test("有高度下限的元素都用 border-box 量", () => {
  const missing: string[] = [];
  for (const selector of [...DENSE, ...TOOLBAR, ...STANDALONE]) {
    const blocks = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((b) =>
      b[1]!.split(",").map((s) => s.trim()).includes(selector),
    );
    const body = blocks.map((b) => b[2]!).join(" ");
    if (!/box-sizing:\s*border-box/.test(body)) missing.push(selector);
  }
  expect(missing).toEqual([]);
});

/**
 * 长文本要用 pretty 断行。
 *
 * 单标题动辄一整句话，末行只剩一个词是这份列表里最常见的难看。不支持的浏览器
 * 忽略这条属性，所以没有回退成本——也就没有不写的理由。
 */
test("长文本元素声明了 text-wrap: pretty", () => {
  for (const selector of [".item-title", ".detail-label", ".pick-label"]) {
    const blocks = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((b) =>
      b[1]!.split(",").map((s) => s.trim()).includes(selector),
    );
    const body = blocks.map((b) => b[2]!).join(" ");
    expect(body).toContain("text-wrap: pretty");
  }
});
