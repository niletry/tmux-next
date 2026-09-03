import { initTheme } from "./theme-apply.js";
import { initLang, tr } from "./i18n-apply.js";
import { renderHeader } from "./nav.js";
import { openPicker } from "./pick-sheet.js";
import { icon } from "./icons.js";
// 反过来看那一半：这条会话挂在哪张单下，那张单此刻怎么样。只读的一眼，改绑定
// 仍然是旁边那个「挂到单下」。
import { openItemPanel } from "./item-panel.js";

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

  // 等你回话时这一格是空的：状态图标旁边已经写着等了多久（见 stateCell），
  // 再画一遍"等你 3 分钟"就是同一件事说两遍，而它占的是这一行最右边那块地方。
  if (session.idle) return "";

  const phrase = actionPhrase(action);
  return phrase ? `${relativeTime(epoch)} · ${phrase}` : relativeTime(epoch);
}

/** 三种状态各自的形状。文字进 title，行里只留图标。 */
const STATE_ICON = { pending: "pencil", waiting: "hourglass", working: "activity" };

/**
 * 状态那一格：一个图标，等你回话时后面跟一个数字。
 *
 * 原来这里是"等待你的回复"五个字，右边另有一格"等你 3 分钟"——两格说的是同一件
 * 事，加起来吃掉半行，而这一行还要装 agent 名、版本和 sha。图标 + 数字之后
 * 是"⏳ 3 分钟"一格。
 *
 * 词没有消失，进了 title 和 aria-label：读屏和长按拿到的仍然是整句话，省掉的只是
 * 每张卡片都一样、扫一眼就够的那几个字。
 */
function stateCell(session) {
  const kind = session.pendingInput ? "pending" : session.idle ? "waiting" : "working";
  const words =
    kind === "pending"
      ? tr("list.pendingInput")
      : kind === "waiting"
        ? tr("list.waitingDot")
        : tr("list.working");

  const cell = el("span", "state");
  cell.innerHTML = icon(STATE_ICON[kind], 13);

  if (session.idle) {
    const epoch = session.lastAction ? session.lastAction.epoch : session.lastActivityEpoch;
    const span = duration(epoch);
    cell.append(el("span", "state-num", span));
    cell.title = tr("list.waitingFor", { t: span });
  } else {
    cell.title = words;
  }
  cell.setAttribute("aria-label", cell.title);
  return cell;
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
/**
 * 置顶 / 取消置顶。
 *
 * 抽出来是因为现在有两个入口在做同一件事：⋯ 浮层里的那颗按钮（窄屏），和卡片
 * 底部动作行里的那颗（宽屏）。两份实现迟早会分叉，而分叉的那一天没有任何测试
 * 会红——两个入口各自都还"能用"，只是行为不一样了。
 *
 * 失败不回滚也不报错：下一次渲染就是真相，而排序错一次不值得打断人。
 */
async function pinSession(session) {
  try {
    await fetch(`api/sessions/${encodeURIComponent(session.name)}/pin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: !session.pinned }),
    });
  } catch {
    // 见上：下一次渲染就是真相。
  }
  render();
}

/** 挂到一张单下。反方向（在单上挑会话）在首页，两边打的是同一个接口。 */
function pickItemFor(session, itemsById) {
  const items = [...(itemsById?.values() ?? [])].filter((i) => !i.closedAt);
  openPicker({
    title: tr("list.linkItem"),
    // 单号单独显示：标题是人话（"Gate the remaining ungated queries"），单号才是
    // 在 Jira、分支名、PR 标题里到处出现的那个标识——挑单的时候认的是它。
    // 标题里已经含着单号就不重复画一遍。
    options: items.map((i) => {
      const ref = i.source?.ref;
      return {
        id: i.id,
        label: i.title,
        note: ref && !i.title.includes(ref) ? ref : undefined,
        current: i.id === session.itemId,
      };
    }),
    emptyText: tr("list.noItems"),
    cancelText: tr("list.cancel"),
    failedText: tr("list.linkFailed"),
    onPick: async (id) => {
      const res = await fetch(`api/items/${encodeURIComponent(id)}/bind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: session.name }),
      });
      if (!res.ok) throw new Error(String(res.status));
      render();
    },
    // 只有已经挂着的时候才给"解除"——没挂的时候画一个不做事的按钮，
    // 等于让人怀疑自己是不是记错了。
    ...(session.itemId
      ? {
          clear: {
            label: tr("list.unlinkItem"),
            onPick: async () => {
              const res = await fetch(
                `api/items/bind?session=${encodeURIComponent(session.name)}`,
                { method: "DELETE" },
              );
              if (!res.ok) throw new Error(String(res.status));
              render();
            },
          },
        }
      : {}),
  });
}

/**
 * 卡片底部的动作行，只在宽屏出现（样式表控制显隐，见 style.css 的宽屏一节）。
 *
 * 窄屏仍然走 ⋯ 浮层：手机列表靠密度吃饭，每张卡多一行 40px 的按钮，一屏就少
 * 看两个会话。两个入口都画出来、由 CSS 决定露哪个，比在 JS 里读 matchMedia 稳——
 * 后者要自己处理窗口缩放和重画时机，而这里没有任何状态需要跟着变。
 *
 * 「结束」跟另外几个隔开、走红色：它是这一行里唯一不可撤销的。它仍然弹二次确认，
 * 所以误点一下不会真的杀掉会话——分开放是为了让手不往那边去，不是最后一道闸。
 */
function cardActions(session, itemsById) {
  const bar = el("div", "card-actions");

  /**
   * 图标在前、文字在后。图标不替代文字——这一行四个动作里三个会改状态，只留
   * 图标就是让人靠猜；图标的作用是让这行能被"扫"而不是被"读"。
   * @param {string} cls @param {string} iconName @param {string} text
   */
  const act = (cls, iconName, text) => {
    const b = el("button", cls);
    b.type = "button";
    b.innerHTML = icon(iconName);
    b.append(document.createTextNode(text));
    return b;
  };

  const open = el("a", "card-act primary");
  open.href = `terminal.html?target=${encodeURIComponent(session.name)}`;
  open.innerHTML = icon("terminal");
  open.append(document.createTextNode(tr("list.openSession")));
  bar.append(open);

  // 只在真的挂着一张认得出的单时才画：itemId 指着一张已经被扫掉的单时，这个
  // 入口点开只会是一句"看不到"，跟卡片上那枚标记同一条降级规矩（见 card()）。
  if (session.itemId && itemsById?.has(session.itemId)) {
    const view = act("card-act", "items", tr("list.viewItem"));
    view.addEventListener("click", () => openItemPanel({ id: session.itemId }));
    bar.append(view);
  }

  const pin = act("card-act", "pin", tr(session.pinned ? "list.unpin" : "list.pin"));
  pin.addEventListener("click", () => pinSession(session));
  bar.append(pin);

  const link = act("card-act", "swap", tr(session.itemId ? "list.relinkItem" : "list.linkItem"));
  link.addEventListener("click", () => pickItemFor(session, itemsById));
  bar.append(link);

  // 电源符号，不是垃圾桶：会话是跑着的东西，关掉它才是这个动作；垃圾桶会让人
  // 以为有什么被删掉了。
  const end = act("card-act danger", "power", tr("list.endSession"));
  end.addEventListener("click", () => confirmAndKill(session));
  bar.append(end);

  return bar;
}

function openActions(session, itemsById) {
  const dialog = el("div", "sheet-backdrop");
  const sheet = el("div", "sheet");
  sheet.append(el("p", "sheet-name", session.name));

  const menu = el("div", "sheet-menu");
  // 窄屏上这是唯一的入口——动作行在 900px 以下是隐藏的，见 cardActions 的注释。
  const viewBtn =
    session.itemId && itemsById?.has(session.itemId)
      ? el("button", "btn", tr("list.viewItem"))
      : null;
  const pinBtn = el("button", "btn", tr(session.pinned ? "list.unpin" : "list.pin"));
  // 挂到一张单下。反方向（在单上挑会话）在首页，两边打的是同一个接口。
  const linkBtn = el("button", "btn", tr(session.itemId ? "list.relinkItem" : "list.linkItem"));
  const endBtn = el("button", "btn danger", tr("list.endSession"));
  const cancel = el("button", "btn", tr("list.cancel"));
  if (viewBtn) menu.append(viewBtn);
  menu.append(pinBtn, linkBtn, endBtn, cancel);
  sheet.append(menu);
  dialog.append(sheet);
  document.body.append(dialog);

  const close = () => dialog.remove();
  cancel.addEventListener("click", close);
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) close();
  });

  viewBtn?.addEventListener("click", () => {
    close();
    openItemPanel({ id: session.itemId });
  });

  pinBtn.addEventListener("click", () => {
    pinBtn.disabled = true;
    close();
    pinSession(session);
  });

  linkBtn.addEventListener("click", () => {
    close();
    pickItemFor(session, itemsById);
  });

  endBtn.addEventListener("click", () => {
    close();
    confirmAndKill(session);
  });
}

function card(session, itemsById) {
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
    //
    // 版本号不画：它每张卡片上都一样（同一台机器上的 Claude 是同一个版本），
    // 一个月也变不了两次，却占着这一行里 agent 名旁边最显眼的位置。数据照旧
    // 从后端来（session.version），只是这一行不再花地方说它——真要看版本，
    // 那是"这台机器装的什么"，不是"这个会话怎么样"。
    const badge = el("span", "agent", session.agentLabel);
    badge.title = tr("list.agent");
    row.append(badge);
  }
  // 状态：一个图标，等你回话时带上等了多久。整句话在 title 里。
  row.append(stateCell(session));
  // Claude 会话 UUID 的前 8 位曾经画在这里。去掉了：它排版得像个 git sha，实际是
  // ~/.claude/projects 下那个 transcript 的文件名，扫列表的时候没有人在读它，而这
  // 一行的宽度是手机上最紧的资源。session.claudeId 照常从后端来——恢复会话的挑选器
  // 用的就是它，只是这一行不再花地方画它。
  // 等你回话时 timeCell 是空的（那句话已经在状态格里），空字符串就别画这一格——
  // 画一个空 span 会因为 margin-left:auto 仍然占住右端的位置。
  const when = timeCell(session);
  if (when) row.append(el("span", "time", when));
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

  const more = el("button", "more");
  more.innerHTML = icon("more", 18);
  more.setAttribute("aria-label", tr("list.actionsFor", { name: session.name }));
  more.addEventListener("click", (e) => {
    // The button sits on top of the card link; do not follow it.
    e.preventDefault();
    e.stopPropagation();
    openActions(session, itemsById);
  });

  wrapper.append(link, more, cardActions(session, itemsById));
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

  const chevron = el("span", "group-chevron");
  chevron.innerHTML = icon(collapsed ? "chevronRight" : "chevronDown", 14);
  // 分组就是目录，所以给它目录的形状。名字被大写、变灰、缩到 0.78rem，在一列
  // 卡片里很容易被当成某张卡的一部分；图标把"这是分隔线不是内容"说在读到文字
  // 之前。
  const folder = el("span", "group-icon");
  folder.innerHTML = icon("folder", 14);
  const name = el("span", "group-name", label);
  if (path) name.title = path;
  head.append(chevron, folder, name);

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

function groupOf(label, path, key, sessions, collapsed, itemsById) {
  const group = el("section", "group" + (collapsed ? " collapsed" : ""));
  group.append(groupHeader(label, path, key, sessions.length, collapsed));
  if (!collapsed)
    for (const session of sessions) group.append(card(session, itemsById));
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
function sections(sessions, itemsById) {
  const out = [];
  const collapsed = collapsedSet();

  const pinned = sessions.filter((s) => s.pinned);
  if (pinned.length) {
    // A sentinel key: the pinned section has no path of its own, and a real
    // path could otherwise collide with it.
    out.push(
      groupOf(
        tr("list.pinnedGroup"), null, "\u0000pinned", pinned,
        collapsed.has("\u0000pinned"), itemsById,
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
    out.push(groupOf(label, path, path, members, collapsed.has(path), itemsById));
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
    // return a bare array; a fresh server wraps it with the work items
    // sessions may be bound to. Keep tolerating the bare-array shape either
    // way — an old page can hit a new server just as easily as the reverse —
    // so `items` simply falls back to empty.
    const { sessions, items } = Array.isArray(body) ? { sessions: body, items: [] } : body;
    const itemsById = new Map((items ?? []).map((item) => [item.id, item]));
    setCount(sessions.length ? tr("list.count", { n: sessions.length }) : "");
    setTabWaiting(sessions.filter((s) => s.idle).length);

    // The banner goes last: restorable records are dead sessions from a past
    // boot, and the live ones are what the page is for. Above the list it
    // pushed the actual work down the screen for a count that never needs
    // acting on right now.
    const children = [
      ...(sessions.length
        ? sections(sessions, itemsById)
        : [el("p", "empty", tr("list.noSessions"))]),
    ];
    if (restorable.length) children.push(restoreBanner(restorable));
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
