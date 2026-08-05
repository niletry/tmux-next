// The notification history: a log of pushes that were sent, so one swiped away
// on the phone can still be found. Each row links to its session's terminal.

const listEl = document.getElementById("list");
const countEl = document.getElementById("count");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function relativeTime(epochSeconds) {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (secs < 60) return "刚刚";
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟前`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} 小时前`;
  return `${Math.floor(secs / 86400)} 天前`;
}

async function load() {
  let notifications;
  try {
    ({ notifications } = await (await fetch("api/notifications")).json());
  } catch {
    listEl.replaceChildren(el("p", "empty", "加载失败"));
    return;
  }

  countEl.textContent = notifications.length ? `${notifications.length} 条` : "";
  if (!notifications.length) {
    listEl.replaceChildren(el("p", "empty", "还没有通知"));
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

load();

// Marks this file as a module so its top-level names don't collide with the
// other page scripts under tsc; it's already loaded as type="module".
export {};
