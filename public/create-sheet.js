import { filterEntries, splitPath } from "./dir-filter.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const ERRORS = {
  baddir: "这个目录用不了",
  empty: "名字不能只有空格",
  reserved: "这个名字是内部保留的",
  invalid: "名字里不能有 . 或 :",
  failed: "创建失败，请重试",
};

/**
 * The dialog for starting a new Claude Code session.
 *
 * Directory first, name second: nearly every session lives in the same project,
 * so the common path is to accept the default directory and type nothing but a
 * ticket number — or not even that, since the name is optional.
 *
 * Browsing is tap-driven rather than typed. Reaching a new directory on a phone
 * by typing its full path is miserable, so the list below the field drills down
 * a level per tap and the field only filters what is already on screen.
 */
export function openCreateSheet() {
  const backdrop = el("div", "sheet-backdrop");
  const sheet = el("div", "sheet");
  sheet.append(el("h2", null, "新建会话"));

  const favourites = el("div", "chips");
  const crumb = el("div", "crumb");
  const filter = el("input", "field");
  filter.placeholder = "筛选目录";
  filter.autocapitalize = "none";
  filter.autocomplete = "off";

  const list = el("div", "dir-list");
  const nameField = el("input", "field");
  nameField.placeholder = "会话名（选填，如 PROJ-1088）";
  nameField.autocapitalize = "none";
  nameField.autocomplete = "off";

  const error = el("p", "sheet-error");
  const actions = el("div", "sheet-actions");
  const cancel = el("button", "btn", "取消");
  const submit = el("button", "btn primary", "创建");
  actions.append(cancel, submit);

  sheet.append(favourites, crumb, filter, list, nameField, error, actions);
  backdrop.append(sheet);
  document.body.append(backdrop);

  let home = "";
  let current = null;
  let entries = [];

  const close = () => backdrop.remove();
  cancel.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  function drawList() {
    const matches = filterEntries(entries, filter.value);
    if (!matches.length) {
      list.replaceChildren(el("p", "dir-empty", entries.length ? "没有匹配的目录" : "没有子目录"));
      return;
    }
    list.replaceChildren(
      ...matches.map((entry) => {
        const row = el("button", "dir-row", entry.name);
        row.addEventListener("click", () => browse(entry.path));
        return row;
      }),
    );
  }

  function drawCrumb(parent) {
    crumb.replaceChildren();
    if (parent) {
      const up = el("button", "up", "↑ 上级");
      up.addEventListener("click", () => browse(parent));
      crumb.append(up);
    }
    // `lead`, not `parent`: the enclosing parameter already holds the path the
    // up button navigates to, which is a different thing from the dimmed text.
    const { parent: lead, leaf } = splitPath(current, home);
    const path = el("span", "crumb-path");
    if (lead) path.append(el("span", "crumb-lead", lead));
    path.append(el("span", "crumb-leaf", leaf));
    crumb.append(path);
  }

  async function browse(path) {
    error.textContent = "";
    let res;
    try {
      res = await fetch(`api/dirs?path=${encodeURIComponent(path)}`);
    } catch {
      error.textContent = "无法连接到服务";
      return;
    }
    if (!res.ok) {
      error.textContent = "这个目录不让访问";
      return;
    }
    const body = await res.json();
    current = body.path;
    entries = body.entries;
    // A fresh level starts unfiltered; the old query rarely matches here.
    filter.value = "";
    drawCrumb(body.parent);
    drawList();
    markFavourite();
  }

  function markFavourite() {
    for (const chip of favourites.children) {
      chip.classList.toggle("on", chip.dataset.path === current);
    }
  }

  filter.addEventListener("input", drawList);

  submit.addEventListener("click", async () => {
    if (!current) return;
    submit.disabled = true;
    submit.textContent = "创建中…";
    error.textContent = "";

    const name = nameField.value.trim();
    let res;
    try {
      res = await fetch("api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(name ? { dir: current, name } : { dir: current }),
      });
    } catch {
      error.textContent = "无法连接到服务";
      submit.disabled = false;
      submit.textContent = "创建";
      return;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      error.textContent = ERRORS[body.error] ?? "创建失败";
      submit.disabled = false;
      submit.textContent = "创建";
      return;
    }

    const body = await res.json();
    location.href = `terminal.html?target=${encodeURIComponent(body.name)}`;
  });

  // Populate: favourites drive the default directory, so they load first.
  (async () => {
    let dirs = [];
    try {
      const body = await (await fetch("api/directories")).json();
      home = body.home;
      dirs = body.recent;
    } catch {
      error.textContent = "无法连接到服务";
      return;
    }

    favourites.replaceChildren(
      ...dirs.slice(0, 6).map((path) => {
        const chip = el("button", "chip", path.slice(path.lastIndexOf("/") + 1) || path);
        chip.dataset.path = path;
        chip.title = path;
        chip.addEventListener("click", () => browse(path));
        return chip;
      }),
    );

    // With no sessions yet there is nothing to rank, so start from home.
    if (dirs[0] ?? home) await browse(dirs[0] ?? home);
  })();
}
