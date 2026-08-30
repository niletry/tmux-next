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
import { pickSessionName } from "./session-name.js";

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
/** issue id -> { ok: true, prs } | { ok: false, reason }。取不到就是没有，不是错误页。 */
let dev = {};

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

/**
 * One PR's checks, summed up.
 *
 * Counts, not a verdict: which check matters is the reader's call, and a green
 * tick painted over a failed one would be this page lying to make itself tidy.
 * "Not asked" stays distinct from "none" for the same reason — one is a fact
 * about the PR, the other is a fact about us.
 */
function checksSummary(pr) {
  if (!pr.checksKnown) return el("span", "jira-ci unknown", "\u2014");
  if (!pr.checks.length) return el("span", "jira-ci none", tr("jira.ciNone"));

  const bad = pr.checks.filter((c) => c.state === "FAILED" || c.state === "STOPPED").length;
  const running = pr.checks.filter((c) => c.state === "INPROGRESS").length;
  const good = pr.checks.length - bad - running;

  const wrap = el("span", "jira-ci");
  if (good) wrap.append(el("span", "jira-ci-ok", "\u2713" + good));
  if (running) wrap.append(el("span", "jira-ci-run", "\u25cf" + running));
  if (bad) wrap.append(el("span", "jira-ci-bad", "\u2717" + bad));
  // Per-check detail has to live somewhere reachable; a title costs the layout
  // nothing, and the counts already carry the part you read at a glance.
  wrap.title = pr.checks.map((c) => c.name + ": " + c.state).join("\n");
  return wrap;
}

/** A PR's state colours itself the way an issue status does: open live, merged calm. */
function prTone(status) {
  if (status === "OPEN") return "jira-pr-state on";
  if (status === "MERGED") return "jira-pr-state done";
  return "jira-pr-state";
}

/** One PR, linking out to Bitbucket. Status words come from Jira as they are. */
function prRow(pr) {
  const row = el("a", "jira-pr");
  row.href = pr.url;
  row.target = "_blank";
  row.rel = "noopener noreferrer";
  row.append(el("span", "jira-pr-id", "#" + pr.id));
  if (pr.status) row.append(el("span", prTone(pr.status), pr.status));
  if (pr.branch) row.append(el("span", "jira-pr-branch", pr.branch));
  row.append(checksSummary(pr));
  return row;
}

/**
 * One session bound to an issue.
 *
 * The name owns the row and truncates; unbinding is a small icon button off to
 * the right rather than a text button, because a text button per row turns a
 * card with three sessions into a wall of buttons. Same reasoning and the same
 * 36px target as the list page's `.more`.
 */
function sessionRow(binding) {
  const row = el("div", binding.live ? "jira-session" : "jira-session stopped");

  const link = el("a", "jira-session-link", binding.session);
  link.href = url("terminal.html?target=" + encodeURIComponent(binding.session));
  link.title = tr("jira.open");
  row.append(link);

  if (!binding.live) row.append(el("span", "jira-dead", tr("jira.dead")));

  const unbind = el("button", "jira-unbind", "\u00d7");
  unbind.type = "button";
  unbind.title = tr("jira.unbind");
  unbind.setAttribute("aria-label", tr("jira.unbind"));
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
  row.append(unbind);
  return row;
}

/**
 * The type badge's class.
 *
 * Colour comes from the hierarchy level, not the type name: an instance can
 * rename its types but cannot renumber the levels, so an epic stays an epic
 * here even where it is called something else. The name is only the label.
 *
 * A bug is the one exception worth a colour of its own, matched loosely on the
 * name and degrading to neutral when it does not match — a wrong guess costs a
 * grey badge, which is what everything else gets anyway.
 */
function typeTone(issue) {
  if (issue.hierarchy >= 1) return "jira-type epic";
  if (issue.hierarchy <= -1) return "jira-type sub";
  if (/^bugs?$/i.test(issue.type.trim())) return "jira-type bug";
  return "jira-type";
}

/** Status reads as a colour as well as a word: in progress accented, done calm, the rest neutral. */
function statusTone(category) {
  if (category === "done") return "jira-status done";
  if (category === "indeterminate") return "jira-status on";
  return "jira-status";
}

/**
 * One issue, as a card.
 *
 * A card, not a `.group-head`: that class is this app's label for a directory —
 * uppercase, dim, 0.78rem, single-line — and an issue summary put through it
 * came out as a truncated grey whisper. `.card` is what this app uses for a
 * thing you act on, and an issue is exactly that.
 *
 * The summary is the part you actually read, so it gets body size and two lines
 * before it clips; the key is an identifier and gets the accent and the tabular
 * figures that say so.
 */
function issueGroup(issue) {
  const card = el("section", "jira-card");

  const head = el("div", "jira-head");
  // Sub-tasks carry the arrow because their indentation cannot survive a flat
  // list — the badge is the only place left to say "this hangs off something".
  if (issue.type) {
    head.append(el("span", typeTone(issue), issue.hierarchy <= -1 ? "\u21b3 " + issue.type : issue.type));
  }
  head.append(el("span", "jira-key", issue.key));
  if (issue.status) head.append(el("span", statusTone(issue.statusCategory), issue.status));

  // Refreshing one issue rather than all of them: watching a PR's CI finish is a
  // single-issue errand, and a full sweep is a dev-status call per issue plus one
  // per PR — a hundred requests to answer a question about one card.
  const again = el("button", "jira-again", "\u21bb");
  again.type = "button";
  again.title = tr("jira.refreshOne");
  again.setAttribute("aria-label", tr("jira.refreshOne"));
  again.addEventListener("click", async () => {
    again.disabled = true;
    try {
      await loadDevOne(issue.id);
    } finally {
      renderIssues();
    }
  });
  head.append(again);

  card.append(head);

  if (issue.summary) card.append(el("p", "jira-summary", issue.summary));

  const entry = dev[issue.id];
  if (entry && entry.ok && entry.prs.length) {
    const prs = el("div", "jira-prs");
    for (const pr of entry.prs) prs.append(prRow(pr));
    card.append(prs);
  }

  const sessions = bindingsFor(issue.key);
  if (sessions.length) {
    const list = el("div", "jira-sessions");
    for (const b of sessions) list.append(sessionRow(b));
    card.append(list);
  }

  // Always "start another", never "open": one issue having several sessions is
  // the normal case here, not an edge one. There is no "no sessions yet" line —
  // the absence is already visible, and the button says what to do about it.
  const startBtn = el("button", "jira-start");
  startBtn.type = "button";
  startBtn.append(
    el("span", "jira-plus", "\uff0b"),
    el("span", null, sessions.length ? tr("jira.newSession") : tr("jira.firstSession")),
  );
  startBtn.addEventListener("click", () => startSession(issue, sessions.map((b) => b.session)));
  card.append(startBtn);

  return card;
}

function toolbar() {
  const bar = el("div", "jira-toolbar");
  const refresh = el("button", "jira-refresh", tr("jira.refresh"));
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

/** Every issue's PRs. Cheap when not refreshing — the server caches it. */
async function loadDev(refresh) {
  try {
    const res = await fetch(url("api/jira/dev" + (refresh ? "?refresh=1" : "")));
    const body = await res.json();
    dev = body.dev ?? {};
  } catch {
    // PRs are extra detail on top of the issue list; failing to get them must
    // not take the page down with it.
    dev = {};
  }
}

/** One issue only — what you actually want while waiting on one PR's build. */
async function loadDevOne(issueId) {
  try {
    const res = await fetch(url("api/jira/dev?refresh=1&id=" + encodeURIComponent(issueId)));
    const body = await res.json();
    Object.assign(dev, body.dev ?? {});
  } catch {
    // Same as above: this card keeps whatever it had, which beats an error page.
  }
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
  await loadDev(refresh);
  renderIssues();
}

// --- create-session overlay --------------------------------------------------

/**
 * Hand the user to the kernel's own new-session page.
 *
 * This page used to carry its own create overlay, which meant a second, weaker
 * directory picker: recents plus a typed path, with no browsing and no way to
 * make a directory. Creating a session from an issue is supposed to take the
 * same parameters as creating one by hand, and the only honest way to promise
 * that is to use the same page.
 *
 * `return` brings control back here afterwards so the binding gets written —
 * the kernel never learns what a Jira issue is, it only honours an address it
 * was handed. new.html refuses anything that could leave this origin.
 *
 * The proposed name is a default, not a decision: the field stays editable, and
 * for an issue that already has sessions it is the first free `-2`, `-3`, … so
 * a second tap does not land on the first session's name.
 */
function startSession(issue, taken) {
  const back = `p/jira/?bind=${encodeURIComponent(issue.key)}`;
  const params = new URLSearchParams({
    name: pickSessionName(issue.key, taken),
    return: back,
  });
  location.href = url(`new.html?${params}`);
}

/**
 * Coming back from new.html: record what the new session is for, then step out
 * of the way into the terminal.
 *
 * The binding is written before navigating and its failure is swallowed on
 * purpose — the session exists either way, and stranding someone on a blank
 * issues page because a small bookkeeping write failed would be the worse of
 * the two outcomes. An unrecorded session shows up unbound, which is visible
 * and fixable; a lost session is neither.
 */
async function finishReturn(bind, created) {
  try {
    await fetch(url("api/jira/bindings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: created, key: bind }),
    });
  } catch {
    // deliberately ignored — see above
  }
  location.replace(url("terminal.html?target=" + encodeURIComponent(created)));
}

// --- page entry --------------------------------------------------------------

initLang().then(async () => {
  // Handled before anything is drawn: this is a hand-off, not a page visit, and
  // painting the issue list first would flash a screen nobody asked to see.
  const q = new URLSearchParams(location.search);
  const bind = q.get("bind");
  const created = q.get("created");
  if (bind && created) {
    await finishReturn(bind, created);
    return;
  }

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
