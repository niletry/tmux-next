import { THEMES, THEME_ORDER, ANSI_NAMES } from "./themes.js";
import { setTheme, cachedTheme } from "./theme-apply.js";
import { LANGS, LANG_LABELS } from "./i18n.js";
import { setLang, lang as currentLang, tr } from "./i18n-apply.js";
import {
  ROWS,
  USAGE_OF,
  readLayout,
  writeLayout,
  clearLayout,
} from "./key-layout.js";

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

  // Virtual keys: which toolbar keys sit where. Per device, like font size.
  const keysHead = el("h3", "sheet-sub", tr("settings.keys"));
  const keysActions = el("div", "agent-row");
  const keysEdit = el("button", "btn", tr("settings.keysEdit"));
  const keysReset = el("button", "btn", tr("settings.keysReset"));
  keysEdit.addEventListener("click", () => {
    close();
    openKeyEditor();
  });
  keysReset.addEventListener("click", () => {
    clearLayout();
    const done = tr("settings.keysResetDone");
    keysReset.textContent = done;
    keysReset.disabled = true;
    setTimeout(() => {
      keysReset.textContent = tr("settings.keysReset");
      keysReset.disabled = false;
    }, 1500);
  });
  keysActions.append(keysEdit, keysReset);
  sheet.append(
    keysHead,
    keysActions,
    el("p", "sheet-note", tr("settings.keysNote")),
  );

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

// --- virtual-key editor ----------------------------------------------------

/**
 * A readable name for each key, mirroring what the toolbar itself shows.
 * Symbols (Esc, arrows, the font size pair) need no translation; the four
 * tool buttons that are SVG-only borrow the interface strings that describe
 * them elsewhere.
 */
function keyLabel(key) {
  const SYMBOLS = {
    esc: "Esc",
    tab: "Tab",
    "shift-tab": "⇧Tab",
    up: "↑",
    down: "↓",
    enter: "⏎",
    ctrl: "Ctrl",
    "ctrl-c": "^C",
    left: "←",
    right: "→",
    kbd: "⌨",
    "font-dec": "A−",
    "font-inc": "A+",
  };
  const NAMED = {
    mic: tr("term.voice"),
    img: tr("term.sendImage"),
    paste: tr("term.paste"),
    copy: tr("term.copyLinks"),
  };
  return SYMBOLS[key] ?? NAMED[key] ?? key;
}

/**
 * The reorder sheet. One row group per toolbar row; each key gets a move-up
 * and a move-down button, and the tap counts the key has earned on this
 * machine (if any) sit beside it, so the order can be chosen from evidence.
 */
export function openKeyEditor() {
  const backdrop = el("div", "sheet-backdrop");
  const sheet = el("div", "sheet");
  const head = el("div", "agent-row");
  const back = el("button", "btn", tr("settings.keysBack"));
  back.addEventListener("click", () => {
    backdrop.remove();
    openThemeSheet();
  });
  head.append(back);
  sheet.append(el("h2", null, tr("settings.keys")), head);

  let layout = readLayout();

  const list = el("div", "theme-list");
  const ROW_TITLE = {
    primary: tr("key.rowPrimary"),
    nav: tr("key.rowNav"),
    tools: tr("key.rowTools"),
  };

  /**
   * One row of the toolbar, laid out the way the toolbar really is: the keys
   * sit side by side as tiles. That is the point of the editor — you see the
   * actual arrangement, not a list of rows.
   */
  const renderGroup = (row) => {
    const group = el("div", "key-grid-row");
    group.append(el("h3", "sheet-sub", ROW_TITLE[row]));
    const strip = el("div", "key-strip");
    layout[row].forEach((key) => {
      const tile = el("button", "key-tile", keyLabel(key));
      tile.type = "button";
      tile.dataset.key = key;
      tile.setAttribute("aria-label", tr("key.drag"));
      // The tap count as a small badge, like an app icon's badge.
      if (usage.has(USAGE_OF[key])) {
        const badge = el("span", "key-tile-usage", String(usage.get(USAGE_OF[key])));
        badge.title = tr("key.usageCount", { n: usage.get(USAGE_OF[key]) });
        tile.append(badge);
      }
      strip.append(tile);
    });
    // The whole tile is the handle: press it and slide it sideways.
    strip.addEventListener("pointerdown", (e) => {
      const tile = e.target.closest(".key-tile");
      if (!tile) return;
      startDrag(e, row, tile, strip);
    });
    group.append(strip);
    return group;
  };

  // --- drag, icon-style ----------------------------------------------------

  /**
   * Press a key and slide it sideways; the tiles it passes slide out of the
   * way, and the order is committed on release. The grabbed tile is pulled
   * out of flow and follows the finger; the others move via transform, so the
   * strip never jumps. Pointer capture + `touch-action: none` keep the page
   * from scrolling instead.
   */
  const GAP = 8; // must match the .key-strip gap in style.css

  function startDrag(e, row, tile, strip) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    const tiles = [...strip.querySelectorAll(".key-tile")];
    const index = tiles.indexOf(tile);
    const width = tile.offsetWidth + GAP;
    const origLeft = tile.offsetLeft;
    const startX = e.clientX;
    let target = index;
    let moved = false;

    // Keep the strip's width while the grabbed tile leaves flow.
    strip.style.minWidth = `${strip.offsetWidth}px`;
    tile.classList.add("dragging");
    tile.style.left = `${origLeft}px`;
    tiles.forEach((t) => {
      if (t !== tile) t.style.transition = "transform .12s ease";
    });

    const shiftOthers = (to) => {
      // Tiles between the old and new position slide one slot sideways.
      tiles.forEach((t, i) => {
        if (t === tile) return;
        if (to < index) t.style.transform = i >= to && i < index ? `translateX(${width}px)` : "";
        else if (to > index) t.style.transform = i > index && i <= to ? `translateX(${-width}px)` : "";
        else t.style.transform = "";
      });
    };

    const onMove = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      ev.preventDefault();
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 6) return; // wait for intent, not a tap
      moved = true;
      tile.style.left = `${origLeft + dx}px`;
      // The slot whose middle the finger has crossed.
      let acc = 0;
      let t = tiles.length - 1;
      for (let i = 0; i < tiles.length; i++) {
        if (i === index) continue;
        if (origLeft + dx < acc + width / 2) {
          t = i;
          break;
        }
        acc += width;
      }
      if (t !== target) {
        target = t;
        shiftOthers(target);
      }
    };

    const onUp = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      finish();
    };

    const onCancel = () => finish(true);

    const finish = (revert = false) => {
      tile.removeEventListener("pointermove", onMove);
      tile.removeEventListener("pointerup", onUp);
      tile.removeEventListener("pointercancel", onCancel);
      tile.classList.remove("dragging");
      tile.style.left = "";
      strip.style.minWidth = "";
      tiles.forEach((t) => {
        t.style.transition = "";
        t.style.transform = "";
      });
      if (revert || target === index) return;
      const keys = layout[row];
      const [key] = keys.splice(index, 1);
      keys.splice(target, 0, key);
      if (writeLayout(layout)) render();
    };

    tile.addEventListener("pointermove", onMove);
    tile.addEventListener("pointerup", onUp);
    tile.addEventListener("pointercancel", onCancel);
    tile.setPointerCapture(e.pointerId);
  }

  /** The usage totals, for the badge on each tile. Best effort. */
  const usage = new Map();
  const render = () => {
    list.replaceChildren();
    for (const row of ["primary", "nav", "tools"]) list.append(renderGroup(row));
  };

  // Fetch the counts first (they change nothing about the ordering), then draw.
  fetch("api/key-usage")
    .then((r) => r.json())
    .then((rows) => {
      for (const row of Array.isArray(rows) ? rows : []) {
        if (typeof row?.key === "string" && typeof row.count === "number") {
          usage.set(row.key, row.count);
        }
      }
      render();
    })
    .catch(() => render());

  const close = () => backdrop.remove();
  const done = el("button", "btn", tr("common.close"));
  done.addEventListener("click", close);
  const actions = el("div", "sheet-actions");
  actions.append(done);

  sheet.append(list, actions);
  backdrop.append(sheet);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  document.body.append(backdrop);
}
