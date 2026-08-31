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
import { refreshState } from "./refresh-state.js";

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
/**
 * 这个 Jira 实例的地址，从 /api/jira/config 来，不写死。
 *
 * 空字符串表示还没拿到——那种情况下单号退回纯文字：一个指向 undefined/browse/… 的
 * 链接比没有链接更糟。
 */
let instanceUrl = "";
/**
 * 每个单的 PR 数据是什么时候被接受的。
 *
 * 全量加载要十几秒，单单刷新一秒多。没有这个时间戳，在全量还没回来的窗口里点一次
 * 单单刷新，等全量落地时会把刚刷到的新数据整个盖回旧的——正是"刷新完了没更新"。
 */
let devAt = {};
/**
 * 正在刷新的单，以及上次刷新失败的单。
 *
 * 按钮的状态必须从这里推导，不能靠往 DOM 节点上挂 class：renderIssues() 是整体
 * 重画，任何一次重画（比如慢半拍的全量加载回来了）都会把正在转的那个按钮连同它
 * 的状态一起销毁重建。存在模块状态里，重画之后能原样还原。
 */
const refreshing = new Set();
const refreshFailed = new Set();

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

  // A terminal glyph, because without it a session is a line of text among
  // lines of text: the PR rows above it and the summary above those are all set
  // the same way, and the eye has nothing to catch on. Shape does that work
  // before any reading starts.
  const icon = el("span", "jira-session-icon");
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="4" width="18" height="16" rx="2"/>' +
    '<path d="m7.5 10 2.5 2.5-2.5 2.5"/>' +
    '<path d="M13 15h3.5"/>' +
    "</svg>";
  row.append(icon);

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
 * An issue key that opens the issue in Jira.
 *
 * The instance address comes from the server's config rather than being written
 * here: this page has no business knowing which Jira it is talking to, and a
 * hard-coded host would be both wrong for anyone else and one more real name in
 * a public repository.
 *
 * With no address yet it degrades to plain text — a link to `undefined/browse/X`
 * is worse than no link, because it looks tappable and goes nowhere.
 */
function issueLink(key, className) {
  if (!instanceUrl) return el("span", className, key);
  const a = el("a", className, key);
  a.href = `${instanceUrl}/browse/${encodeURIComponent(key)}`;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

/**
 * The glyph for an issue type.
 *
 * Shapes, because a column of words all set in the same small caps is a column
 * you have to read; a bolt, a bookmark and a dot are told apart before reading
 * starts, which is the whole point of putting the type on the card.
 *
 * Which glyph is decided by the hierarchy level first and the name only after:
 * an instance can rename its types but cannot renumber the levels, so an epic
 * stays an epic here even where it is called something else. The names matched
 * below are the standard ones; anything else returns null and the caller falls
 * back to showing the name as text — an icon nobody can decode is worse than
 * the word it replaced, and inventing a generic glyph for "some custom type"
 * would erase the one piece of information that type carries.
 */
function typeIcon(issue) {
  const name = issue.type.trim().toLowerCase();

  // Level first: these two cannot be renamed out of recognition.
  if (issue.hierarchy >= 1) {
    // A bolt, which is what Jira has trained everyone to read as "epic".
    return { cls: "epic", fill: true, paths: '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>' };
  }
  if (issue.hierarchy <= -1) {
    // An arrow turning into a box: this hangs off something else.
    return {
      cls: "sub",
      fill: false,
      paths: '<path d="M4 5v6a2 2 0 0 0 2 2h5"/><path d="m9 10 3 3-3 3"/><rect x="13" y="9" width="7" height="8" rx="1.5"/>',
    };
  }

  if (/^bugs?$/.test(name)) {
    // Solid dot, the way Jira draws a bug, and the only filled circle here.
    return { cls: "bug", fill: true, paths: '<circle cx="12" cy="12" r="7"/>' };
  }
  if (/^(story|stories|用户故事|故事)$/.test(name)) {
    return { cls: "story", fill: false, paths: '<path d="M6 3h12v18l-6-4.5L6 21z"/>' };
  }
  if (/^(task|tasks|任务)$/.test(name)) {
    return {
      cls: "task",
      fill: false,
      paths: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
    };
  }
  return null;
}

/** The badge for a type with no glyph: the name itself, which still says something. */
function typeTone(issue) {
  return "jira-type";
}

/**
 * The type, as an icon where one exists and as its own name where it does not.
 *
 * The name never disappears — it moves to `title`/`aria-label`, so a pointer and
 * a screen reader both still get the word the glyph stands for.
 */
function typeMark(issue) {
  const icon = typeIcon(issue);
  if (!icon) return el("span", typeTone(issue), issue.type);

  const span = el("span", "jira-typeicon " + icon.cls);
  span.innerHTML =
    '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" ' +
    (icon.fill
      ? 'fill="currentColor" stroke="none">'
      : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">') +
    icon.paths +
    "</svg>";
  span.title = issue.type;
  span.setAttribute("aria-label", issue.type);
  return span;
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
  if (issue.type) head.append(typeMark(issue));
  head.append(issueLink(issue.key, "jira-key"));

  // 父级跟在单号后面。同一个字段既装史诗也装子任务的父任务，所以叫法由层级决定：
  // 把子任务的父任务标成「史诗」是错的，而两者作为上下文都值得显示。
  if (issue.parent) {
    const isEpic = issue.parent.hierarchy >= 1;
    const chip = issueLink(issue.parent.key, isEpic ? "jira-parent epic" : "jira-parent");
    // 标题进 title：卡片头已经有类型、单号、状态和刷新，再塞一句话就挤了。
    chip.title = issue.parent.summary
      ? `${issue.parent.key} · ${issue.parent.summary}`
      : issue.parent.key;
    head.append(chip);
  }
  if (issue.status) head.append(el("span", statusTone(issue.statusCategory), issue.status));

  // Refreshing one issue rather than all of them: watching a PR's CI finish is a
  // single-issue errand, and a full sweep is a dev-status call per issue plus one
  // per PR — a hundred requests to answer a question about one card.
  const state = refreshState(issue.id, refreshing, refreshFailed);
  const again = el("button", state.className, "\u21bb");
  again.type = "button";
  again.disabled = state.disabled;
  again.title = state.failed ? tr("jira.unreachable") : tr("jira.refreshOne");
  again.setAttribute("aria-label", tr("jira.refreshOne"));
  again.addEventListener("click", async () => {
    if (refreshing.has(issue.id)) return;
    refreshing.add(issue.id);
    refreshFailed.delete(issue.id);
    // 立刻重画，状态从上面那两个集合来——所以中途任何一次重画都还原得回来。
    renderIssues();
    const ok = await loadDevOne(issue.id);
    refreshing.delete(issue.id);
    if (!ok) refreshFailed.add(issue.id);
    renderIssues();
  });
  head.append(again);

  card.append(head);

  if (issue.summary) card.append(el("p", "jira-summary", issue.summary));

  const entry = dev[issue.id];
  if (entry && entry.ok && (entry.prs.length || entry.hidden)) {
    const prs = el("div", "jira-prs");
    for (const pr of entry.prs) prs.append(prRow(pr));
    // Say what was filtered rather than just filtering. The whole point of the
    // filter is that dev-status attaches PRs that belong to other issues; a
    // filter that then hides things silently has only swapped one kind of
    // inaccuracy for another.
    if (entry.hidden) prs.append(el("p", "jira-hidden", tr("jira.prHidden", { n: entry.hidden })));
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
    try {
      await loadIssues(true);
    } finally {
      // Re-enabled when the *list* is back, not when the PR data catches up —
      // renderIssues() has already replaced this button by then anyway, and
      // leaving it dead for another fourteen seconds would read as a hang.
      refresh.disabled = false;
    }
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
  const started = Date.now();
  try {
    const res = await fetch(url("api/jira/dev" + (refresh ? "?refresh=1" : "")));
    const body = await res.json();
    // Merged per issue, never assigned wholesale, and never over an entry that
    // arrived after this request went out: the bulk load takes fifteen seconds
    // and a single-issue refresh takes one, so the slow answer is routinely the
    // stale one. Replacing the map outright is what made a refresh appear to do
    // nothing — its result was overwritten seconds later by older data.
    for (const [id, entry] of Object.entries(body.dev ?? {})) {
      if ((devAt[id] ?? 0) > started) continue;
      dev[id] = entry;
      devAt[id] = Date.now();
    }
  } catch {
    // PRs are extra detail on top of the issue list; failing to get them must
    // not take the page down with it. Whatever is already shown stays.
  }
}

/** One issue only — what you actually want while waiting on one PR's build. */
/** @returns {Promise<boolean>} 拿到新数据没有——调用方要据此决定给什么反馈。 */
async function loadDevOne(issueId) {
  try {
    const res = await fetch(url("api/jira/dev?refresh=1&id=" + encodeURIComponent(issueId)));
    const body = await res.json();
    const entry = (body.dev ?? {})[issueId];
    if (!entry) return false;
    dev[issueId] = entry;
    devAt[issueId] = Date.now();
    return entry.ok !== false;
  } catch {
    // 这张卡保持原样，好过把整页换成错误页——但**要让人看见没成功**，
    // 静默失败跟"刷了但没变化"长得一模一样。
    return false;
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
  renderIssues();

  // PRs and builds arrive after the list is already on screen, not before it.
  //
  // The issue list itself answers in a second or two; the dev data behind it is
  // a dev-status call per issue plus a Bitbucket call per PR, and measured
  // against the real instance that is fourteen seconds for fifty issues.
  // Awaiting it here — which is what this did at first — bought a blank page for
  // the length of the slowest part of the page, to show a detail that is
  // supplementary by its own design. The same sentence that justifies swallowing
  // its failures applies to its latency: extra detail must not make the main
  // thing wait for it.
  loadDev(refresh).then(renderIssues);
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
  // A new tab, so the issue list survives the errand. Creating a session is a
  // detour from reading the list, and on a phone getting back to it otherwise
  // means the browser's back button through a create page and a terminal.
  //
  // Called straight from the click handler with nothing awaited in between,
  // which is what keeps this out of the popup blocker.
  window.open(url(`new.html?${params}`), "_blank", "noopener");
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
  instanceUrl = typeof config.url === "string" ? config.url.replace(/\/+$/, "") : "";

  if (!config.configured) {
    renderEmpty(tr("jira.unconfigured"), tr("jira.unconfiguredHint"));
    return;
  }

  await loadIssues();

  // The session is created in the other tab now, so this one has no way to hear
  // about it. Re-reading the bindings when the tab comes back into view is what
  // keeps the list from being permanently one session out of date.
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || !issues.length) return;
    await reloadBindings();
    renderIssues();
  });
});
