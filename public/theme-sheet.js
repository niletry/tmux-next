import { THEMES, THEME_ORDER, ANSI_NAMES } from "./themes.js";
import { setTheme, cachedTheme } from "./theme-apply.js";
import { LANGS, LANG_LABELS } from "./i18n.js";
import { setLang, lang as currentLang, tr } from "./i18n-apply.js";

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
    line(theme.foreground, "修复 hook\n"),
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
 * The appearance picker.
 *
 * Colours only. Font size stays on the terminal toolbar, because it is a
 * property of the screen you are holding rather than of the machine — the two
 * are stored differently for the same reason.
 */
export function openThemeSheet() {
  const backdrop = el("div", "sheet-backdrop");
  const sheet = el("div", "sheet");
  sheet.append(el("h2", null, tr("settings.title")));

  // Language sits above the palette: it changes the words the rest of this
  // sheet is written in, so choosing it first is the order that makes sense.
  const langRow = el("div", "agent-row");
  for (const code of LANGS) {
    const btn = el("button", "agent-chip", LANG_LABELS[code]);
    btn.type = "button";
    if (code === currentLang()) btn.classList.add("on");
    btn.addEventListener("click", async () => {
      if (code === currentLang()) return;
      await setLang(code);
      // The sheet is built from strings in the old language, so rebuild it
      // rather than trying to patch each node.
      backdrop.remove();
      openThemeSheet();
    });
    langRow.append(btn);
  }
  sheet.append(el("h3", "sheet-sub", tr("settings.language")), langRow);
  sheet.append(el("h3", "sheet-sub", tr("settings.theme")));

  const list = el("div", "theme-list");
  const close = () => backdrop.remove();

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
      if (name === current) return close();
      // Paint first: the whole sheet recolours under the finger, which is the
      // point of choosing here rather than on a settings page.
      current = name;
      for (const other of list.children) {
        const on = other === row;
        other.classList.toggle("on", on);
        other.setAttribute("aria-pressed", String(on));
      }
      const stored = await setTheme(name);
      if (!stored) {
        // The page is already correct; only the machine-wide record failed.
        note.textContent = tr("settings.saveFailed");
        return;
      }
      close();
    });

    list.append(row);
  }

  const note = el("p", "sheet-note", tr("settings.note"));
  const cancel = el("button", "btn", tr("common.close"));
  cancel.addEventListener("click", close);
  const actions = el("div", "sheet-actions");
  actions.append(cancel);

  sheet.append(list, note, actions);
  backdrop.append(sheet);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  document.body.append(backdrop);
}
