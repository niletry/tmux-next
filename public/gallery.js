// @ts-check
// The drop-folder gallery: shows what's in ~/.tmux-next/gallery — images and
// HTML/SVG rendered in place, anything else offered to download. The viewer
// pages through items directly, without going back to the grid each time.

import { initLang, tr } from "./i18n-apply.js";
import { renderHeader } from "./nav.js";

const listEl = /** @type {HTMLElement} */ (document.getElementById("gallery"));
/**
 * Looked up on use, not at module load.
 *
 * The element lives inside the active nav segment now, and renderNav creates it
 * — so a reference taken at the top of the module would be null on any page
 * whose nav is rendered later.
 */
const setCount = (/** @type {string} */ text) => {
  const el = document.getElementById("count");
  if (el) el.textContent = text;
};
const viewer = /** @type {HTMLElement} */ (document.getElementById("viewer"));

/** @typedef {{ name: string, kind: "image" | "html" | "other" }} Item */

const fileUrl = (/** @type {string} */ name) => "api/gallery/file?name=" + encodeURIComponent(name);
const ext = (/** @type {string} */ name) => (name.match(/\.([^.]+)$/)?.[1] ?? tr("gallery.file")).toUpperCase();

/** @type {Item[]} */
let items = [];
let viewerIndex = -1;

async function load() {
  try {
    items = await (await fetch("api/gallery")).json();
  } catch {
    listEl.innerHTML = `<p class="empty">${tr("gallery.loadFailed")}</p>`;
    return;
  }

  setCount(items.length ? tr("gallery.count", { n: items.length }) : "");
  if (!items.length) {
    listEl.innerHTML =
      `<p class="empty">${tr("gallery.empty")}<br>` +
      `<span class="ghint">${tr("gallery.emptyHint")} <code>~/.tmux-next/gallery/</code></span></p>`;
    return;
  }

  const grid = document.createElement("div");
  grid.className = "gal-grid";
  items.forEach((item, i) => {
    const cell = document.createElement("button");
    cell.className = "gal-cell";
    cell.addEventListener("click", () => openViewer(i));

    if (item.kind === "image") {
      const img = document.createElement("img");
      img.className = "gal-thumb";
      img.loading = "lazy";
      img.src = fileUrl(item.name);
      img.alt = item.name;
      cell.append(img);
    } else {
      const badge = document.createElement("div");
      badge.className = "gal-badge";
      badge.textContent = item.kind === "html" ? "HTML" : ext(item.name);
      cell.append(badge);
    }

    const cap = document.createElement("div");
    cap.className = "gal-name";
    cap.textContent = item.name;
    cell.append(cap);
    grid.append(cell);
  });
  listEl.replaceChildren(grid);
}

function openViewer(/** @type {number} */ index) {
  viewerIndex = index;
  renderViewer();
  viewer.hidden = false;
}

/** Moves to the previous/next artifact, wrapping around the ends. */
function step(/** @type {number} */ delta) {
  if (items.length < 2) return;
  viewerIndex = (viewerIndex + delta + items.length) % items.length;
  renderViewer();
}

function navButton(/** @type {string} */ glyph, /** @type {() => void} */ onClick) {
  const b = document.createElement("button");
  b.className = "viewer-nav " + (glyph === "‹" ? "prev" : "next");
  b.textContent = glyph;
  b.setAttribute("aria-label", tr(glyph === "‹" ? "gallery.prev" : "gallery.next"));
  b.addEventListener("click", onClick);
  return b;
}

/** A horizontal swipe pages through — handy for images (an iframe eats its own touches). */
function addSwipe(/** @type {HTMLElement} */ el) {
  let x0 = /** @type {number | null} */ (null);
  el.addEventListener(
    "touchstart",
    (e) => {
      x0 = e.touches.length === 1 ? e.touches[0].clientX : null;
    },
    { passive: true },
  );
  el.addEventListener("touchend", (e) => {
    if (x0 === null) return;
    const dx = (e.changedTouches[0]?.clientX ?? x0) - x0;
    x0 = null;
    if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
  });
}

function renderViewer() {
  const item = items[viewerIndex];
  if (!item) return;

  const bar = document.createElement("div");
  bar.className = "viewer-bar";
  const close = document.createElement("button");
  close.className = "viewer-close";
  close.textContent = tr("gallery.close");
  close.addEventListener("click", closeViewer);
  const name = document.createElement("span");
  name.className = "viewer-name";
  name.textContent = item.name;
  const count = document.createElement("span");
  count.className = "viewer-count";
  count.textContent = `${viewerIndex + 1} / ${items.length}`;
  const dl = document.createElement("a");
  dl.className = "viewer-dl";
  dl.href = fileUrl(item.name);
  dl.setAttribute("download", item.name);
  dl.textContent = tr("gallery.download");
  bar.append(close, name, count, dl);

  const body = document.createElement("div");
  body.className = "viewer-body";
  if (item.kind === "image") {
    const img = document.createElement("img");
    img.className = "viewer-img";
    img.src = fileUrl(item.name);
    img.alt = item.name;
    body.append(img);
    addSwipe(body);
  } else if (item.kind === "html") {
    const frame = document.createElement("iframe");
    frame.className = "viewer-frame";
    // Rendered but walled off: allow-scripts without allow-same-origin gives the
    // page an opaque origin, so charts run but nothing can reach this app's
    // cookies or DOM.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.src = fileUrl(item.name);
    body.append(frame);
  } else {
    const note = document.createElement("p");
    note.className = "viewer-note";
    note.textContent = tr("gallery.noPreview");
    body.append(note);
  }

  /** @type {HTMLElement[]} */
  const parts = [bar, body];
  if (items.length > 1) parts.push(navButton("‹", () => step(-1)), navButton("›", () => step(1)));
  viewer.replaceChildren(...parts);
}

function closeViewer() {
  viewer.hidden = true;
  viewerIndex = -1;
  viewer.replaceChildren();
}

document.addEventListener("keydown", (e) => {
  if (viewer.hidden) return;
  if (e.key === "Escape") closeViewer();
  else if (e.key === "ArrowLeft") step(-1);
  else if (e.key === "ArrowRight") step(1);
});

// Language first: the empty and error states are rendered from it.
initLang().then(() => {
  renderHeader("gallery");
  load();
});
