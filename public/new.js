import { filterEntries, splitPath } from "./dir-filter.js";
import { initLang, tr } from "./i18n-apply.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Same wording as the session list, kept local so the sheet stands alone. */
function relativeTime(epochSeconds) {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (secs < 60) return tr("list.justNow");
  if (secs < 3600) return tr("list.minutesAgo", { n: Math.floor(secs / 60) });
  if (secs < 86400) return tr("list.hoursAgo", { n: Math.floor(secs / 3600) });
  return tr("list.daysAgo", { n: Math.floor(secs / 86400) });
}

const MKDIR_ERRORS = {
  empty: () => tr("mkdir.empty"),
  invalid: () => tr("mkdir.invalid"),
  hidden: () => tr("mkdir.hidden"),
  toolong: () => tr("mkdir.toolong"),
  exists: () => tr("mkdir.exists"),
  badparent: () => tr("mkdir.badparent"),
  failed: () => tr("mkdir.failed"),
};

const ERRORS = {
  baddir: () => tr("create.baddir"),
  empty: () => tr("create.empty"),
  reserved: () => tr("create.reserved"),
  invalid: () => tr("create.invalid"),
  failed: () => tr("create.failed"),
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
export function renderNewSession(root) {
  // The page body stands in for the sheet. Everything below builds the same
  // two screens; what changes is that they are the page rather than a layer
  // over it, so the directory list gets real height and the soft keyboard has
  // somewhere to push.
  const sheet = root;

  // --- screen 1: new session -------------------------------------------------
  const step1 = el("div", "sheet-step");
  step1.append(el("h2", null, tr("new.title")));

  const favourites = el("div", "chips");
  const crumb = el("div", "crumb");
  const filter = el("input", "field");
  filter.placeholder = tr("new.filterDirs");
  filter.autocapitalize = "none";
  filter.autocomplete = "off";

  const list = el("div", "dir-list");

  const nameField = el("input", "field");
  nameField.placeholder = tr("new.namePlaceholder");
  nameField.autocapitalize = "none";
  nameField.autocomplete = "off";

  // Deliberately unchecked every time and never remembered: this hands Claude
  // Code the machine without asking again, so it should be a decision made per
  // session rather than a setting that quietly stays on.
  // Which agent to start. Fetched rather than hard-coded so the list and its
  // capabilities stay in step with the server — notably which agents have a
  // skip-permissions mode at all.
  const agentRow = el("div", "agent-row");
  let agents = [{ id: "claude", label: "Claude Code", supportsSkipPermissions: true }];
  let chosenAgent = "claude";

  function drawAgents() {
    agentRow.replaceChildren();
    if (agents.length < 2) return; // nothing to choose between
    for (const a of agents) {
      const btn = el("button", "agent-chip", a.label);
      btn.type = "button";
      if (a.id === chosenAgent) btn.classList.add("on");
      // Not installed, or not on the login shell's PATH: starting it would make
      // a session that disappears immediately, so say so instead of offering it.
      if (a.available === false) {
        btn.classList.add("missing");
        btn.disabled = true;
        btn.title = tr("new.agentMissing", { label: a.label });
      }
      btn.addEventListener("click", () => {
        chosenAgent = a.id;
        drawAgents();
        // The checkbox is meaningless where the agent has no such mode, and a
        // switch that silently does nothing is worse than no switch.
        const supported = agents.find((x) => x.id === chosenAgent)?.supportsSkipPermissions;
        skipRow.style.display = supported ? "" : "none";
        if (!supported) skipBox.checked = false;
      });
      agentRow.append(btn);
    }
  }

  const skipRow = el("label", "check");
  const skipBox = document.createElement("input");
  skipBox.type = "checkbox";
  skipRow.append(skipBox, el("span", null, tr("new.skipPermissions")));
  skipRow.append(el("b", "check-warn", tr("new.skipWarn")));

  // Shown only when the chosen directory has past conversations; opens screen 2.
  const resumeEntry = el("button", "resume-entry", tr("new.resumeEntry"));
  resumeEntry.style.display = "none";

  step1.append(favourites, crumb, filter, list, nameField, agentRow, skipRow, resumeEntry);

  // --- screen 2: pick a past conversation ------------------------------------
  const step2 = el("div", "sheet-step");
  step2.style.display = "none";
  const back = el("button", "sheet-back", tr("new.backToHistory"));
  const historyBox = el("div", "history");
  step2.append(back, historyBox);

  // --- shared footer ---------------------------------------------------------
  const error = el("p", "sheet-error");
  const actions = el("div", "sheet-actions");
  const cancel = el("button", "btn", tr("new.cancel"));
  const submit = el("button", "btn primary", tr("new.create"));
  actions.append(cancel, submit);

  sheet.append(step1, step2, error, actions);


  let home = "";
  let current = null;
  let entries = [];
  let history = []; // past conversations for `current`
  let busy = false;

  // Leaving is the browser's back, not a close button — the directory you are
  // in is in the URL, so back walks up the path you came down.
  const close = () => history.back();
  cancel.addEventListener("click", close);

  /**
   * Writes the current directory and screen into the address bar.
   *
   * replaceState while browsing down, pushState when switching screens: every
   * directory should be a back step, but re-rendering the same screen should
   * not pile up entries.
   */
  function syncUrl(push) {
    const params = new URLSearchParams();
    if (current) params.set("dir", current);
    if (step === 2) params.set("resume", "1");
    const url = `new.html?${params}`;
    if (url === location.pathname.slice(1) + location.search) return;
    if (push) history.pushState({}, "", url);
    else history.replaceState({}, "", url);
  }

  let step = 1;

  function showStep(n) {
    step = n;
    error.textContent = "";
    step1.style.display = n === 1 ? "" : "none";
    step2.style.display = n === 2 ? "" : "none";
    actions.style.display = n === 1 ? "" : "none";
  }

  /**
   * Whether what is typed in the filter could be a new directory's name.
   *
   * Mirrors the server's validateDirName. Duplicated rather than shared because
   * this only decides whether to *offer* the action — the server re-checks and
   * is the authority. Keeping it in step matters for the offer looking sane,
   * not for safety.
   */
  function offerableName(raw) {
    const name = raw.trim();
    if (!name || name === "." || name === "..") return null;
    if (name.includes("/") || name.includes("\\")) return null;
    if (name.startsWith(".") || name.length > 255) return null;
    return name;
  }

  /**
   * Creates the typed directory inside the one being browsed, then enters it.
   *
   * The name comes from the filter box because that is where it already is: by
   * the time someone sees "no matching directory" they have typed the name they
   * wanted. Asking for it again in a dialog would be asking twice.
   */
  async function createDir(name) {
    error.textContent = "";
    let res;
    try {
      res = await fetch("api/dirs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parent: current, name }),
      });
    } catch {
      error.textContent = tr("new.offline");
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      error.textContent = (MKDIR_ERRORS[body.error]?.() ) ?? tr("new.mkdirFailed");
      return;
    }
    const { path } = await res.json();
    filter.value = "";
    await browse(path);
  }

  function drawList() {
    const matches = filterEntries(entries, filter.value);
    if (!matches.length) {
      const typed = offerableName(filter.value);
      if (typed) {
        const make = el("button", "dir-make");
        make.append(el("span", "dir-make-plus", "＋"), el("span", null, tr("new.makeHere", { name: typed })));
        make.addEventListener("click", () => createDir(typed));
        list.replaceChildren(make);
        return;
      }
      list.replaceChildren(el("p", "dir-empty", tr(entries.length ? "new.noMatch" : "new.noSubdirs")));
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
      const up = el("button", "up", tr("new.parentDir"));
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
      error.textContent = tr("new.offline");
      return;
    }
    if (!res.ok) {
      error.textContent = tr("new.dirForbidden");
      return;
    }
    const body = await res.json();
    current = body.path;
    // The directory is the page's state, so it belongs in the URL: back walks
    // up the path you came down, and the address of a directory can be kept.
    syncUrl();
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
    resumeEntry.textContent = tr("new.resumeEntryCount", { n: history.length });
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
    trigger.textContent = tr(resume ? "new.resuming" : "new.creating");
    error.textContent = "";

    const name = nameField.value.trim();
    const payload = { dir: current };
    if (name) payload.name = name;
    // Only ever sent as true; the server treats anything else as off anyway.
    if (skipBox.checked) payload.skipPermissions = true;
    if (chosenAgent !== "claude") payload.agent = chosenAgent;
    if (resume) payload.resume = resume;

    try {
      const res = await fetch("api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        error.textContent = (ERRORS[body.error]?.()) ?? tr("new.createFailed");
        busy = false;
        trigger.disabled = false;
        trigger.textContent = label;
        return;
      }
      const body = await res.json();
      location.href = `terminal.html?target=${encodeURIComponent(body.name)}`;
    } catch {
      error.textContent = tr("new.offline");
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
    syncUrl(true);
  });
  back.addEventListener("click", () => history.back());

  // Populate: favourites drive the default directory, so they load first.
  (async () => {
    // Not awaited together with the directories: an older server without this
    // endpoint should still give a working sheet with Claude Code only.
    fetch("api/agents")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (body?.agents?.length) {
          agents = body.agents;
          const current = agents.find((a) => a.id === chosenAgent);
          if (current && current.available === false) {
            chosenAgent = (agents.find((a) => a.available !== false) || agents[0]).id;
          }
          drawAgents();
        }
      })
      .catch(() => {});

    let dirs = [];
    try {
      const body = await (await fetch("api/directories")).json();
      home = body.home;
      dirs = body.recent;
    } catch {
      error.textContent = tr("new.offline");
      return;
    }

    const fromUrl = new URLSearchParams(location.search).get("dir");
    if (fromUrl) dirs = [fromUrl, ...dirs.filter((d) => d !== fromUrl)];

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
  
  // The address bar is the source of truth on load: opening
  // new.html?dir=/some/path lands there directly, and back/forward move
  // between the directories visited rather than leaving the page.
  window.addEventListener("popstate", () => {
    const params = new URLSearchParams(location.search);
    const want = params.get("dir");
    showStep(params.get("resume") === "1" ? 2 : 1);
    if (want && want !== current) browse(want);
  });
})();
}


// --- page entry --------------------------------------------------------------

initLang().then(() => {
  renderNewSession(/** @type {HTMLElement} */ (document.getElementById("new")));
});
