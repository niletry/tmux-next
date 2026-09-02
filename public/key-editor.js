// 虚拟按键的重排编辑器。
//
// 从 theme-sheet.js 拆出来：配置从一个浮层变成一整页之后，那个文件里只剩下这一块
// 还是浮层——按键要拖着排序，得占满屏幕，塞进设置页里反而挤。所以它留作浮层，从
// 设置页打开，返回时回到设置页而不是再开一个浮层。

import { tr } from "./i18n-apply.js";
import { USAGE_OF, readLayout, writeLayout } from "./key-layout.js";
import { url } from "./root.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
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
  // 关掉就行：设置页一直在底下，不像原来那样需要再把上一个浮层开回来。
  back.addEventListener("click", () => backdrop.remove());
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
   * actual arrangement, not a list of rows. The whole board is one drop zone,
   * so a key can be moved across rows, not just within one.
   */
  const renderGroup = (row) => {
    const group = el("div", "key-grid-row");
    group.append(el("h3", "sheet-sub", ROW_TITLE[row]));
    const strip = el("div", "key-strip");
    strip.dataset.row = row;
    layout[row].forEach((key) => {
      const tile = el("button", "key-tile", keyLabel(key));
      tile.type = "button";
      tile.dataset.key = key;
      tile.dataset.row = row;
      tile.setAttribute("aria-label", tr("key.drag"));
      // The tap count as a small badge, like an app icon's badge.
      if (usage.has(USAGE_OF[key])) {
        const badge = el("span", "key-tile-usage", String(usage.get(USAGE_OF[key])));
        badge.title = tr("key.usageCount", { n: usage.get(USAGE_OF[key]) });
        tile.append(badge);
      }
      strip.append(tile);
    });
    group.append(strip);
    return group;
  };

  // --- drag, icon-style, across the whole board ----------------------------

  const ROWS = ["primary", "nav", "tools"];
  const GAP = 8; // must match the .key-strip gap in style.css

  /**
   * Press a tile and slide it anywhere — within its row or onto another row.
   * The grabbed tile rides a transform so it stays in flow (its row keeps its
   * width), while the tiles it passes slide out of the way per row: the row it
   * left closes up behind it, the row it is entering opens a slot. The order
   * is committed on release. Pointer capture + `touch-action: none` keep the
   * page from scrolling instead.
   */
  function startDrag(e, tile) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    const originRow = tile.dataset.row;
    const strips = Object.fromEntries(
      ROWS.map((r) => [r, list.querySelector(`.key-strip[data-row="${r}"]`)]),
    );
    const tiles = Object.fromEntries(
      ROWS.map((r) => [r, [...strips[r].querySelectorAll(".key-tile")]]),
    );
    const originIndex = tiles[originRow].indexOf(tile);
    const width = tile.offsetWidth + GAP;
    const height = tile.offsetHeight + GAP;
    const startX = e.clientX;
    const startY = e.clientY;
    // Where the tile sits in the board, for centre-based drop targeting.
    const boardRect = list.getBoundingClientRect();
    const startLeft = tile.getBoundingClientRect().left - boardRect.left;
    const startTop = tile.getBoundingClientRect().top - boardRect.top;
    let targetRow = originRow;
    let targetIndex = originIndex;
    let moved = false;

    tile.classList.add("dragging");
    // The whole board stops selecting text while the drag is in flight (a
    // long press would otherwise become an iOS text selection), and the
    // browser's native drag must not hijack the gesture.
    document.body.classList.add("no-select");
    tile.setAttribute("draggable", "false");
    const onDragStart = (ev) => ev.preventDefault();
    tile.addEventListener("dragstart", onDragStart);
    tiles[originRow].forEach((t) => {
      if (t !== tile) t.style.transition = "transform .12s ease";
    });

    /** Row whose vertical band the given board-centre is closest to. */
    const rowAt = (cy) => {
      let best = originRow;
      let bestDist = Infinity;
      for (const r of ROWS) {
        const rect = strips[r].getBoundingClientRect();
        const d = cy < rect.top ? rect.top - cy : cy > rect.bottom ? cy - rect.bottom : 0;
        if (d < bestDist) {
          bestDist = d;
          best = r;
        }
      }
      return best;
    };

    /** Slot in a row whose centre the given board-x is closest to. */
    const indexAt = (r, cx) => {
      const stripLeft = strips[r].getBoundingClientRect().left;
      const items = tiles[r];
      for (let i = 0; i < items.length; i++) {
        if (i === originIndex && r === originRow) continue; // the grabbed tile
        const center = stripLeft + items[i].offsetLeft + items[i].offsetWidth / 2;
        if (cx < center) return i;
      }
      return items.length;
    };

    const onMove = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      ev.preventDefault();
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.abs(dx) < 6 && Math.abs(dy) < 6) return; // not a tap
      moved = true;
      tile.style.transform = `translate(${dx}px, ${dy}px)`;
      const cx = startLeft + width / 2 + dx;
      const cy = startTop + height / 2 + dy;
      const r = rowAt(boardRect.top + cy);
      const i = indexAt(r, boardRect.left + cx);
      if (r === targetRow && i === targetIndex) return;
      targetRow = r;
      targetIndex = i;
      // Clear the previous layout, then shift the two affected rows.
      for (const rr of ROWS) {
        tiles[rr].forEach((t) => {
          if (t !== tile) t.style.transform = "";
        });
      }
      if (targetRow === originRow) {
        // Within one row: the tiles between the slots slide one place.
        const lo = Math.min(originIndex, targetIndex);
        const hi = Math.max(originIndex, targetIndex);
        const dir = targetIndex > originIndex ? -1 : 1;
        tiles[originRow].forEach((t, i) => {
          if (t === tile) return;
          t.style.transform = i > lo && i <= hi ? `translateX(${dir * width}px)` : "";
        });
      } else {
        // Across rows: the old row closes up, the new row opens a slot.
        tiles[originRow].forEach((t, i) => {
          if (t === tile || i <= originIndex) t.style.transform = "";
          else t.style.transform = `translateX(${-width}px)`;
        });
        tiles[targetRow].forEach((t, i) => {
          if (t === tile) t.style.transform = "";
          else if (i >= targetIndex) t.style.transform = `translateX(${width}px)`;
        });
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
      tile.removeEventListener("dragstart", onDragStart);
      tile.classList.remove("dragging");
      document.body.classList.remove("no-select");
      tile.style.transform = "";
      for (const r of ROWS) {
        tiles[r].forEach((t) => {
          if (t !== tile) t.style.transform = "";
        });
      }
      if (revert || (targetRow === originRow && targetIndex === originIndex)) return;
      const keys = layout[originRow];
      const [key] = keys.splice(originIndex, 1);
      layout[targetRow].splice(targetIndex, 0, key);
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
    for (const row of ROWS) list.append(renderGroup(row));
  };
  list.addEventListener("pointerdown", (e) => {
    const tile = e.target.closest(".key-tile");
    if (tile) startDrag(e, tile);
  });

  // Fetch the counts first (they change nothing about the ordering), then draw.
  fetch(url("api/key-usage"))
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
