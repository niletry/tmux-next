import { openCreateSheet } from "./create-sheet.js";
import { initNotifyToggle } from "./push.js";

const listEl = document.getElementById("list");
const countEl = document.getElementById("count");

function relativeTime(epochSeconds) {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (secs < 60) return "刚刚";
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟前`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} 小时前`;
  return `${Math.floor(secs / 86400)} 天前`;
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

  sheet.append(el("h2", null, "结束会话"));
  sheet.append(el("p", "sheet-name", session.name));
  sheet.append(
    el("p", "sheet-warn", "里面正在运行的进程会被杀掉，未保存的内容会丢失。"),
  );
  if (session.preview.length) {
    sheet.append(el("p", "preview", session.preview.join("\n")));
  }

  const actions = el("div", "sheet-actions");
  const cancel = el("button", "btn", "取消");
  const confirm = el("button", "btn danger", "结束会话");
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
    confirm.textContent = "正在结束…";
    try {
      const res = await fetch(`api/sessions/${encodeURIComponent(session.name)}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404) {
        confirm.textContent = "失败: " + res.status;
        confirm.disabled = false;
        return;
      }
    } catch {
      confirm.textContent = "失败，请重试";
      confirm.disabled = false;
      return;
    }
    close();
    render();
  });
}

function pinBadge() {
  const span = el("span", "pin");
  span.title = "已置顶";
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
  const pinBtn = el("button", "btn", session.pinned ? "取消置顶" : "置顶");
  const endBtn = el("button", "btn danger", "结束会话");
  const cancel = el("button", "btn", "取消");
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
    dot.title = "等待你的回复";
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

  if (session.preview.length) {
    link.append(el("p", "preview", session.preview.join("\n")));
  }

  if (session.pendingInput) {
    const pending = el("div", "pending", "❯ " + session.pendingInput);
    pending.append(el("b", null, "待发送"));
    link.append(pending);
  }

  const more = el("button", "more", "⋯");
  more.setAttribute("aria-label", `${session.name} 的操作`);
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
  document.title = count ? `(${count}) tmux 会话` : "tmux 会话";
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
  bar.append(el("span", null, `${count} 个上次的会话可恢复`));
  const btn = el("button", "restore-btn", "恢复");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "恢复中…";
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
    countEl.textContent = sessions.length ? `${sessions.length} 个` : "";
    setTabWaiting(sessions.filter((s) => s.idle).length);

    const children = [];
    if (restorable.length) children.push(restoreBanner(restorable.length));
    children.push(
      ...(sessions.length ? sessions.map(card) : [el("p", "empty", "没有 tmux 会话")]),
    );
    listEl.replaceChildren(...children);
  } catch {
    countEl.textContent = "";
    listEl.replaceChildren(el("p", "empty", "无法连接到服务"));
  }
}

document.getElementById("new-session").addEventListener("click", openCreateSheet);
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
