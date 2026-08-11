// The notification history: a log of pushes that were sent, so one swiped away
// on the phone can still be found. Each row links to its session's terminal.

import { initLang, tr } from "./i18n-apply.js";
import { apiFetch } from "./api.js";
import { renderHeader } from "./nav.js";

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

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function relativeTime(epochSeconds) {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (secs < 60) return tr("list.justNow");
  if (secs < 3600) return tr("list.minutesAgo", { n: Math.floor(secs / 60) });
  if (secs < 86400) return tr("list.hoursAgo", { n: Math.floor(secs / 3600) });
  return tr("list.daysAgo", { n: Math.floor(secs / 86400) });
}

async function load() {
  let notifications;
  try {
    ({ notifications } = await (await apiFetch("api/notifications")).json());
  } catch {
    listEl.replaceChildren(el("p", "empty", tr("notif.loadFailed")));
    return;
  }

  setCount(notifications.length ? tr("notif.count", { n: notifications.length }) : "");
  if (!notifications.length) {
    listEl.replaceChildren(el("p", "empty", tr("notif.empty")));
    return;
  }

  listEl.replaceChildren(
    ...notifications.map((n) => {
      const card = el("div", "card");
      const link = el("a", "card-main");
      link.href = `terminal.html?target=${encodeURIComponent(n.session)}`;
      const row = el("div", "row");
      row.append(el("span", "name", n.session));
      row.append(el("span", "time", relativeTime(n.ts)));
      link.append(row);
      if (n.body) link.append(el("p", "preview", n.body));
      card.append(link);
      return card;
    }),
  );
}

// Language first: the empty and error states are rendered from it.
initLang().then(() => {
  renderHeader("notifications");
  load();
});

// Marks this file as a module so its top-level names don't collide with the
// other page scripts under tsc; it's already loaded as type="module".
export {};
