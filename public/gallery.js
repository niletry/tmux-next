// @ts-check
// The drop-folder gallery: shows what's in ~/.tmux-next/gallery — images and
// HTML/SVG rendered in place, anything else offered to download.

const listEl = /** @type {HTMLElement} */ (document.getElementById("gallery"));
const countEl = /** @type {HTMLElement} */ (document.getElementById("count"));
const viewer = /** @type {HTMLElement} */ (document.getElementById("viewer"));

/** @typedef {{ name: string, kind: "image" | "html" | "other" }} Item */

const fileUrl = (/** @type {string} */ name) => "api/gallery/file?name=" + encodeURIComponent(name);
const ext = (/** @type {string} */ name) => (name.match(/\.([^.]+)$/)?.[1] ?? "文件").toUpperCase();

async function load() {
  let items;
  try {
    items = await (await fetch("api/gallery")).json();
  } catch {
    listEl.innerHTML = '<p class="empty">加载失败</p>';
    return;
  }

  countEl.textContent = items.length ? `${items.length} 项` : "";
  if (!items.length) {
    listEl.innerHTML =
      '<p class="empty">还没有制品<br>' +
      '<span class="ghint">把图片 / HTML / SVG 放进 <code>~/.tmux-next/gallery/</code></span></p>';
    return;
  }

  const grid = document.createElement("div");
  grid.className = "gal-grid";
  for (const item of items) {
    const cell = document.createElement("button");
    cell.className = "gal-cell";
    cell.addEventListener("click", () => openViewer(item));

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
  }
  listEl.replaceChildren(grid);
}

function openViewer(/** @type {Item} */ item) {
  const bar = document.createElement("div");
  bar.className = "viewer-bar";
  const close = document.createElement("button");
  close.className = "viewer-close";
  close.textContent = "‹ 关闭";
  close.addEventListener("click", closeViewer);
  const name = document.createElement("span");
  name.className = "viewer-name";
  name.textContent = item.name;
  const dl = document.createElement("a");
  dl.className = "viewer-dl";
  dl.href = fileUrl(item.name);
  dl.setAttribute("download", item.name);
  dl.textContent = "下载";
  bar.append(close, name, dl);

  const body = document.createElement("div");
  body.className = "viewer-body";
  if (item.kind === "image") {
    const img = document.createElement("img");
    img.className = "viewer-img";
    img.src = fileUrl(item.name);
    img.alt = item.name;
    body.append(img);
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
    note.textContent = "这个类型不支持预览，点右上「下载」查看。";
    body.append(note);
  }

  viewer.replaceChildren(bar, body);
  viewer.hidden = false;
}

function closeViewer() {
  viewer.hidden = true;
  viewer.replaceChildren();
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !viewer.hidden) closeViewer();
});

load();
