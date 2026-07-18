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

function card(session) {
  const wrapper = el("div", "card");
  const link = el("a", "card-main");
  link.href = `terminal.html?target=${encodeURIComponent(session.name)}`;

  const row = el("div", "row");
  if (session.idle) {
    const dot = el("span", "dot");
    dot.title = "等待你的回复";
    row.append(dot);
  }
  row.append(el("span", "name", session.name));
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
    confirmAndKill(session);
  });

  wrapper.append(link, more);
  return wrapper;
}

async function render() {
  try {
    const res = await fetch("api/sessions");
    const sessions = await res.json();
    countEl.textContent = sessions.length ? `${sessions.length} 个` : "";
    listEl.replaceChildren(
      ...(sessions.length ? sessions.map(card) : [el("p", "empty", "没有 tmux 会话")]),
    );
  } catch {
    countEl.textContent = "";
    listEl.replaceChildren(el("p", "empty", "无法连接到服务"));
  }
}

render();
setInterval(render, 5000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") render();
});
