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

function card(session) {
  const link = el("a", "card");
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

  return link;
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
