import { openCreateSheet } from "./create-sheet.js";
import { initNotifyToggle } from "./push.js";
import { openThemeSheet } from "./theme-sheet.js";
import { initTheme } from "./theme-apply.js";

// Before anything renders: paints the cached theme synchronously, then
// reconciles with the machine's stored choice.
initTheme();

const listEl = document.getElementById("list");
const countEl = document.getElementById("count");

function relativeTime(epochSeconds) {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (secs < 60) return tr("list.justNow");
  if (secs < 3600) return tr("list.minutesAgo", { n: Math.floor(secs / 60) });
  if (secs < 86400) return tr("list.hoursAgo", { n: Math.floor(secs / 3600) });
  return tr("list.daysAgo", { n: Math.floor(secs / 86400) });
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

function card(session) {
  const wrapper = el("div", "card");
  const link = el("a", "card-main");
  link.href = `terminal.html?target=${encodeURIComponent(session.name)}`;

  const row = el("div", "row");
  if (session.pinned) row.append(pinBadge());
  if (session.idle) {
    const dot = el("span", "dot");
    dot.title = tr("list.waitingDot");
    row.append(dot);
  }
  row.append(el("span", "name", session.name));
  if (session.claudeId) {
    // Short prefix only — enough to eyeball and to match the transcript file
    // under ~/.claude/projects; the full id is on the title for a long-press.
    const sid = el("span", "sid", session.claudeId.slice(0, 8));
    sid.title = session.claudeId;
    row.append(sid);
  }
  row.append(el("span", "time", relativeTime(session.lastActivityEpoch)));
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
 * be brought back. Recreating each one launches a Claude process, so it waits
 * for a tap rather than restoring on its own.
 */
function restoreBanner(count) {
  const bar = el("div", "restore-banner");
  bar.append(el("span", null, tr("list.restorable", { n: count })));
  const btn = el("button", "restore-btn", tr("list.restore"));
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = tr("list.restoring");
    try {
      await fetch("api/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    } catch {
      // The next render reflects whatever actually came back.
    }
    render();
  });
  bar.append(btn);
  return bar;
}

async function render() {
  try {
    const [sessions, restorable] = await Promise.all([
      fetch("api/sessions").then((r) => r.json()),
      fetchRestorable(),
    ]);
    countEl.textContent = sessions.length ? tr("list.count", { n: sessions.length }) : "";
    setTabWaiting(sessions.filter((s) => s.idle).length);

    const children = [];
    if (restorable.length) children.push(restoreBanner(restorable.length));
    children.push(
      ...(sessions.length ? sessions.map(card) : [el("p", "empty", tr("list.noSessions"))]),
    );
    listEl.replaceChildren(...children);
  } catch {
    countEl.textContent = "";
    listEl.replaceChildren(el("p", "empty", tr("list.offline")));
  }
}

document.getElementById("new-session").addEventListener("click", openCreateSheet);
document.getElementById("appearance").addEventListener("click", openThemeSheet);
initNotifyToggle(document.getElementById("notify-toggle"));

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
