// The Jira issues page: what's assigned to you, grouped by issue, with the
// sessions started against each one listed underneath it. An issue is not a
// session — the same key can have several, because a workaround (naming a
// session after the issue key) forced one-session-per-issue before this
// existed — so every issue renders as a group and the button beside it always
// says "start another", never "open".
//
// Not @ts-check'd: its import specifiers are written for the URL the browser
// resolves them against (this file is served at /p/jira/jira.js, two segments
// deep), not the filesystem path it lives at (plugins/jira/public/jira.js,
// three segments deep) — tsc's module resolver only knows the latter and
// can't follow "../../i18n-apply.js" to the real public/i18n-apply.js. Same
// exemption as list.js, terminal.js and gallery.js.

import { initLang, tr } from "../../i18n-apply.js";
import { renderHeader } from "../../nav.js";
import { url } from "../../root.js";
import { filterEntries, shortPath } from "../../dir-filter.js";

const mainEl = /** @type {HTMLElement} */ (document.getElementById("issues"));

/**
 * Looked up on use, not at module load — the element lives inside the active
 * nav segment and renderHeader creates it, so a reference taken up front would
 * be null on a page whose nav renders later.
 */
const setCount = (/** @type {string} */ text) => {
  const el = document.getElementById("count");
  if (el) el.textContent = text;
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Maps an `issues` failure reason to one of the four fixed messages — never the raw reason. */
const REASON_MESSAGE = {
  auth: () => tr("jira.authFailed"),
  query: () => tr("jira.queryFailed"),
  unreachable: () => tr("jira.unreachable"),
  unconfigured: () => tr("jira.unconfigured"),
};

/** @type {{ key: string, summary: string, status: string, statusCategory: string, updated: string }[]} */
let issues = [];
/** @type {{ session: string, key: string, live: boolean }[]} */
let bindings = [];

function bindingsFor(key) {
  return bindings.filter((b) => b.key === key);
}

function renderEmpty(message, hint) {
  const p = el("p", "empty", message);
  if (hint) {
    p.append(document.createElement("br"), el("span", "ghint", hint));
  }
  mainEl.replaceChildren(p);
}

function sessionRow(binding) {
  const row = el("div", "row jira-session");
  const link = el("a", "jira-session-link", binding.session);
  link.href = url("terminal.html?target=" + encodeURIComponent(binding.session));
  link.title = tr("jira.open");
  if (!binding.live) {
    row.classList.add("note-dim");
    link.append(el("span", "group-count", tr("jira.dead")));
  }
  const unbind = el("button", "btn", tr("jira.unbind"));
  unbind.type = "button";
  unbind.addEventListener("click", async () => {
    unbind.disabled = true;
    try {
      await fetch(url("api/jira/bindings?session=" + encodeURIComponent(binding.session)), {
        method: "DELETE",
      });
    } finally {
      await reloadBindings();
      renderIssues();
    }
  });
  row.append(link, unbind);
  return row;
}

function issueGroup(issue) {
  const group = el("section", "group");
  const head = el("div", "group-head");
  head.append(el("span", "group-name", `${issue.key} · ${issue.summary}`));
  head.append(el("span", "group-count", issue.status));
  group.append(head);

  const sessions = bindingsFor(issue.key);
  if (sessions.length) {
    group.append(el("p", "sheet-sub", tr("jira.sessions", { n: sessions.length })));
    for (const b of sessions) group.append(sessionRow(b));
  } else {
    group.append(el("p", "sheet-sub", tr("jira.noSessions")));
  }

  const startBtn = el("button", "btn primary", sessions.length ? tr("jira.newSession") : tr("jira.firstSession"));
  startBtn.type = "button";
  startBtn.addEventListener("click", () => openCreateSheet(issue, sessions.length > 0));
  group.append(startBtn);

  return group;
}

function toolbar() {
  const bar = el("div", "gal-toolbar");
  const refresh = el("button", "gal-upload-btn", tr("jira.refresh"));
  refresh.type = "button";
  refresh.addEventListener("click", async () => {
    refresh.disabled = true;
    await loadIssues(true);
    refresh.disabled = false;
  });
  bar.append(refresh);
  return bar;
}

function renderIssues() {
  if (!issues.length) {
    setCount("");
    renderEmpty(tr("jira.empty"));
    mainEl.prepend(toolbar());
    return;
  }
  setCount(tr("jira.count", { n: issues.length }));
  mainEl.replaceChildren(toolbar(), ...issues.map(issueGroup));
}

async function reloadBindings() {
  try {
    const body = await (await fetch(url("api/jira/bindings"))).json();
    bindings = body.bindings ?? [];
  } catch {
    bindings = [];
  }
}

/** Renders a failure state that still leaves the refresh button reachable, so a retry is one tap. */
function renderIssuesFailure(message) {
  setCount("");
  renderEmpty(message);
  mainEl.prepend(toolbar());
}

async function loadIssues(refresh) {
  const issuesUrl = refresh ? url("api/jira/issues?refresh=1") : url("api/jira/issues");
  let issuesRes, bindingsBody;
  try {
    [issuesRes, bindingsBody] = await Promise.all([
      fetch(issuesUrl).then((r) => r.json()),
      fetch(url("api/jira/bindings")).then((r) => r.json()),
    ]);
  } catch {
    // A tmux-next-side hiccup (server restart, transient local failure) — not
    // a Jira-side one, but "we could not reach our own server" reads the same
    // to the user as "cannot reach Jira".
    renderIssuesFailure(tr("jira.unreachable"));
    return;
  }
  bindings = bindingsBody.bindings ?? [];

  if (!issuesRes.ok) {
    const message = (REASON_MESSAGE[issuesRes.reason] ?? REASON_MESSAGE.unreachable)();
    renderIssuesFailure(message);
    return;
  }

  issues = issuesRes.issues ?? [];
  renderIssues();
}

// --- create-session overlay --------------------------------------------------

const NAME_ERRORS = {
  reserved: () => tr("jira.nameTaken"),
  invalid: () => tr("jira.nameTaken"),
  // Not a jira.* key: create.baddir already exists (public/i18n.js), is used
  // by new.js for the same server error, and says more than "creation
  // failed" without opening a second dictionary entry for one message.
  baddir: () => tr("create.baddir"),
};

/**
 * The directory picker inside the overlay is deliberately not the full
 * browse-any-subdirectory tree from public/new.js — it filters the recent
 * directories the server already knows about (api/directories), which covers
 * the "start another session for the same project" case this page exists
 * for. Duplicating new.js's whole tree here would be the same UI twice for a
 * case that is already the common one.
 */
function openCreateSheet(issue, hasSessions) {
  const backdrop = el("div", "sheet-backdrop");
  const sheet = el("div", "sheet");
  const heading = hasSessions ? tr("jira.newSession") : tr("jira.firstSession");
  sheet.append(el("h2", null, `${heading} — ${issue.key}`));

  const filter = el("input", "field");
  filter.placeholder = tr("new.filterDirs");
  filter.autocapitalize = "none";
  filter.autocomplete = "off";
  const list = el("div", "dir-list");

  // The recents list (api/directories) only ever contains directories that
  // already have, or recently had, a tmux-next session in them — so an issue
  // whose repository has never had one could not otherwise get a session
  // started from this page at all. A free-text field reaches anywhere the
  // normal new-session page can, without porting its whole drill-down browser
  // (api/dirs) — the server already validates whatever lands here.
  const pathField = el("input", "field");
  pathField.placeholder = tr("jira.dirPath");
  pathField.autocapitalize = "none";
  pathField.autocomplete = "off";

  const nameField = el("input", "field");
  nameField.value = issue.key;
  nameField.autocapitalize = "none";
  nameField.autocomplete = "off";

  const agentRow = el("div", "agent-row");
  let agents = [{ id: "claude", label: "Claude Code", supportsSkipPermissions: true }];
  let chosenAgent = "claude";

  function drawAgents() {
    agentRow.replaceChildren();
    if (agents.length < 2) return;
    for (const a of agents) {
      const btn = el("button", "agent-chip", a.label);
      btn.type = "button";
      if (a.id === chosenAgent) btn.classList.add("on");
      if (a.available === false) {
        btn.classList.add("missing");
        btn.disabled = true;
      }
      btn.addEventListener("click", () => {
        chosenAgent = a.id;
        drawAgents();
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

  const error = el("p", "sheet-error");
  const actions = el("div", "sheet-actions");
  const cancel = el("button", "btn", tr("new.cancel"));
  const submit = el("button", "btn primary", heading);
  actions.append(cancel, submit);

  sheet.append(filter, list, pathField, nameField, agentRow, skipRow, error, actions);
  backdrop.append(sheet);
  document.body.append(backdrop);

  const close = () => backdrop.remove();
  cancel.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  /** @type {{ name: string, path: string }[]} */
  let dirEntries = [];
  let home = "";
  let selected = "";

  function drawList() {
    const matches = filterEntries(dirEntries, filter.value);
    list.replaceChildren(
      ...matches.map((entry) => {
        const row = el("button", "dir-row", shortPath(entry.path, home));
        row.type = "button";
        if (entry.path === selected) row.classList.add("on");
        row.addEventListener("click", () => {
          selected = entry.path;
          pathField.value = "";
          drawList();
        });
        return row;
      }),
    );
  }

  let busy = false;

  submit.addEventListener("click", async () => {
    const dir = pathField.value.trim() || selected;
    if (!dir || busy) return;
    busy = true;
    error.textContent = "";
    submit.disabled = true;

    const payload = { dir, name: nameField.value.trim() || issue.key };
    if (skipBox.checked) payload.skipPermissions = true;
    if (chosenAgent !== "claude") payload.agent = chosenAgent;

    let res;
    try {
      res = await fetch(url("api/sessions"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      error.textContent = tr("jira.createFailed");
      busy = false;
      submit.disabled = false;
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      error.textContent = (NAME_ERRORS[body.error]?.()) ?? tr("jira.createFailed");
      busy = false;
      submit.disabled = false;
      return;
    }
    const created = await res.json();
    try {
      await fetch(url("api/jira/bindings"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: created.name, key: issue.key }),
      });
    } catch {
      // The session exists either way; a missing binding just means it shows
      // up unattached to the issue rather than under it.
    }
    location.href = url("terminal.html?target=" + encodeURIComponent(created.name));
  });

  filter.addEventListener("input", drawList);

  (async () => {
    fetch(url("api/agents"))
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (body?.agents?.length) {
          agents = body.agents;
          // The default may have come back unavailable on this machine; move
          // the selection off it rather than leaving a disabled chip selected.
          const current = agents.find((a) => a.id === chosenAgent);
          if (current && current.available === false) {
            chosenAgent = (agents.find((a) => a.available !== false) || agents[0]).id;
          }
          drawAgents();
        }
      })
      .catch(() => {});

    try {
      const body = await (await fetch(url("api/directories"))).json();
      home = body.home;
      const recent = body.recent ?? [];
      // Home is always offered, even with no recent directories yet — the
      // picker would otherwise have a selection nothing in the list shows.
      const paths = recent.includes(home) ? recent : [home, ...recent];
      dirEntries = paths.map((path) => ({
        name: path.slice(path.lastIndexOf("/") + 1) || path,
        path,
      }));
      selected = dirEntries[0]?.path ?? home;
    } catch {
      error.textContent = tr("jira.createFailed");
    }
    drawList();
  })();
}

// --- page entry --------------------------------------------------------------

initLang().then(async () => {
  await renderHeader("jira");

  let config;
  try {
    config = await (await fetch(url("api/jira/config"))).json();
  } catch {
    config = { configured: false };
  }
  if (!config.configured) {
    renderEmpty(tr("jira.unconfigured"), tr("jira.unconfiguredHint"));
    return;
  }

  await loadIssues();
});
