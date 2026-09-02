// 系统配置页。
//
// 这些配置原来挤在顶栏齿轮后面的一个底部浮层里。浮层适合"改一个就走"，不适合往里
// 加东西：它从底部升起、高度受限，每多一节就把上一节推出屏幕，而配置只会越来越多。
// 所以搬成一整页，一节一个标题，往下加就是了。
//
// 换主题时"整页在手指底下重新上色"这件事没有丢——那是原来选浮层的理由，而页面同样
// 是活的，颜色写在 :root 上，谁在上面都会跟着变。
//
// 字号不在这里：它按设备存（localStorage），是"这块屏幕多大"的事，留在终端页的
// 工具条上；这里是"这台机器长什么样"。两者存法不同，也不该放在一起。

import { THEMES, THEME_ORDER, ANSI_NAMES } from "./themes.js";
import { setTheme, cachedTheme } from "./theme-apply.js";
import { LANGS, LANG_LABELS } from "./i18n.js";
import { initLang, setLang, lang as currentLang, tr } from "./i18n-apply.js";
import { clearLayout } from "./key-layout.js";
import { openKeyEditor } from "./key-editor.js";
import { url } from "./root.js";
import { backTarget } from "./back-target.js";
import { PLUGINS } from "../plugins/registry.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The slots worth showing as swatches: the six hues plus the secondary grey. */
const SWATCH_SLOTS = [1, 2, 3, 4, 5, 6, 8];

/**
 * A miniature of what the theme actually looks like in use.
 *
 * A row of swatches shows the palette but not the result. This reproduces the
 * shapes Claude Code actually draws — the dim status line, the prompt, a diff
 * line — because those are what a person is really choosing between, and the
 * dim grey in particular is invisible in a swatch strip yet decides whether the
 * theme is comfortable to read.
 */
function preview(theme) {
  const box = el("div", "theme-prev");
  box.style.background = theme.background;
  const line = (colour, text) => {
    const span = el("span", null, text);
    span.style.color = colour;
    return span;
  };
  const [, red, green, , , magenta] = theme.ansi;
  box.append(
    line(theme.ansi[8], "  ⏵⏵ don't ask on\n"),
    line(theme.ansi[7], "❯ "),
    line(theme.foreground, "fix the hook\n"),
    line(magenta, "✻"),
    line(theme.foreground, " Cogitated 1m21s\n"),
    line(theme.ansi[8], "  ⎿ "),
    line(green, "+ list-panes -a\n"),
    line(theme.ansi[8], "    "),
    line(red, "- display-message"),
  );
  return box;
}

/**
 * 一节：一个标题加内容，节与节之间靠这个统一间距，不靠各自的 margin。
 *
 * 收的是**已经翻好的**标题，不是 i18n 键：死键扫描只认字面量 `tr("…")`，把键名当
 * 参数传进来它就看不见了，两条键会被判成没人用。调用点写全是这个仓库既有的办法。
 */
function section(title, ...body) {
  const box = el("section", "settings-section");
  box.append(el("h2", "settings-head", title));
  for (const node of body) box.append(node);
  return box;
}

/**
 * 语言排在最前：它决定这一页其余部分用什么字写，先选它才讲得通。
 *
 * 改完整页重建，而不是逐个节点去补——这一页每一句都是用旧语言渲染的。
 */
function languageSection(rerender) {
  const row = el("div", "agent-row");
  for (const code of LANGS) {
    const btn = el("button", "agent-chip", LANG_LABELS[code]);
    btn.type = "button";
    if (code === currentLang()) btn.classList.add("on");
    btn.addEventListener("click", async () => {
      if (code === currentLang()) return;
      await setLang(code);
      rerender();
    });
    row.append(btn);
  }
  return section(tr("settings.language"), row);
}

function themeSection() {
  const list = el("div", "theme-list");
  const note = el("p", "settings-note", tr("settings.note"));
  let current = document.documentElement.dataset.theme || cachedTheme();

  for (const name of THEME_ORDER) {
    const theme = THEMES[name];
    const row = el("button", "theme-opt");
    row.type = "button";
    if (name === current) row.classList.add("on");
    row.setAttribute("aria-pressed", String(name === current));

    const radio = el("span", "theme-radio");
    const body = el("div", "theme-body");
    body.append(el("b", null, theme.label));

    const swatches = el("div", "theme-swatches");
    for (const i of SWATCH_SLOTS) {
      const chip = el("i");
      chip.style.background = theme.ansi[i];
      chip.title = ANSI_NAMES[i];
      swatches.append(chip);
    }
    body.append(swatches, preview(theme));
    row.append(radio, body);

    row.addEventListener("click", async () => {
      if (name === current) return;
      // 先上色：整页在手指底下换过来，这就是选它的理由——不必确认，看见即结果。
      current = name;
      for (const other of list.children) {
        const on = other === row;
        other.classList.toggle("on", on);
        other.setAttribute("aria-pressed", String(on));
      }
      // 存不下只影响"这台机器下次打开还是不是这个色"，页面此刻已经是对的，
      // 所以是提示一句而不是回滚——把刚看到的颜色再撤回去才是更糟的答复。
      const stored = await setTheme(name);
      note.textContent = stored ? tr("settings.note") : tr("settings.saveFailed");
    });

    list.append(row);
  }
  return section(tr("settings.theme"), list, note);
}

/** 虚拟按键：哪些键排在哪一行。按设备存，跟字号同类。 */
function keysSection() {
  const row = el("div", "agent-row");
  const edit = el("button", "btn", tr("settings.keysEdit"));
  const reset = el("button", "btn", tr("settings.keysReset"));
  edit.addEventListener("click", openKeyEditor);
  reset.addEventListener("click", () => {
    clearLayout();
    reset.textContent = tr("settings.keysResetDone");
    reset.disabled = true;
    setTimeout(() => {
      reset.textContent = tr("settings.keysReset");
      reset.disabled = false;
    }, 1500);
  });
  row.append(edit, reset);
  return section(tr("settings.keys"), row, el("p", "settings-note", tr("settings.keysNote")));
}

/** 返回来路那一页，认不出来路就回单列表——跟终端页的返回箭头同一套。 */
function backLink() {
  const pages = [
    { id: "items", path: "index.html", titleKey: "items.title" },
    { id: "sessions", path: "sessions.html", titleKey: "list.title" },
    ...PLUGINS.map((p) => ({ id: p.id, path: `p/${p.id}/`, titleKey: p.titleKey })),
  ];
  const target = backTarget(location.search, pages);
  const link = el("a", "settings-back", tr("nav.backTo", { name: tr(target.titleKey) }));
  link.href = url(target.path);
  return link;
}

export function renderSettings(root) {
  const draw = () => {
    document.title = tr("settings.title");
    root.replaceChildren(languageSection(draw), themeSection(), keysSection());
    const header = document.getElementById("header");
    // 顶栏跟着一起重画：换语言之后返回键的文案也变了，只重画正文会留下一句旧话。
    if (header) header.replaceChildren(backLink(), el("h1", "settings-title", tr("settings.title")));
  };
  draw();
}

// 这一页不画顶部标签栏：它是从齿轮进来的，不是「单/会话」的同级，画上去只会多出
// 一个指向自己的齿轮。跟 new.html 一样，自带一个返回。
initLang().then(() => {
  const root = document.getElementById("settings");
  if (root) renderSettings(root);
});
