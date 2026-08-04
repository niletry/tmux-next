import { filterEntries, splitPath } from "./dir-filter.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Same wording as the session list, kept local so the sheet stands alone. */
function relativeTime(epochSeconds) {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (secs < 60) return "刚刚";
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟前`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} 小时前`;
  return `${Math.floor(secs / 86400)} 天前`;
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
 * Two screens, so only one list is ever on screen at a time. The first is the
 * whole of new-session: directory first, name second — nearly every session
 * lives in the same project, so the common path is to accept the default
 * directory and type nothing but a ticket number, or not even that. The second
 * screen is reached only on demand, to resume a past conversation in the chosen
 * directory instead of starting fresh.
 *
 * Browsing is tap-driven rather than typed. Reaching a new directory on a phone
 * by typing its full path is miserable, so the list drills down a level per tap
 * and the field only filters what is already on screen.
 */
export function openCreateSheet() {
  const backdrop = el("div", "sheet-backdrop");
  const sheet = el("div", "sheet");

  // --- screen 1: new session -------------------------------------------------
  const step1 = el("div", "sheet-step");
  step1.append(el("h2", null, "新建会话"));

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

  // Deliberately unchecked every time and never remembered: this hands Claude
  // Code the machine without asking again, so it should be a decision made per
  // session rather than a setting that quietly stays on.
  const skipRow = el("label", "check");
  const skipBox = document.createElement("input");
  skipBox.type = "checkbox";
  skipRow.append(skipBox, el("span", null, "跳过权限确认"));
  skipRow.append(el("b", "check-warn", "Claude 将无需确认直接执行"));

  // Shown only when the chosen directory has past conversations; opens screen 2.
  const resumeEntry = el("button", "resume-entry", "从历史恢复对话 →");
  resumeEntry.style.display = "none";

  step1.append(favourites, crumb, filter, list, nameField, skipRow, resumeEntry);

  // --- screen 2: pick a past conversation ------------------------------------
  const step2 = el("div", "sheet-step");
  step2.style.display = "none";
  const back = el("button", "sheet-back", "‹ 选一段历史对话");
  const historyBox = el("div", "history");
  step2.append(back, historyBox);

  // --- shared footer ---------------------------------------------------------
  const error = el("p", "sheet-error");
  const actions = el("div", "sheet-actions");
  const cancel = el("button", "btn", "取消");
  const submit = el("button", "btn primary", "创建");
  actions.append(cancel, submit);

  sheet.append(step1, step2, error, actions);
  backdrop.append(sheet);
  document.body.append(backdrop);

  let home = "";
  let current = null;
  let entries = [];
  let history = []; // past conversations for `current`
  let busy = false;

  const close = () => backdrop.remove();
  cancel.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  function showStep(n) {
    error.textContent = "";
    step1.style.display = n === 1 ? "" : "none";
    step2.style.display = n === 2 ? "" : "none";
    actions.style.display = n === 1 ? "" : "none";
  }

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
    // Not awaited: the directory shows at once, the resume entry appears if the
    // directory turns out to have history.
    refreshHistory(current);
  }

  // Fetches the directory's past conversations so screen 2 can show them, and
  // reveals the entry button only when there is something to resume.
  async function refreshHistory(dir) {
    history = [];
    resumeEntry.style.display = "none";
    let conversations;
    try {
      const res = await fetch(`api/history?dir=${encodeURIComponent(dir)}`);
      if (!res.ok) return; // history is optional; a failure just hides the entry
      ({ conversations } = await res.json());
    } catch {
      return;
    }
    // A later browse() may have moved on while this was in flight.
    if (dir !== current || !conversations || !conversations.length) return;
    history = conversations;
    resumeEntry.textContent = `从历史恢复对话 (${history.length}) →`;
    resumeEntry.style.display = "";
  }

  function renderHistory() {
    historyBox.replaceChildren();
    for (const c of history) {
      const row = el("button", "hist-row");
      row.append(el("span", "hist-title", c.title || c.id.slice(0, 8)));
      row.append(el("span", "hist-time", relativeTime(c.mtime)));
      row.addEventListener("click", () => create(c.id, row));
      historyBox.append(row);
    }
  }

  function markFavourite() {
    for (const chip of favourites.children) {
      chip.classList.toggle("on", chip.dataset.path === current);
    }
  }

  // The one create path, for both a fresh session and a resumed one. `resume`
  // is a conversation id or null; the directory, name, and skip choice come
  // from screen 1 either way.
  async function create(resume, trigger) {
    if (!current || busy) return;
    busy = true;
    const label = trigger.textContent;
    trigger.disabled = true;
    trigger.textContent = resume ? "恢复中…" : "创建中…";
    error.textContent = "";

    const name = nameField.value.trim();
    const payload = { dir: current };
    if (name) payload.name = name;
    // Only ever sent as true; the server treats anything else as off anyway.
    if (skipBox.checked) payload.skipPermissions = true;
    if (resume) payload.resume = resume;

    try {
      const res = await fetch("api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        error.textContent = ERRORS[body.error] ?? "创建失败";
        busy = false;
        trigger.disabled = false;
        trigger.textContent = label;
        return;
      }
      const body = await res.json();
      location.href = `terminal.html?target=${encodeURIComponent(body.name)}`;
    } catch {
      error.textContent = "无法连接到服务";
      busy = false;
      trigger.disabled = false;
      trigger.textContent = label;
    }
  }

  filter.addEventListener("input", drawList);
  submit.addEventListener("click", () => create(null, submit));
  resumeEntry.addEventListener("click", () => {
    renderHistory();
    showStep(2);
  });
  back.addEventListener("click", () => showStep(1));

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
