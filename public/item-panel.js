// @ts-check
/**
 * 反过来看：这条会话（或这张会话卡）挂在哪张单下，那张单此刻怎么样。
 *
 * 首页是单 → 会话，这个浮层是会话 → 单。它只读：状态、PR、检查、这张单底下还有
 * 哪些会话；归档、解绑那些留在首页。理由是它开在你正干活的地方——终端页和会话
 * 列表——那里要的是"瞄一眼"，不是"顺手改点什么"。
 *
 * 「刷新这一个单」是这条界线上唯一的动作，因为它并不改这张单：它去远端把此刻的
 * 说法再问一遍，而"远端此刻怎么说"（工单状态、PR 的检查）正是你干活这段时间里
 * 唯一会变的东西。浮层每次打开都重新取，本来就是为了不给你一份越看越旧的快照，
 * 但那份数据自己是五分钟一档的缓存——盯着一次 CI 时，没有这颗按钮就只剩"回首页
 * 找到那张单再点一次"，而你正在终端里。按钮本身就是首页卡片上那一颗
 * （item-card.js 的 refreshButton），不是照着又写一遍。
 *
 * 画法全部来自 item-card.js，跟首页卡片是同一份代码：两边各画一套 chip，迟早会对
 * 同一份数据给出两种说法。
 *
 * 宽窄两种形态是 CSS 的事（.panel-backdrop 在 900px 以上变成浮窗，以下还是从底部
 * 升起的 sheet），这里不读 matchMedia——那样就要自己管窗口变化和重画时机，而这个
 * 判断背后没有任何状态。
 */

import { url } from "./root.js";
import { tr } from "./i18n-apply.js";
import {
  itemHead,
  facetChip,
  chipVisible,
  sessionRow,
  claimedProviders,
  refreshButton,
} from "./item-card.js";

/**
 * @typedef {object} PanelQuery
 * @property {string} [id] 单号
 * @property {string} [session] 会话名（终端页只知道这个）
 */

/** 当前开着的那一个。同一时刻只允许一个，见 openItemPanel。 */
let current = /** @type {null | (() => void)} */ (null);

/**
 * @param {PanelQuery} query
 * @returns {Promise<{item: any, sessions: any[], facets: any[]} | null>}
 */
async function fetchDetail(query) {
  const path = query.id
    ? `api/items/${encodeURIComponent(query.id)}`
    : `api/items/by-session?session=${encodeURIComponent(query.session ?? "")}`;
  try {
    const res = await fetch(url(path));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * 开一个浮层，回填之后返回背板元素。
 *
 * 取不到就开一个只说一句话的浮层，而不是什么都不发生：入口是照着请求那一刻的
 * 绑定画的，而单可能刚被归档扫掉、服务可能刚重启——点了没反应会让人以为是自己
 * 点空了，那比一句"这会儿看不到"更糟。三种失败（没挂单、单没了、请求失败）在这
 * 里收敛成同一句，跟内核那三个 404 收敛成同一个响应是同一条理由。
 *
 * @param {PanelQuery} query
 * @param {{onClose?: () => void}} [opts]
 */
export async function openItemPanel(query, opts = {}) {
  // 连点两下不叠第二层：把已经开着的那个先关掉，新的那次照常回调它的 onClose。
  if (current) current();

  // 两次请求彼此独立，串起来只是白等一次往返；claimedProviders() 自己兜住失败、
  // 从不抛，所以这里不需要 allSettled。
  const [detail, claimed] = await Promise.all([fetchDetail(query), claimedProviders()]);

  const backdrop = document.createElement("div");
  backdrop.className = "sheet-backdrop panel-backdrop";
  const sheet = document.createElement("div");
  sheet.className = "sheet item-panel";

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (current === close) current = null;
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    opts.onClose?.();
  };
  /** @param {KeyboardEvent} e */
  function onKey(e) {
    if (e.key !== "Escape") return;
    // 终端页整页都在收键盘：Esc 必须停在这里，否则关掉浮层的同时还往会话里
    // 送了一个 Esc。
    e.preventDefault();
    e.stopPropagation();
    close();
  }

  /**
   * 把浮层里的内容整个重画一遍。
   *
   * 刷新之后重画的是这一层，不是整页：调用方（终端页、会话列表）身后那一页跟这张
   * 单没有关系，为了一枚 chip 变色去重画一个正开着的终端，代价和收益完全不成比例。
   * 就地重画而不是关掉重开，是因为重开会走 openItemPanel 开头那句"先关已开的"，
   * 顺带调一次调用方的 onClose——终端页拿它放下 modalOpen，焦点会在刷新的一瞬间
   * 被抢回终端。
   *
   * @param {{item: any, sessions: any[], facets: any[]} | null} data
   */
  function fill(data) {
    sheet.textContent = "";

    if (data?.item) {
      const facets = Array.isArray(data.facets) ? data.facets : [];
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      sheet.append(itemHead(data.item, facets, sessions.length));

      const shown = facets.filter(chipVisible);
      if (shown.length) {
        const row = document.createElement("div");
        row.className = "facets";
        for (const facet of shown) row.append(facetChip(facet));
        sheet.append(row);
      }

      // 解绑不给：这是只读的一眼，改绑定在首页和会话列表上都有入口。
      for (const session of sessions) sheet.append(sessionRow(session, null));

      if (data.item.source && claimed.has(data.item.source.provider)) {
        const actions = document.createElement("div");
        actions.className = "item-actions";
        // 刷完按 id 再取一次，不按打开时那个 query：入口可能是会话名，而重画的
        // 目标从来是这张单本身——按会话名再问一遍，中间要是刚解绑就变成 404。
        const again = async () => fill(await fetchDetail({ id: data.item.id }));
        actions.append(refreshButton(data.item, again));
        sheet.append(actions);
      }
    } else {
      const line = document.createElement("p");
      line.className = "sheet-error";
      line.textContent = tr("items.offline");
      sheet.append(line);
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sheet-close";
    btn.textContent = tr("items.close");
    btn.addEventListener("click", close);
    sheet.append(btn);
  }

  fill(detail);

  // 点背板关闭，点浮层自身不关——否则想选一段单号都会把它关掉。
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.append(sheet);
  document.body.append(backdrop);
  document.addEventListener("keydown", onKey, true);
  current = close;
  return backdrop;
}

/**
 * 终端页顶栏上的那枚入口：这条会话挂在哪张单下。
 *
 * 挂着就画一枚写着单号（本地单退回标题）的按钮，没挂就什么都不画——顶栏在最窄的
 * 屏幕上每一格宽度都要用在刀刃上，一个说"没有"的占位符换不来任何东西。
 *
 * 逻辑放在这里而不是 terminal.js 里，是为了它能被无头地渲染：terminal.js 要拉起
 * xterm 才跑得起来，而"挂没挂单、挂着时画什么"跟终端本身无关。
 *
 * onOpen/onClose 给的是终端页的 modalOpen（见 focus-restore.js）：浮层开着的时候
 * 焦点不能被抢回终端，否则点进浮层里的链接会先被终端把焦点夺走。
 *
 * @param {string} session 会话名
 * @param {HTMLElement} container 顶栏容器
 * @param {{onOpen?: () => void, onClose?: () => void}} [hooks]
 */
export async function mountItemEntry(session, container, hooks = {}) {
  const detail = await fetchDetail({ session });
  const item = detail?.item;
  if (!item) return null;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "term-item";
  btn.textContent = item.source?.ref || item.title;
  // 跟会话列表上那个动作是同一句话，所以是同一个键。
  btn.title = tr("list.viewItem");
  btn.setAttribute("aria-label", tr("list.viewItem"));
  btn.addEventListener("click", () => {
    hooks.onOpen?.();
    // 重新取一次，不复用刚才那份：顶栏那枚按钮是页面打开时画的，而单的状态、PR
    // 的检查正是会在你干活的这段时间里变的东西——浮层若拿开页时的快照，就成了
    // 一个越看越旧的东西。
    openItemPanel({ session }, { onClose: () => hooks.onClose?.() });
  });
  container.append(btn);
  return btn;
}
