import { initTheme } from "./theme-apply.js";
import { initLang, tr } from "./i18n-apply.js";
import { renderHeader } from "./nav.js";

// Before anything renders: paints the cached theme synchronously, then
// reconciles with the machine's stored choice.
initTheme();
initLang().then(() => {
  // After the language is known: the nav labels come from the dictionary.
  renderHeader("sessions");
  render();
});

const listEl = document.getElementById("list");
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

function relativeTime(epochSeconds) {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (secs < 60) return tr("list.justNow");
  if (secs < 3600) return tr("list.minutesAgo", { n: Math.floor(secs / 60) });
  if (secs < 86400) return tr("list.hoursAgo", { n: Math.floor(secs / 3600) });
  return tr("list.daysAgo", { n: Math.floor(secs / 86400) });
}

/** A bare span of time — "12 分钟" — for phrasings that supply their own verb. */
function duration(epochSeconds) {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (secs < 60) return tr("list.durSeconds", { n: Math.max(1, secs) });
  if (secs < 3600) return tr("list.durMinutes", { n: Math.floor(secs / 60) });
  if (secs < 86400) return tr("list.durHours", { n: Math.floor(secs / 3600) });
  return tr("list.durDays", { n: Math.floor(secs / 86400) });
}

/**
 * What the session last did, as a short phrase.
 *
 * The verb comes from the tool's kind and the noun from its input, so the row
 * reads "changed list.js" rather than naming a tool nobody outside the agent
 * would recognise. A tool this build has no word for arrives as "other" and
 * keeps its own name as the noun.
 *
 * Written out rather than built as `list.act.${kind}`: the dead-key check in
 * i18n.test.ts scans for literal keys, and a computed one reads as unused. A
 * check that cries wolf gets ignored, so the keys stay greppable.
 */
const ACTION_PHRASE = {
  edit: (target) => tr("list.act.edit", { target }),
  read: (target) => tr("list.act.read", { target }),
  run: (target) => tr("list.act.run", { target }),
  search: (target) => tr("list.act.search", { target }),
  web: (target) => tr("list.act.web", { target }),
  task: (target) => tr("list.act.task", { target }),
  other: (target) => tr("list.act.other", { target }),
};

function actionPhrase(action) {
  // No target means nothing worth naming — the row falls back to the bare
  // timestamp rather than printing a verb with no object.
  if (!action || !action.target) return null;
  const phrase = ACTION_PHRASE[action.kind];
  return phrase ? phrase(action.target) : null;
}

/**
 * The time cell, which says what its number is about.
 *
 * Three readings, because one number cannot serve all three states. Waiting on
 * you is the only one that calls for action, so it leads with that and gives
 * the span it has been waiting. Otherwise the stamp is anchored to the last
 * real action — a repaint-driven one reads "just now" forever while a turn
 * runs, which is why the old cell was empty of information for exactly the
 * sessions that were busiest.
 */
function timeCell(session) {
  const action = session.lastAction ?? null;
  const epoch = action ? action.epoch : session.lastActivityEpoch;

  if (session.idle) return tr("list.waitingFor", { t: duration(epoch) });

  const phrase = actionPhrase(action);
  return phrase ? `${relativeTime(epoch)} · ${phrase}` : relativeTime(epoch);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Ending a session kills everything running inside it, so it sits behind a
 * deliberate two-step: a small button that is hard to hit by accident, then a
 * dialog that names the session and shows what is on its screen.
 */
async function confirmAndKill(session) {
  const dialog = el("div", "sheet-backdrop");
  const sheet = el("div", "sheet");

  sheet.append(el("h2", null, tr("list.endSession")));
  sheet.append(el("p", "sheet-name", session.name));
  sheet.append(
    el("p", "sheet-warn", tr("list.endWarn")),
  );
  if (session.preview.length) {
    sheet.append(el("p", "preview", session.preview.join("\n")));
  }

  const actions = el("div", "sheet-actions");
  const cancel = el("button", "btn", tr("list.cancel"));
  const confirm = el("button", "btn danger", tr("list.endSession"));
  actions.append(cancel, confirm);
  sheet.append(actions);
  dialog.append(sheet);
  document.body.append(dialog);

  const close = () => dialog.remove();
  cancel.addEventListener("click", close);
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) close();
  });

  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    confirm.textContent = tr("list.ending");
    try {
      const res = await fetch(`api/sessions/${encodeURIComponent(session.name)}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404) {
        confirm.textContent = tr("list.endFailedCode", { code: res.status });
        confirm.disabled = false;
        return;
      }
    } catch {
      confirm.textContent = tr("list.endFailed");
      confirm.disabled = false;
      return;
    }
    close();
    render();
  });
}

function pinBadge() {
  const span = el("span", "pin");
  span.title = tr("list.pinned");
  span.innerHTML =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5' +
    'a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>';
  return span;
}

/**
 * The ⋯ menu: pin to the top, or end the session. Pinning is one tap; ending
 * still goes through its own confirming dialog.
 */
function openActions(session) {
  const dialog = el("div", "sheet-backdrop");
  const sheet = el("div", "sheet");
  sheet.append(el("p", "sheet-name", session.name));

  const menu = el("div", "sheet-menu");
  const pinBtn = el("button", "btn", tr(session.pinned ? "list.unpin" : "list.pin"));
  const endBtn = el("button", "btn danger", tr("list.endSession"));
  const cancel = el("button", "btn", tr("list.cancel"));
  menu.append(pinBtn, endBtn, cancel);
  sheet.append(menu);
  dialog.append(sheet);
  document.body.append(dialog);

  const close = () => dialog.remove();
  cancel.addEventListener("click", close);
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) close();
  });

  pinBtn.addEventListener("click", async () => {
    pinBtn.disabled = true;
    try {
      await fetch(`api/sessions/${encodeURIComponent(session.name)}/pin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned: !session.pinned }),
      });
    } catch {
      // A failed toggle just leaves the order as it was; the next render is truth.
    }
    close();
    render();
  });

  endBtn.addEventListener("click", () => {
    close();
    confirmAndKill(session);
  });
}

/**
 * 插件贴在这一行上的标注。
 *
 * 遍历插件 id，不认识其中任何一个——认识了，接缝就白划了：内核只知道"有插件想
 * 在这行上说句话"，不知道说的是工单还是别的什么。
 *
 * 一律 textContent：标注来自插件，插件不该能往内核的列表里塞标记。
 */
function renderAnnotations(row, name, annotations) {
  const notes = [];
  for (const bySession of Object.values(annotations ?? {})) {
    const note = bySession?.[name];
    if (note?.text) notes.push(note);
  }
  if (!notes.length) return;
  const wrap = el("div", "session-notes");
  for (const note of notes) {
    const chip = el("span", `note note-${note.tone ?? "dim"}`);
    chip.textContent = note.text;
    if (note.detail) chip.title = note.detail;
    wrap.append(chip);
  }
  row.append(wrap);
}

function card(session, annotations, itemsById) {
  const wrapper = el("div", "card");
  const link = el("a", "card-main");
  link.href = `terminal.html?target=${encodeURIComponent(session.name)}`;

  // The name gets a line to itself: sharing one with the badges, status and
  // timestamp squeezed it down to an ellipsis on a phone.
  const nameRow = el("div", "row name-row");
  if (session.pinned) nameRow.append(pinBadge());
  if (session.idle) {
    const dot = el("span", "dot");
    dot.title = tr("list.waitingDot");
    nameRow.append(dot);
  }
  nameRow.append(el("span", "name", session.name));
  // A session bound to a work item shows that item's title. `itemId` pointing
  // at nothing — the item was archived and swept, or an old page is reading a
  // stale binding — is treated exactly like no binding at all: this list is
  // not item-driven yet, so a dangling id must degrade silently rather than
  // throw and blank the whole card.
  const item = session.itemId ? itemsById?.get(session.itemId) : null;
  if (item) {
    const chip = el("span", "item-chip", item.title);
    chip.title = `${tr("list.itemOf")}: ${item.title}`;
    chip.setAttribute("aria-label", chip.title);
    nameRow.append(chip);
  }
  link.append(nameRow);

  const row = el("div", "row meta-row");
  if (session.agentLabel) {
    // Which agent runs in here — from the binding record, so a session with no
    // record (or one that predates multi-agent support) simply shows nothing.
    // The version rides on the same badge when it is knowable.
    const badge = el("span", "agent", session.agentLabel);
    badge.title = tr("list.agent");
    row.append(badge);
    if (session.version) {
      const ver = el("span", "agent-ver", session.version);
      ver.title = tr("list.agentVersion");
      row.append(ver);
    }
  }
  // Precise state, in words rather than only the small dot: working on a turn,
  // waiting on the user, or holding unsent input.
  const statusText = session.pendingInput
    ? tr("list.pendingInput")
    : session.idle
      ? tr("list.waitingDot")
      : tr("list.working");
  row.append(el("span", "status", statusText));
  if (session.claudeId) {
    // Short prefix only — enough to eyeball and to match the transcript file
    // under ~/.claude/projects; the full id is on the title for a long-press.
    const sid = el("span", "sid", session.claudeId.slice(0, 8));
    sid.title = session.claudeId;
    row.append(sid);
  }
  row.append(el("span", "time", timeCell(session)));
  link.append(row);

  // What it was last asked to do, above the screen preview: mid-task the
  // preview is usually tool output scrolling past, which says what is happening
  // but not what it is for.
  if (session.task) {
    const task = el("p", "task");
    task.append(el("span", "task-mark", "❯"), el("span", null, session.task));
    link.append(task);
  }

  if (session.preview.length) {
    link.append(el("p", "preview", session.preview.join("\n")));
  }

  if (session.pendingInput) {
    const pending = el("div", "pending", "❯ " + session.pendingInput);
    pending.append(el("b", null, tr("list.pendingInput")));
    link.append(pending);
  }

  renderAnnotations(link, session.name, annotations);

  const more = el("button", "more", "⋯");
  more.setAttribute("aria-label", tr("list.actionsFor", { name: session.name }));
  more.addEventListener("click", (e) => {
    // The button sits on top of the card link; do not follow it.
    e.preventDefault();
    e.stopPropagation();
    openActions(session);
  });

  wrapper.append(link, more);
  return wrapper;
}

/** The sort key a card is ordered by — the same one the server sorts on. */
function orderKey(session) {
  return session.lastAction ? session.lastAction.epoch : session.lastActivityEpoch;
}

/**
 * Which groups are folded shut, by path.
 *
 * Per device rather than per machine, for the same reason font size is: it is a
 * statement about this screen, not about the host. Every read is guarded — a
 * private window, cleared site data, or a half-written value must not be able
 * to stop the list from rendering, which is the page's actual job.
 */
const COLLAPSE_KEY = "tmux-next.collapsed";

function collapsedSet() {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function storeCollapsed(set) {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
  } catch {
    // A browser refusing storage still gets working collapse, just not
    // remembered — the state lives in the DOM until the next render.
  }
}

/**
 * A group heading, with the directory's name as the label.
 *
 * The label is the last path segment because that is what anyone calls the
 * project; the whole path rides on the title, which is what disambiguates two
 * checkouts that happen to end in the same word.
 *
 * The whole heading is the hit target, not a small chevron: this is used with a
 * thumb.
 */
function groupHeader(label, path, key, count, collapsed) {
  const head = el("div", "group-head");
  head.setAttribute("role", "button");
  head.setAttribute("tabindex", "0");
  head.setAttribute("aria-expanded", collapsed ? "false" : "true");

  const chevron = el("span", "group-chevron", collapsed ? "▸" : "▾");
  chevron.setAttribute("aria-hidden", "true");
  const name = el("span", "group-name", label);
  if (path) name.title = path;
  head.append(chevron, name);

  // The count is what a folded group has left to say about itself.
  if (collapsed) head.append(el("span", "group-count", String(count)));

  const toggle = () => {
    const set = collapsedSet();
    if (set.has(key)) set.delete(key);
    else set.add(key);
    storeCollapsed(set);
    render();
  };
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });
  return head;
}

function groupOf(label, path, key, sessions, collapsed, annotations, itemsById) {
  const group = el("section", "group" + (collapsed ? " collapsed" : ""));
  group.append(groupHeader(label, path, key, sessions.length, collapsed));
  if (!collapsed)
    for (const session of sessions) group.append(card(session, annotations, itemsById));
  return group;
}

/**
 * Sessions arranged into the sections the page draws.
 *
 * Pinned first and across projects: pinning means "show me this wherever it
 * lives", so lifting those out is the whole point of having pinned them. What
 * remains is grouped by directory, because the question the list answers is
 * "which of my projects needs me" and a flat run of names does not answer it.
 *
 * Groups are ordered by their most recent member, so the project being worked
 * on rises to the top on its own.
 */
function sections(sessions, annotations, itemsById) {
  const out = [];
  const collapsed = collapsedSet();

  const pinned = sessions.filter((s) => s.pinned);
  if (pinned.length) {
    // A sentinel key: the pinned section has no path of its own, and a real
    // path could otherwise collide with it.
    out.push(
      groupOf(
        tr("list.pinnedGroup"), null, "\u0000pinned", pinned,
        collapsed.has("\u0000pinned"), annotations, itemsById,
      ),
    );
  }

  const byPath = new Map();
  for (const session of sessions) {
    if (session.pinned) continue;
    const path = session.path || "";
    if (!byPath.has(path)) byPath.set(path, []);
    byPath.get(path).push(session);
  }

  const groups = [...byPath].sort(
    ([, a], [, b]) => Math.max(...b.map(orderKey)) - Math.max(...a.map(orderKey)),
  );
  for (const [path, members] of groups) {
    // A session whose directory tmux could not report still needs a home; it
    // gets its own heading rather than silently joining someone else's.
    const label = path ? path.replace(/\/+$/, "").split("/").pop() || path : tr("list.noProject");
    out.push(groupOf(label, path, path, members, collapsed.has(path), annotations, itemsById));
  }
  return out;
}

/** Reflects "how many sessions are waiting on you" onto the browser tab. */
function setTabWaiting(count) {
  document.title = count ? `(${count}) ${tr("list.title")}` : tr("list.title");
  const link = document.querySelector('link[rel="icon"]');
  if (link) link.href = count ? "favicon-alert.svg" : "favicon.svg";
}

async function fetchRestorable() {
  try {
    return await (await fetch("api/restorable")).json();
  } catch {
    return [];
  }
}

/**
 * Sessions whose tmux died (a reboot, a crash) but whose Claude conversation can
 * be brought back.
 *
 * Recreating each one launches an agent process, so restoring is expensive in a
 * way the count alone does not convey — forty records is forty processes. The
 * banner therefore opens a picker instead of acting: the button that costs the
 * most should be the one that has to be aimed.
 */
function restoreBanner(entries) {
  const bar = el("div", "restore-banner");
  bar.append(el("span", null, tr("list.restorable", { n: entries.length })));
  const btn = el("button", "restore-btn", tr("list.choose"));
  btn.addEventListener("click", () => openRestorePicker(entries));
  bar.append(btn);
  return bar;
}

/** Groups restorable records by directory, preserving first-seen order. */
function byDirectory(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const dir = entry.cwd || "";
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(entry);
  }
  return [...groups];
}

/**
 * The picker: every restorable conversation, grouped by the directory it ran
 * in, nothing selected.
 *
 * Starting empty is the whole point. The list is long and each entry costs a
 * process, so the safe default is the one where a mistap does nothing.
 */
function openRestorePicker(entries) {
  const chosen = new Set();

  const dialog = el("div", "sheet-backdrop");
  const sheet = el("div", "sheet restore-sheet");
  sheet.append(el("h2", null, tr("list.restoreTitle")));

  const list = el("div", "restore-list");
  const boxes = new Map();

  for (const [dir, members] of byDirectory(entries)) {
    const head = el("div", "restore-group-head");
    const label = dir ? dir.replace(/\/+$/, "").split("/").pop() || dir : tr("list.noProject");
    head.append(el("span", "restore-group-name", label));
    head.append(el("span", "restore-group-count", String(members.length)));
    if (dir) head.title = dir;
    // Tapping the heading takes the whole group — the common case is wanting
    // everything from one project and nothing from the others.
    head.addEventListener("click", () => {
      const wantAll = members.some((m) => !chosen.has(m.session));
      for (const m of members) {
        if (wantAll) chosen.add(m.session);
        else chosen.delete(m.session);
        boxes.get(m.session).checked = wantAll;
      }
      sync();
    });
    list.append(head);

    for (const entry of members) {
      const row = el("label", "restore-row");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.addEventListener("change", () => {
        if (box.checked) chosen.add(entry.session);
        else chosen.delete(entry.session);
        sync();
      });
      boxes.set(entry.session, box);
      row.append(box, el("span", "restore-name", entry.session));
      list.append(row);
    }
  }
  sheet.append(list);

  const actions = el("div", "sheet-actions");
  const cancel = el("button", "btn", tr("list.cancel"));
  const go = el("button", "btn primary restore-go", tr("list.restoreSelected", { n: 0 }));
  go.disabled = true;
  actions.append(cancel, go);
  sheet.append(actions);
  dialog.append(sheet);
  document.body.append(dialog);

  function sync() {
    go.disabled = chosen.size === 0;
    go.textContent = tr("list.restoreSelected", { n: chosen.size });
  }

  const close = () => dialog.remove();
  cancel.addEventListener("click", close);
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) close();
  });

  go.addEventListener("click", async () => {
    go.disabled = true;
    go.textContent = tr("list.restoring");
    try {
      await fetch("api/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessions: [...chosen] }),
      });
    } catch {
      // The next render reflects whatever actually came back.
    }
    close();
    render();
  });
}

async function render() {
  try {
    const [body, restorable] = await Promise.all([
      fetch("api/sessions").then((r) => r.json()),
      fetchRestorable(),
    ]);
    // Older servers (and a phone holding a cached page against a newer one)
    // return a bare array; a fresh server wraps it with plugin annotations and
    // the work items sessions may be bound to. Keep tolerating the bare-array
    // shape either way — an old page can hit a new server just as easily as
    // the reverse — so `items` simply falls back to empty.
    const { sessions, annotations, items } = Array.isArray(body)
      ? { sessions: body, annotations: {}, items: [] }
      : body;
    const itemsById = new Map((items ?? []).map((item) => [item.id, item]));
    setCount(sessions.length ? tr("list.count", { n: sessions.length }) : "");
    setTabWaiting(sessions.filter((s) => s.idle).length);

    const children = [];
    if (restorable.length) children.push(restoreBanner(restorable));
    children.push(
      ...(sessions.length
        ? sections(sessions, annotations ?? {}, itemsById)
        : [el("p", "empty", tr("list.noSessions"))]),
    );
    listEl.replaceChildren(...children);
  } catch {
    setCount("");
    listEl.replaceChildren(el("p", "empty", tr("list.offline")));
  }
}


// A build marker in the corner: if you can see it and it matches the deploy,
// the page is the current one — no guessing about a stale cache.
fetch("api/version")
  .then((r) => r.json())
  .then(({ version, build }) => {
    const tag = document.createElement("div");
    tag.className = "ver";
    tag.textContent = `v${version}${build ? " · " + build : ""}`;
    document.body.append(tag);
  })
  .catch(() => {});

render();
setInterval(render, 5000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") render();
});
