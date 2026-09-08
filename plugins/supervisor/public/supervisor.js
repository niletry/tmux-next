// Not @ts-check'd: import specifiers here are written for the URL this file
// is served at (/p/supervisor/supervisor.js, two segments deep), not the
// on-disk path (plugins/supervisor/public/supervisor.js, three deep) — same
// exemption as notifications.js and gallery.js.

import { initLang, tr } from "../../i18n-apply.js";
import { renderHeader } from "../../nav.js";
import { url } from "../../root.js";

const listEl = document.getElementById("list");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function actionLabel(type) {
  if (type === "answered") return tr("supervisor.actionAnswered");
  if (type === "notified") return tr("supervisor.actionNotified");
  return tr("supervisor.actionNoop");
}

// `tr` 只认字符串字面量（src/i18n.test.ts 靠这个扫死键），createFailed_* 这三个键
// 不能用模板字符串拼出来查，得跟 public/list.js 里维度查找一样写成显式分支。
function createFailedMessage(reason) {
  if (reason === "baddir") return tr("supervisor.createFailed_baddir");
  if (reason === "exists") return tr("supervisor.createFailed_exists");
  return tr("supervisor.createFailed_failed");
}

function logRow(entry) {
  const row = el("div", "row");
  row.append(el("span", "time", entry.ts));
  const summary = entry.actions.length
    ? entry.actions.map((a) => `${a.session}: ${actionLabel(a.type)} — ${a.detail}`).join(" · ")
    : entry.checked.map((c) => `${c.session}: ${c.turn ?? "?"}`).join(" · ");
  row.append(el("span", "preview", summary));
  return row;
}

async function supervisorCard(sup) {
  const card = el("div", "card");
  const main = el("div", "card-main");
  main.append(el("span", "name", sup.cwd));
  main.append(el("span", "time", sup.session));
  main.append(el("span", "preview", tr(sup.autoConfirmPermission ? "supervisor.autoConfirmOn" : "supervisor.autoConfirmOff")));
  card.append(main);

  let entries = [];
  try {
    const body = await (await fetch(url(`api/supervisor/log?cwd=${encodeURIComponent(sup.cwd)}`))).json();
    // 一次 200 但 body 形状不对（5xx 被包成 JSON、截断的响应、任何不是数组
    // 的 entries）不能让这张卡的渲染抛出去——那会让 load() 里的
    // Promise.all 整体 reject，页面就整体空白，而不是这一张卡退化成空状态。
    entries = Array.isArray(body?.entries) ? body.entries : [];
  } catch {
    entries = [];
  }

  if (!entries.length) {
    card.append(el("p", "empty", tr("supervisor.logEmpty")));
  } else {
    const log = el("div", "log");
    for (const entry of entries.slice().reverse()) log.append(logRow(entry));
    card.append(log);
  }

  return card;
}

function createForm() {
  const form = el("form", "supervisor-create");
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = tr("supervisor.cwdPlaceholder");
  input.required = true;

  const label = el("label");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  label.append(checkbox, document.createTextNode(tr("supervisor.autoConfirmLabel")));

  const submit = el("button", "btn primary", tr("supervisor.createButton"));
  submit.type = "submit";

  const error = el("p", "empty");
  error.hidden = true;

  form.append(input, label, submit, error);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.hidden = true;
    try {
      const res = await fetch(url("api/supervisor/create"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: input.value, autoConfirmPermission: checkbox.checked }),
      });
      if (!res.ok) {
        const { error: reason } = await res.json();
        error.textContent = createFailedMessage(reason);
        error.hidden = false;
        return;
      }
      input.value = "";
      checkbox.checked = false;
      await load();
    } catch {
      error.textContent = createFailedMessage("failed");
      error.hidden = false;
    }
  });

  return form;
}

export async function load() {
  let supervisors;
  try {
    ({ supervisors } = await (await fetch(url("api/supervisor"))).json());
  } catch {
    listEl.replaceChildren(createForm(), el("p", "empty", tr("supervisor.loadFailed")));
    return;
  }

  const nodes = [createForm()];
  if (!supervisors.length) {
    nodes.push(el("p", "empty", tr("supervisor.empty")));
  } else {
    // 一张卡的渲染失败不能拖累其余的——supervisorCard 内部已经把 log 抓取的
    // 失败收进空状态了，这里再兜一层是防线，不是重复：任何未预见到的抛出
    // 都换成一张最小的、还是带 cwd/会话名的卡，而不是让 Promise.all 整体
    // reject、listEl.replaceChildren 永远不跑、整页空白。
    const cards = await Promise.all(
      supervisors.map((sup) =>
        supervisorCard(sup).catch(() => {
          const fallback = el("div", "card");
          const main = el("div", "card-main");
          main.append(el("span", "name", sup.cwd));
          main.append(el("span", "time", sup.session));
          fallback.append(main);
          fallback.append(el("p", "empty", tr("supervisor.logEmpty")));
          return fallback;
        }),
      ),
    );
    nodes.push(...cards);
  }
  listEl.replaceChildren(...nodes);
}

initLang().then(() => {
  renderHeader("supervisor");
  load();
});

export {};
