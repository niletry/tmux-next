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

import { THEMES, THEME_GROUPS, ANSI_NAMES, uiVars } from "./themes.js";
import { setTheme, cachedTheme, initTheme } from "./theme-apply.js";
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
  return section(tr("settings.language"), row, el("p", "settings-note", tr("settings.note")));
}

/**
 * 界面外观的缩略图，跟终端那个是两件事。
 *
 * 拿假终端去预览界面主题是预览错了对象：那张图里每一个颜色都来自 `--term-*`，
 * 而界面主题喂的是 `uiVars` 那套角色令牌，两者现在可以是不同的主题。所以这里
 * 照着一张真的会话卡片画——表面层、主次文字、一个实心强调按钮，也就是这一页
 * 之外的地方真正会看到的东西。
 *
 * 颜色一律写成内联样式、从 uiVars 取，不写进样式表：样式表里除了兜底那一块
 * 不许出现颜色字面量（src/themes.test.ts 逐张表扫）。
 */
function chromePreview(name) {
  const v = uiVars(name);
  const box = el("div", "theme-prev is-chrome");
  box.style.background = v["--surface-1"];

  const card = el("div", "theme-prev-card");
  card.style.background = v["--surface-3"];
  card.style.borderColor = v["--border-1"];

  const title = el("b", null, "fix the hook");
  title.style.color = v["--text-1"];
  const meta = el("span", "theme-prev-meta", `${tr("list.working")} · 5m`);
  meta.style.color = v["--text-2"];
  const btn = el("span", "theme-prev-btn", tr("settings.themePreviewAction"));
  btn.style.background = v["--accent"];
  btn.style.color = v["--on-accent"];

  card.append(title, meta, btn);
  box.append(card);
  return box;
}

/**
 * 一节配色选择器。两节共用这一个函数，差别只有三处：改哪个字段、当前勾的是谁、
 * 预览画什么。
 *
 * `field` 就是发给 /api/theme 的补丁字段名（"name" 是终端调色板，"ui" 是页面
 * 外壳），所以这一节不需要知道这两个字段各自意味着什么。
 *
 * 标题和说明收的都是**已经翻好的**字符串，不是 i18n 键：死键扫描只认字面量
 * `tr("…")`，把键名当参数传进来它就看不见了。跟 section() 同一个理由。
 *
 * @param {"name" | "ui"} field
 * @param {string} title 已经翻好的节标题
 * @param {string} noteText 已经翻好的说明，存失败时会被回执顶掉再换回来
 * @param {string} chosen 当前选中的主题名
 */
function themeSection(field, title, noteText, chosen) {
  const list = el("div", "theme-list");
  const note = el("p", "settings-note", noteText);
  let current = chosen;

  for (const group of THEME_GROUPS) {
    list.append(el("h3", "theme-group", tr(group.labelKey)));
    for (const name of group.names) {
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
      body.append(swatches, field === "ui" ? chromePreview(name) : preview(theme));
      row.append(radio, body);

      row.addEventListener("click", async () => {
        if (name === current) return;
        // 先上色：整页在手指底下换过来，这就是选它的理由——不必确认，看见即结果。
        current = name;
        for (const other of list.querySelectorAll(".theme-opt")) {
          const on = other === row;
          other.classList.toggle("on", on);
          other.setAttribute("aria-pressed", String(on));
        }
        // 存不下只影响"这台机器下次打开还是不是这个色"，页面此刻已经是对的，
        // 所以是提示一句而不是回滚——把刚看到的颜色再撤回去才是更糟的答复。
        const stored = await setTheme({ [field]: name });
        note.textContent = stored ? noteText : tr("settings.saveFailed");
      });

      list.append(row);
    }
  }
  return section(title, list, note);
}

/**
 * 两节：终端画布一套配色，页面外壳另一套。
 *
 * 平铺成两节而不是一个"终端/界面"切换器，是为了两边的当前选择同时看得见——
 * 切换器把另一半藏起来，而这一页存在的意义就是说出这台机器现在长什么样。
 *
 * 选中态来自 :root 上的两个 attribute（theme-apply.js 刚写的，也就是服务端那份），
 * 拿不到才回落到缓存。
 */
function themeSections() {
  const root = document.documentElement;
  const cached = cachedTheme();
  return [
    themeSection(
      "name", tr("settings.themeTerminal"), tr("settings.themeTerminalNote"),
      root.dataset.termTheme || cached.name,
    ),
    themeSection(
      "ui", tr("settings.themeUi"), tr("settings.themeUiNote"),
      root.dataset.theme || cached.ui,
    ),
  ];
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

/**
 * 一个插件的配置表单，照着它清单里的 settings 画。
 *
 * 这一页**不知道任何一个字段是什么意思**——只认 type（怎么画、密钥要不要藏）和
 * labelKey（叫什么）。所以接进来的下一个数据源自动就有配置界面，这一页一行不改。
 *
 * @param {{ id: string, titleKey: string, settings: any[] }} plugin
 * @param {Record<string, unknown>} values 服务端读回来的当前值
 */
function pluginSection(plugin, values) {
  const form = el("div", "settings-form");
  /** @type {Record<string, () => string | boolean>} */
  const readers = {};

  for (const field of plugin.settings) {
    const row = el("label", "settings-field");
    row.append(el("span", "settings-label", tr(field.labelKey)));
    const current = values[field.key];

    if (field.type === "boolean") {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "settings-check";
      box.checked = current === true;
      row.prepend(box);
      row.classList.add("is-check");
      readers[field.key] = () => box.checked;
    } else {
      const input = document.createElement("input");
      input.className = "settings-input";
      input.type = field.type === "url" ? "url" : "text";
      if (field.type === "secret") {
        input.type = "password";
        // 密钥读不回来，只知道设没设过。占位符说这件事，输入框留空——回填一串假的
        // 掩码迟早会被当成真值存回去。
        input.placeholder = current && current.set ? tr("settings.secretSet") : tr("settings.secretUnset");
        input.autocomplete = "off";
      } else if (typeof current === "string") {
        input.value = current;
      }
      row.append(input);
      readers[field.key] = () => input.value;
    }

    if (field.hintKey) row.append(el("span", "settings-hint", tr(field.hintKey)));
    form.append(row);
  }

  // 自己的类名，不跟 settings-note 混：那个是常驻说明，这个是一次动作的回执，
  // 两者同名的话"找到那句回执"就得靠位置，而位置是最容易被下一次改动挪走的东西。
  const note = el("p", "settings-result", "");
  note.hidden = true;
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn primary";
  save.textContent = tr("settings.save");
  save.addEventListener("click", async () => {
    save.disabled = true;
    save.textContent = tr("settings.saving");
    note.hidden = true;
    const body = {};
    for (const [key, read] of Object.entries(readers)) body[key] = read();
    let ok = false;
    try {
      const res = await fetch(url(`api/plugins/${encodeURIComponent(plugin.id)}/settings`), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      ok = res.ok;
    } catch {
      ok = false;
    }
    // 存成了也要说一句：密钥框存完仍然是空的（它本来就不回填），没有回执的话
    // 屏幕上看不出刚才那一下有没有生效。
    note.textContent = ok ? tr("settings.saved") : tr("settings.cfgSaveFailed");
    note.hidden = false;
    save.disabled = false;
    save.textContent = tr("settings.save");
  });

  const actions = el("div", "settings-actions");
  actions.append(save);
  return section(tr(plugin.titleKey), form, actions, note);
}

/**
 * 会话模板的增删改。
 *
 * 可用字段（内核的 + 已启用插件的）整份由服务端跟模板一起下发（GET /api/templates 的
 * fieldKeys）——这一页不再从同构的 registry.js 里另抄一份插件字段名，那份是编译进去的
 * 全部插件，跟 TMUX_NEXT_DISABLE_PLUGINS 实际启用的集合不是一回事。**这一页里没有任何一个
 * 插件名**——跟顶栏用 titleKey 画标签、卡片用 dim 画 chip 是同一步棋。
 *
 * 键名原样显示、不翻译：模板作者要打的就是这串字。
 */
function templatesSection(templates, fieldKeys) {
  const list = el("div", "template-list");
  /** @type {Array<() => any>} */
  const readers = [];
  /** @type {HTMLTextAreaElement | HTMLInputElement | null} */
  let lastFocused = null;

  function addRow(t) {
    const row = el("div", "template-item");
    // labelText 收的是**已经翻好的**文案，不是 i18n 键：死键扫描只认字面量
    // `tr("…")`，键名要是从这个小工具函数的形参里转一手它就看不见了——跟
    // section() 顶上那条注释同一个理由。
    const mk = (labelText, value, multi) => {
      const wrap = el("label", "settings-field");
      wrap.append(el("span", "settings-label", labelText));
      const input = document.createElement(multi ? "textarea" : "input");
      input.className = "settings-input";
      input.value = value || "";
      if (multi) input.rows = 4;
      input.addEventListener("focus", () => { lastFocused = input; });
      wrap.append(input);
      row.append(wrap);
      return input;
    };
    const label = mk(tr("settings.templateLabel"), t.label, false);
    const name = mk(tr("settings.templateName"), t.name, false);
    const input = mk(tr("settings.templateInput"), t.input, true);

    const del = el("button", "btn template-del", tr("settings.templateDelete"));
    del.type = "button";
    del.addEventListener("click", () => {
      // 删的那一行如果正握着"点 chip 插到哪"的焦点，得把它放掉——不然 chip 的
      // 处理器会在一个已经脱离文档树的输入框上悄悄写 .value，界面上什么反应
      // 都看不到，跟真没插进去一样。
      if (row.contains(lastFocused)) lastFocused = null;
      row.remove();
      const at = readers.indexOf(read);
      if (at >= 0) readers.splice(at, 1);
      // 删光之后要把"还没有模板"那句放回来，否则这一节就剩一个空标题，
      // 看不出是"没有"还是"没画出来"。
      if (!readers.length && !list.querySelector(".settings-note")) {
        list.append(el("p", "settings-note", tr("settings.templateEmpty")));
      }
    });
    row.append(del);

    const read = () => ({ id: t.id, label: label.value, name: name.value, input: input.value });
    readers.push(read);
    list.append(row);
  }

  /**
   * 拿一份模板数组重画整个列表——保存成功之后用这个，而不是继续显示保存前
   * 那份。服务端 PUT 会把净化后的那一份吐回来（比如 label 是空的条目会被整条
   * 丢掉），继续显示旧的会让界面说"已保存"而磁盘上其实没有这一行，用户要等
   * 下次进设置页才发现东西凭空消失。重画让屏幕上的东西始终等于刚存下去的。
   */
  function fill(items) {
    list.replaceChildren();
    readers.length = 0;
    for (const t of items) addRow(t);
    if (!items.length) list.append(el("p", "settings-note", tr("settings.templateEmpty")));
  }

  fill(templates);

  // 可用字段：点一下插到刚才那个框的光标处。
  const keys = el("div", "template-keys");
  keys.append(el("span", "settings-label", tr("settings.templateKeys")));
  for (const key of fieldKeys) {
    const chip = el("button", "template-key", `{${key}}`);
    chip.type = "button";
    chip.addEventListener("click", () => {
      if (!lastFocused) return;
      const at = lastFocused.selectionStart ?? lastFocused.value.length;
      lastFocused.value =
        lastFocused.value.slice(0, at) + `{${key}}` + lastFocused.value.slice(at);
      lastFocused.focus();
    });
    keys.append(chip);
  }

  const add = el("button", "btn template-new", tr("settings.templateNew"));
  add.type = "button";
  add.addEventListener("click", () => {
    const note = list.querySelector(".settings-note");
    if (note) note.remove();
    addRow({ id: "", label: "", name: "", input: "" });
  });

  const note = el("p", "settings-result", "");
  note.hidden = true;
  const save = el("button", "btn primary", tr("settings.save"));
  save.type = "button";
  save.addEventListener("click", async () => {
    save.disabled = true;
    save.textContent = tr("settings.saving");
    note.hidden = true;
    let ok = false;
    try {
      const res = await fetch(url("api/templates"), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ templates: readers.map((r) => r()) }),
      });
      ok = res.ok;
      // 用服务端净化后吐回来的那一份重画，别接着显示保存前那份——两者可能不同
      // （比如没填模板名的那一行，服务端直接不存）。
      if (ok) fill((await res.json()).templates || []);
    } catch {
      ok = false;
    }
    note.textContent = ok ? tr("settings.saved") : tr("settings.cfgSaveFailed");
    note.hidden = false;
    save.disabled = false;
    save.textContent = tr("settings.save");
  });

  const actions = el("div", "settings-actions");
  actions.append(add, save);
  return section(
    tr("settings.templates"),
    el("p", "settings-note", tr("settings.templatesNote")),
    list,
    keys,
    actions,
    note,
  );
}

/**
 * 声明了配置的插件，各画一节。
 *
 * 值要问服务端（清单是同构的，凭据绝不在里面）。问不到就跳过这一节——那意味着这个
 * 插件被 TMUX_NEXT_DISABLE_PLUGINS 关掉了，或者服务端答不上来，两种情况下画一个存
 * 不进去的表单都只是骗人。
 */
async function pluginSections() {
  const out = [];
  for (const plugin of PLUGINS) {
    if (!plugin.settings?.length) continue;
    try {
      const res = await fetch(url(`api/plugins/${encodeURIComponent(plugin.id)}/settings`));
      if (!res.ok) continue;
      out.push(pluginSection(plugin, await res.json()));
    } catch {
      // 这一节这次画不出来，别的照常。
    }
  }
  return out;
}

export function renderSettings(root) {
  const draw = async () => {
    document.title = tr("settings.title");
    root.replaceChildren(languageSection(draw), ...themeSections(), keysSection());
    const header = document.getElementById("header");
    // 顶栏跟着一起重画：换语言之后返回键的文案也变了，只重画正文会留下一句旧话。
    if (header) header.replaceChildren(backLink(), el("h1", "settings-title", tr("settings.title")));
    // 插件那几节要问服务端，晚一步到：内核自己的三节先画出来，不为一次网络往返
    // 把整页压住。
    for (const node of await pluginSections()) root.append(node);
    // 模板那一节也要问服务端，跟插件几节一起晚一步到。
    try {
      const res = await fetch(url("api/templates"));
      if (res.ok) {
        const body = await res.json();
        root.append(templatesSection(body.templates || [], body.fieldKeys || []));
      }
    } catch {
      // 这一节这次画不出来，别的照常。
    }
  };
  void draw();
}

// 这一页不画顶部标签栏：它是从齿轮进来的，不是「单/会话」的同级，画上去只会多出
// 一个指向自己的齿轮。跟 new.html 一样，自带一个返回。
// initTheme() 先跑：这一页在此之前谁也没调过它——settings.html 里那个
// <script src="theme-apply.js"> 只是 import，模块顶层没有调用——所以它画的是
// 样式表里的兜底调色板，选中态勾的是缓存而不是这台机器真正存着的那两个名字。
// 等它落定再渲染，选择器才勾得对；等一次本地往返也不会闪，因为它先用缓存上了色。
Promise.all([initLang(), initTheme()]).then(() => {
  const root = document.getElementById("settings");
  if (root) renderSettings(root);
});
