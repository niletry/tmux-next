import { initTheme } from "./theme-apply.js";
import { initLang, tr } from "./i18n-apply.js";
import { renderHeader } from "./nav.js";
import { url } from "./root.js";

// Before anything renders: paints the cached theme synchronously, then
// reconciles with the machine's stored choice.
initTheme();
initLang().then(() => {
  // After the language is known: the nav labels come from the dictionary.
  renderHeader("items");
  render();
});

/**
 * Looked up on use, not at module load — same reasoning as list.js: the
 * element lives inside the active nav segment, and renderNav creates it.
 */
const root = document.getElementById("items");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const setCount = (text) => {
  const node = document.getElementById("count");
  if (node) node.textContent = text;
};

/**
 * 一条会话此刻的状态词。
 *
 * 跟 src/item-facets.ts 的 stateOf 同一套判断：turn 优先（它读的是 transcript 的
 * stop_reason，是记录格式的一部分），读不到才退回屏幕推出来的 idle。两边说法必须
 * 一致——同一个会话在卡片上和在维度里给出不同状态，比没有状态更糟。
 */
function stateOf(session) {
  return session.turn ?? (session.idle ? "waiting" : "working");
}

/**
 * 字面量映射而不是拼接键名：src/i18n.test.ts 的死键扫描只认字符串字面量调用，
 * 模板字符串拼出来的键名它看不见，会把这两个键判成没人用。
 */
const AGENT_LABEL = {
  waiting: () => tr("items.agent.waiting"),
  working: () => tr("items.agent.working"),
};

function sessionState(session) {
  return AGENT_LABEL[stateOf(session)]();
}

/** 一张单下的一行会话：它现在什么状态，点进去。别的动作在会话页上。 */
function sessionRow(session) {
  const row = el("a", "item-session");
  row.href = url(`terminal.html?session=${encodeURIComponent(session.name)}`);
  row.append(el("span", "s-name", session.name));
  row.append(el("span", "s-state", sessionState(session)));
  row.append(el("span", "s-open", tr("items.open")));
  return row;
}

/**
 * 单卡片。
 *
 * 「再开一个会话」永远在，不是「打开」——一张单多个会话是常态，不是边角情况。
 */
function itemCard(item, sessions) {
  const card = el("article", "item-card");

  const head = el("div", "item-head");
  // 链接只从 source.url 来，且只在它存在时才画成链接：url 是那个外部系统自己的
  // 路由，只有产生这个 source 的一方才知道怎么拼——内核不该替它猜（尤其不该假定
  // "provider 名字就是插件 id、插件页都在 p/<id>/ 下接受 ?key="，那是两回事，也没
  // 有任何插件的页面真的读 ?key=）。source.ref 的徽标不管有没有 url 都画，它本身
  // 就是有用的信息。
  if (item.source?.url) {
    const link = el("a", "item-title", item.title);
    link.href = item.source.url;
    head.append(link);
  } else {
    head.append(el("h2", "item-title", item.title));
  }
  if (item.source) head.append(el("span", "item-source", item.source.ref));
  if (sessions.length) head.append(el("span", "item-count", tr("items.sessions", { n: sessions.length })));
  card.append(head);

  for (const session of sessions) card.append(sessionRow(session));

  const more = el("a", "item-new", sessions.length ? tr("items.newSession") : tr("items.firstSession"));
  more.href = url(`new.html?item=${encodeURIComponent(item.id)}`);
  card.append(more);
  return card;
}

/** 没有绑定的会话。不变成假单、也不藏起来——一个明确的待归类区。 */
function unassignedGroup(sessions) {
  const group = el("section", "unassigned");
  group.append(el("h2", "group-name", tr("items.unassigned")));
  for (const session of sessions) group.append(sessionRow(session));
  return group;
}

function renderEmpty(message, hint) {
  root.replaceChildren();
  const box = el("p", "empty", message);
  if (hint) box.append(el("span", "hint", hint));
  root.append(box);
}

async function render() {
  let body;
  try {
    const res = await fetch(url("api/items"));
    if (!res.ok) throw new Error(String(res.status));
    body = await res.json();
  } catch {
    renderEmpty(tr("items.offline"));
    return;
  }

  // 后端可能是旧版本，缺字段就当空——半新半旧的服务是常态，不是异常。
  const items = Array.isArray(body?.items) ? body.items : [];
  const sessions = Array.isArray(body?.sessions) ? body.sessions : [];
  const bindings = Array.isArray(body?.bindings) ? body.bindings : [];

  setCount(tr("items.count", { n: items.length }));

  const byName = new Map(sessions.map((s) => [s.name, s]));
  const mine = new Map();
  const bound = new Set();
  for (const b of bindings) {
    if (!b.live) continue;
    const found = byName.get(b.session);
    if (!found) continue;
    bound.add(b.session);
    const list = mine.get(b.itemId);
    if (list) list.push(found);
    else mine.set(b.itemId, [found]);
  }

  const open = items.filter((i) => !i.closedAt);
  const loose = sessions.filter((s) => !bound.has(s.name));

  root.replaceChildren();
  if (!open.length && !loose.length) {
    renderEmpty(tr("items.empty"), tr("items.emptyHint"));
    return;
  }
  for (const item of open) root.append(itemCard(item, mine.get(item.id) ?? []));
  if (loose.length) root.append(unassignedGroup(loose));
}
