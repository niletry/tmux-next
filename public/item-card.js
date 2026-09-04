// @ts-check
/**
 * 一张单画出来的那几块：维度 chip、单号前的徽标、明细浮层、单下面的会话行、
 * 以及卡片头部。
 *
 * 从 items.js 里搬出来的，因为它现在有两个使用者：首页那张卡片，和会话侧点开的
 * 那个浮层（会话列表卡片上的 chip、终端页顶栏的徽标）。两边各画一套 chip 迟早会
 * 对同一份数据给出两种说法，而那种漂移没有任何东西看得见——抽出来是唯一能让它
 * 只有一处的做法。
 *
 * 以画为主：归档、关联已有会话那些只有首页才有的动作留在 items.js 里。会跟着某
 * 一块画法走的动作是例外——会话行上的解绑（sessionRow 的 onUnbind）和「刷新这一
 * 个单」（refreshButton），后者两处入口都要，判断"什么时候能刷"的那点逻辑（
 * claimedProviders）写两遍就会漂。
 *
 * 页面文件不做类型检查（tsconfig 的 checkJs: false），这一层做——它是两处共用的
 * 那一层，src/item-card.test.ts 无头地渲染它。
 */

import { tr } from "./i18n-apply.js";
import { url } from "./root.js";
import { svgShell, icon } from "./icons.js";
import { PLUGINS } from "../plugins/registry.js";

/**
 * @typedef {object} DetailRow
 * @property {string} label
 * @property {string} value
 * @property {"ok"|"warn"|"dim"} [tone]
 * @property {string} [url]
 * @property {string} [group] 不透明的分组标题——含义完全由给出它的插件决定,内核
 *   只认"连续几行 group 相同就画在同一组标题下面"这一件事,不解释文本本身。
 * @property {string} [groupUrl] 组标题旁边那个链接图标指去哪——跟 url 一样只认
 *   内核已经放行过的 http/https 绝对地址。
 */
/**
 * @typedef {object} Facet
 * @property {string} dim 一个 i18n 键，不是显示文本
 * @property {string} value
 * @property {"ok"|"warn"|"dim"} [tone]
 * @property {boolean} [badge]
 * @property {string} [icon] SVG 路径，不是图标名
 * @property {DetailRow[]} [detail]
 */
/**
 * @typedef {object} SessionLike
 * @property {string} name
 * @property {string|null} [turn]
 * @property {boolean} [idle]
 */
/**
 * @typedef {object} ItemLike
 * @property {string} id
 * @property {string} title
 * @property {{ref: string, url?: string} | null} source
 */

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElementTagNameMap[K]}
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 一条会话此刻的状态词。
 *
 * 跟 src/item-facets.ts 的 stateOf 同一套判断：turn 优先（它读的是 transcript 的
 * stop_reason，是记录格式的一部分），读不到才退回屏幕推出来的 idle。两边说法必须
 * 一致——同一个会话在卡片上和在维度里给出不同状态，比没有状态更糟。
 */
/** @param {SessionLike} session */
export function stateOf(session) {
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

/** @param {SessionLike} session */
export function sessionState(session) {
  return AGENT_LABEL[stateOf(session) === "waiting" ? "waiting" : "working"]();
}

/**
 * item.agent 的取值也是内部词（waiting/working/none），字面量映射，理由同
 * AGENT_LABEL 和 list.js:52——死键扫描只认字符串字面量。waiting/working 已经
 * 给 AGENT_LABEL 用过，这里加的是 none：一张单没有会话时那个 chip 该说什么。
 */
export const AGENT_VALUE = {
  waiting: () => tr("items.agent.waiting"),
  working: () => tr("items.agent.working"),
  none: () => tr("items.agent.none"),
};

/**
 * 内核维度的字面量映射表：内核只认识这五个维度，写成表而不是拼 `item.${dim}`，
 * 理由同上——死键扫描看不见拼出来的键名。插件维度不在这张表里，它们的显示名
 * 走 tr(facet.dim) 的通用查找，查不到就退回 dim 本身（下面 facetChip 里）。
 */
export const ITEM_DIM_LABEL = {
  "item.agent": () => tr("item.agent"),
  "item.sessions": () => tr("item.sessions"),
  "item.source": () => tr("item.source"),
  "item.tag": () => tr("item.tag"),
};

/**
 * 一个通用浮层：标题 + 若干行明细 + 关闭。
 *
 * 内核自己的，不复用工单页那个 openSheet——那在插件的 public/ 里，内核 import
 * 插件代码就是把界线反过来越了。几十行的重复，换的是方向正确。
 *
 * 这些行的含义内核一概不知道：它只把 label / value 按 textContent 放进去，
 * tone 决定颜色。是 CI 检查还是别的，只有给出它的插件知道。
 */
/** 一行明细：能点的画成链接，不能点的是纯文字，状态色靠 tone。 */
/** @param {DetailRow} row */
function detailRowLine(row) {
  const line = el("div", "detail-row");
  if (row.url) {
    // 内核只放行 http/https（plugins/handlers.ts 的 safeHttpUrl），到这里已经是
    // 绝对地址。noopener 是因为 target=_blank 会把 window.opener 交给对面。
    const a = document.createElement("a");
    a.className = "detail-label";
    a.href = row.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = row.label;
    line.append(a);
  } else {
    line.append(el("span", "detail-label", row.label));
  }
  line.append(el("span", row.tone ? `detail-state ${row.tone}` : "detail-state", row.value));
  return line;
}

/**
 * 一组可折叠的明细行：标题是真 `<button>`，键盘支持是白拿的（跟设置页的
 * section() 同一个理由）。默认展开——折叠是"我看完这个 PR 了、收起来腾地方"
 * 的手动动作，不该默认就把刚打开的浮层收成一排标题。
 *
 * 折叠按钮和"打开原始链接"是两个并排的控件，不是一个套一个——`<a>` 不能嵌在
 * `<button>` 里，跟会话卡片上单号链接不能套按钮是同一条 HTML 规则（见
 * items.js 的「查看这张单」为什么是并排动作而不是嵌进去）。
 *
 * @param {string} title
 * @param {DetailRow[]} rows
 * @param {string} [groupUrl]
 */
function detailGroup(title, rows, groupUrl) {
  const box = el("div", "detail-group");
  const head = el("div", "detail-group-head");

  const toggle = el("button", "detail-group-toggle");
  toggle.type = "button";
  const chevron = el("span", "detail-group-chevron");
  toggle.append(chevron, el("span", undefined, title));
  head.append(toggle);

  if (groupUrl) {
    const link = document.createElement("a");
    link.className = "detail-group-link";
    link.href = groupUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", tr("items.openOriginal"));
    link.innerHTML = icon("link", 14);
    head.append(link);
  }

  const body = el("div", "detail-group-rows");
  for (const row of rows) body.append(detailRowLine(row));
  box.append(head, body);

  /** @param {boolean} open */
  const paint = (open) => {
    toggle.setAttribute("aria-expanded", String(open));
    chevron.innerHTML = icon(open ? "chevronDown" : "chevronRight", 14);
    body.hidden = !open;
  };
  paint(true);
  toggle.addEventListener("click", () => paint(toggle.getAttribute("aria-expanded") !== "true"));
  return box;
}

/**
 * @param {string} title
 * @param {DetailRow[]} rows
 */
export function openDetailSheet(title, rows) {
  const back = el("div", "sheet-backdrop");
  const sheet = el("div", "sheet");
  const close = () => back.remove();

  sheet.append(el("h2", "sheet-title", title));
  const list = el("div", "detail-list");
  // 连续几行 group 相同才算一组——插件给的行本来就该按组挨着排好，内核不重排、
  // 不去重，只负责把"group 连续相同的这几行"包成一个可折叠的组。没有 group 的
  // 行（比如 PR 列表本身，一行就是一条独立信息）照旧直接画，不折叠——折叠只对
  // "一组东西"有意义，对一条孤零零的信息只是多一次没用的点击。
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.group) {
      const group = [];
      while (i < rows.length && rows[i].group === row.group) group.push(rows[i++]);
      list.append(detailGroup(row.group, group, row.groupUrl));
    } else {
      list.append(detailRowLine(row));
      i++;
    }
  }
  sheet.append(list);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sheet-close";
  btn.textContent = tr("items.close");
  btn.addEventListener("click", close);
  sheet.append(btn);

  // 点背板关闭，但点浮层自身不关——否则想选段文字都会把它关掉。
  back.addEventListener("click", (e) => {
    if (e.target === back) close();
  });
  back.append(sheet);
  document.body.append(back);
}

/**
 * 一个维度 chip。
 *
 * `dim` 是 i18n 键不是显示文本，查不到就退回显示 dim 本身——内核里没有"哪个插件
 * 有哪些维度"的表，维度名跟着数据一起来，这条是这套设计不违反插件界线的关键。
 *
 * `item.agent` 的取值也走字典（waiting/working/none 是内部词，不该给人看）；
 * 别的维度的取值是数据（工单状态、史诗名），原样显示。
 */
/**
 * @param {Facet} facet
 * @param {{showLabel?: boolean}} [opts] showLabel: 强制带上维度名，不管是不是
 *   光秃秃的数字。列表视图用——那边没有表格曾经给的列头，"To Do"、"Sam"这种
 *   值离了列头就读不出是状态还是负责人，必须靠 chip 自己带名字说清楚。卡片上
 *   不传，保持"默认只画值"那条判断（见下面的长注释）。
 */
export function facetChip(facet, opts) {
  const showLabel = opts?.showLabel ?? false;
  // tr() 本身查不到键就退回键名，插件维度（开放集合）和真正没配置的 dim 都
  // 落到这条路；内核的五个维度走上面的字面量表，只是为了不被死键扫描误判。
  const label = dimLabelOf(facet.dim);
  const value = facet.dim === "item.agent" ? agentValueOf(facet.value) : facet.value;
  // 带明细的画成按钮：明细只有点得开才算存在，跟工单页那条检查汇总同一个道理。
  // 内核不知道这些行是什么，只知道"这个维度还有东西可看"。
  const rows = Array.isArray(facet.detail) ? facet.detail : [];
  /** @type {HTMLElement} */
  let chip;
  if (rows.length) {
    const btn = el("button", facet.tone ? `facet has-detail ${facet.tone}` : "facet has-detail");
    btn.type = "button";
    btn.addEventListener("click", () => openDetailSheet(`${label}: ${value}`, rows));
    chip = btn;
  } else {
    chip = el("span", facet.tone ? `facet ${facet.tone}` : "facet");
  }
  // 插件可以给这个 chip 一个形状。内核不问它是什么意思——史诗和缺陷的区别是
  // Jira 的概念，内核一旦认识 epic 就等于认识了一个插件。它只负责套上跟全站
  // 一致的外壳，形状本身已经在服务端被限过长、过滤过标签（见 handlers.ts 的
  // safeIconPaths）。
  if (facet.icon) {
    const mark = el("span", "f-icon");
    mark.innerHTML = svgShell(facet.icon, 13);
    chip.append(mark);
  }
  // 默认只画值，维度名进 title。一行 chip 里"Status / Epic / Assignee"这些词每张
  // 卡片都一样，重复七遍换不来任何信息，却把史诗名和状态挤到了第三行去。
  //
  // 留名字的两种情况：调用方要求（showLabel），或者值自己说不出话——"1"、"0/9"
  // 这种光秃秃的数字脱离维度名就什么都不是，除非插件给了图标，那时图标已经说明
  // 了它是什么，字就多余了（showLabel 时这条"图标说明一切"的让步不生效——列表
  // 里就是缺了列头才要名字，图标不能替调用方作这个判断）。
  if (showLabel || (!facet.icon && BARE_NUMBER.test(value))) {
    chip.append(el("span", "f-dim", label));
  }
  chip.append(el("span", "f-value", value));
  chip.title = `${label}: ${value}`;
  return chip;
}

/**
 * 单号前面那枚徽标：把所有 `badge` 维度收成一枚图标。
 *
 * 图标取第一个带 icon 的 badge 维度（Jira 的类型给的就是缺陷/故事/史诗那几个
 * 形状）。内核不问那形状是什么意思，跟 chip 上的图标同一条规矩——插件给形状，
 * 内核套 svgShell 的外壳。
 *
 * 一个都没给形状时退回画值本身（来源名那种一个词），而不是什么都不画：徽标位空着
 * 时"这张单有外部来源"就只剩单号自己在说，本地单和工单单看起来一模一样。
 *
 * title 里列全部 badge 维度，所以合并不丢信息——鼠标停上去（或读屏）拿到的还是
 * "来源: … · 类型: …"这两句完整的话。
 *
 * @param {Facet[]} badges
 */
export function itemBadge(badges) {
  const title = badges.map((f) => `${dimLabelOf(f.dim)}: ${f.value}`).join(" \u00b7 ");
  const withIcon = badges.find((f) => f.icon);
  const mark = el("span", withIcon ? "item-badge" : "item-badge is-text");
  if (withIcon?.icon) mark.innerHTML = svgShell(withIcon.icon, 14);
  else mark.textContent = badges[0].value;
  mark.title = title;
  mark.setAttribute("aria-label", title);
  return mark;
}

/**
 * 一个维度的显示名。查不到就退回 dim 本身——内核里没有"哪个插件有哪些维度"的表。
 * @param {string} dim
 */
export function dimLabelOf(dim) {
  const lookup = /** @type {Record<string, (() => string) | undefined>} */ (ITEM_DIM_LABEL);
  return lookup[dim]?.() ?? tr(dim);
}

/**
 * item.agent 那三个内部词的显示名。
 * @param {string} value
 */
export function agentValueOf(value) {
  const lookup = /** @type {Record<string, (() => string) | undefined>} */ (AGENT_VALUE);
  return lookup[value]?.() ?? value;
}

/** 纯数字或比值：`1`、`0/9`。这种值离了维度名就读不出意思。 */
const BARE_NUMBER = /^\d+(?:\/\d+)?$/;

/**
 * 这颗 chip 该不该画出来。**只管显示，不动数据**——被挡下的维度照样参与分组和
 * 筛选，否则"按会话数筛"这类能力会跟着一起没了。
 *
 * 目前只有一条：没有会话时不画 `item.sessions`。`item.agent` 那颗已经写着"无会话"，
 * 两颗 chip 说同一件事，是这张卡片上密度最低的一处。这是内核对**自己**那几个维度
 * 的判断（它们是封闭集合），不涉及任何插件维度——插件的 chip 一律照画。
 */
/** @param {Facet} facet */
export function chipVisible(facet) {
  // badge 维度不进 chip 行：它们已经画在单号前面那枚徽标里了（itemBadge）。
  // 跟下面那条一样只管显示——分组和筛选照旧看得见它们。
  if (facet.badge) return false;
  return !(facet.dim === "item.sessions" && facet.value === "0");
}

/**
 * 解绑前问一句。
 *
 * 解绑本身不毁东西——会话还在跑，重新挂回去是两下点击——但它是"一点就生效、
 * 生效后卡片上那一行立刻消失"的动作，而这个 × 就贴在整行链接旁边，误触的代价
 * 是你得先想起来它原来挂在哪张单下。所以要一句确认，用的是 list.js 里 endSession
 * 那套同样的 .sheet-backdrop / .btn，不是浏览器的 confirm()：那个在手机上是系统弹窗，
 * 跟整页的观感对不上，也没法带上会话名。
 *
 * 确认键不用 .danger：红色在这套界面里留给"结束会话"那种真的会丢东西的动作，
 * 解绑跟它不是一回事。
 *
 * @param {string} name 会话名
 */
/**
 * @param {string} name
 * @param {() => Promise<void>} onConfirm
 */
function confirmUnbind(name, onConfirm) {
  const back = el("div", "sheet-backdrop");
  const sheet = el("div", "sheet");
  const close = () => back.remove();

  sheet.append(el("h2", "sheet-title", tr("items.unlink")));
  sheet.append(el("p", "sheet-name", name));

  const actions = el("div", "sheet-actions");
  const cancel = el("button", "btn", tr("items.cancel"));
  const confirm = el("button", "btn primary", tr("items.unlink"));
  cancel.type = "button";
  confirm.type = "button";
  actions.append(cancel, confirm);
  sheet.append(actions);

  cancel.addEventListener("click", close);
  back.addEventListener("click", (e) => {
    if (e.target === back) close();
  });
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    try {
      await onConfirm();
      close();
    } catch {
      // 留着浮层：错误提示归调用方，这里只是让人还能再点一次或退出。
      confirm.disabled = false;
    }
  });

  back.append(sheet);
  document.body.append(back);
}

/**
 * 一张单下的一行会话：它现在什么状态，点进去，以及（给了 onUnbind 时）把它从
 * 这张单上解下来。别的动作仍然在会话页上。
 *
 * onUnbind 只在单卡片里传——「未归单」那一区的会话本来就没挂在谁下面，画一个
 * 解不开任何东西的 × 只会让人怀疑自己记错了（跟 list.js 里"没挂才不给解除"
 * 同一条理由）。
 *
 * 参数名是 `target`，不是 `session`——terminal.js 只读 `target`（见它开头那行
 * `searchParams.get("target")`），会话列表与通知落点用的也都是它。这里曾经写成
 * `session=`，结果链接看着对、点进去却打不开会话，而当时的测试只断言了 href 里
 * 含会话名，没断言参数名，所以没抓住。
 */
/**
 * @param {SessionLike} session
 * @param {(() => Promise<void>) | null} [onUnbind]
 */
export function sessionRow(session, onUnbind) {
  const link = el("a", "item-session");
  link.href = url(`terminal.html?target=${encodeURIComponent(session.name)}`);
  link.append(el("span", "s-name", session.name));
  link.append(el("span", "s-state", sessionState(session)));
  link.append(el("span", "s-open", tr("items.open")));
  if (!onUnbind) return link;

  // 挂错了要能就地解开。外面套一层，而不是把按钮塞进 <a> 里——button 嵌在
  // anchor 里既不合法，点它也会顺带触发导航。`.item-session` 仍然是那条链接
  // 本身，所以样式和既有断言都不用跟着改。
  const row = el("div", "item-session-row");
  row.append(link);
  const unbind = el("button", "item-unbind", "\u00d7");
  unbind.type = "button";
  unbind.title = tr("items.unlink");
  unbind.setAttribute("aria-label", tr("items.unlink"));
  unbind.addEventListener("click", () => {
    confirmUnbind(session.name, async () => {
      const res = await fetch(
        url(`api/items/bind?session=${encodeURIComponent(session.name)}`),
        { method: "DELETE" },
      );
      if (!res.ok) {
        // 这一步没改成任何东西，所以不重画——重画只会原地抖一下又回到原样。
        alert(tr("push.actionFailed"));
        throw new Error(String(res.status));
      }
      await onUnbind();
    });
  });
  row.append(unbind);
  return row;
}

/**
 * 卡片头部：标题、单号前那枚徽标、单号本身，以及有几个会话。
 *
 * 不含右上角那三个动作（首页的 ⋯）：那是首页的事，浮层是只读的。调用方拿到这个
 * 元素之后想往里塞什么都行——首页塞的就是它的 itemMore()。
 *
 * @param {ItemLike} item
 * @param {Facet[]} facets
 * @param {number} sessionCount
 */
export function itemHead(item, facets, sessionCount) {
  const head = el("div", "item-head");
  // 链接只从 source.url 来，且只在它存在时才画成链接：url 是那个外部系统自己的
  // 路由，只有产生这个 source 的一方才知道怎么拼——内核不该替它猜（尤其不该假定
  // "provider 名字就是插件 id、插件页都在 p/<id>/ 下接受 ?key="，那是两回事，也没
  // 有任何插件的页面真的读 ?key=）。source.ref 的徽标不管有没有 url 都画，它本身
  // 就是有用的信息。
  head.append(el("h2", "item-title", item.title));
  // 来源和类型合成的那枚徽标，排在单号前面——"Jira 上的一个缺陷"读成一枚图标
  // 加一个单号，而不是标题下面两格从来不变的 chip。
  const badges = (facets ?? []).filter((f) => f.badge && f.value);
  if (badges.length) head.append(itemBadge(badges));
  if (item.source) {
    // 链接挂在单号徽标上，不挂标题：徽标本来就是"远端那个东西的标识"，而点一段
    // 长标题跳去外部系统是意料之外的事——标题读起来像标题，不像出口。
    // 新窗口打开：那是另一个系统，把人从这份列表里带走等于让他重新找回原来的位置。
    // target=_blank 必须配 rel=noopener，否则对面拿得到 window.opener。
    if (item.source.url) {
      const link = el("a", "item-source is-link", item.source.ref);
      link.href = item.source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = item.source.url;
      head.append(link);
    } else {
      head.append(el("span", "item-source", item.source.ref));
    }
  }
  if (sessionCount) head.append(el("span", "item-count", tr("items.sessions", { n: sessionCount })));
  return head;
}


/**
 * 服务端到底认领了哪些 source.provider。
 *
 * `item.source` 单独一件事只说明这张单**有**来源，不说明**有谁能刷它**——
 * /api/plugins 只答启用的插件 id，从来不答它们的 provides，浏览器手上唯一能
 * 拼出"这个 provider 被谁认领了"这件事的数据，是同构的 registry.js（跟 nav.js
 * 画 tab 用的是同一份 import），拿它跟 /api/plugins 的启用 id 取交集。
 *
 * 问不到就当没人认领：画一个几乎必然 404 的按钮，比不画更糟——TMUX_NEXT_DISABLE_
 * PLUGINS 关掉一个插件时，它的刷新入口也该跟着它的 tab、它的 /api/<id> 一起消失，
 * 而不是留在页面上等着点了才报错。
 *
 * @returns {Promise<Set<string>>}
 */
export async function claimedProviders() {
  try {
    const res = await fetch(url("api/plugins"));
    if (!res.ok) throw new Error(String(res.status));
    const ids = await res.json();
    const enabled = new Set(Array.isArray(ids) ? ids : []);
    const out = new Set();
    for (const p of PLUGINS) {
      if (!enabled.has(p.id)) continue;
      for (const provider of p.provides ?? []) out.add(provider);
    }
    return out;
  } catch {
    return new Set();
  }
}

/**
 * 去外部来源那边重新问一次这张单。
 *
 * 成功了让调用方整个重画，不在本地拼装变化后的状态——服务端才是真相，刷新可能
 * 把标题、状态、检查全换掉。
 *
 * 404 = 那张单没有可刷的东西（单没了、没来源、没有插件认领这个来源）。三种情况
 * 故意收拢成一种：提示一次，不重画——那张单没变，重画只会抖一下又变回原样。
 * 失败复用 push.actionFailed，那是站里唯一一个已有的"操作失败"通用键。
 *
 * @param {*} item
 * @param {() => Promise<void>} onChange
 */
async function refreshItem(item, onChange) {
  try {
    const res = await fetch(url(`api/items/${encodeURIComponent(item.id)}/refresh`), { method: "POST" });
    if (res.ok) {
      await onChange();
      return;
    }
    alert(tr("push.actionFailed"));
  } catch {
    alert(tr("push.actionFailed"));
  }
}

/**
 * 「刷新」。
 *
 * 它在首页是从 ⋯ 里搬回卡片行上的：盯着一张单的 PR 或状态时，这是几分钟就要按
 * 一次的动作，而 ⋯ 是"偶尔用一次"的抽屉——把每分钟要按的东西放进抽屉，等于每次
 * 都多两步。关联已有会话（一张单一辈子按几次）和归档（按一次就再也见不到这张单）
 * 留在里面。
 *
 * 会话侧那个只读浮层里也是这一颗，不是另写一个：两处各写一遍"什么时候能刷、刷
 * 失败说什么"，迟早会对同一张单给出两种说法，而这种漂移没有任何东西看得见——这
 * 跟 chip 抽到这个文件里是同一条理由。它没有破坏浮层的只读：刷新不改这张单的
 * 任何东西，它只是把远端此刻的说法再问一遍，而"远端此刻怎么说"正是你干活这段
 * 时间里唯一会变的东西。
 *
 * 只在有来源、且真有启用的插件认领那个来源时才画（见 claimedProviders）：一个
 * 必然 404 的按钮比没有这个按钮更糟。
 *
 * 请求期间禁用自己，而不是拦一个"正在刷"的标志位——按钮就是这个状态唯一的宿主，
 * 它自己灰掉既是防重复点击，也是唯一需要的反馈。
 *
 * @param {*} item
 * @param {() => Promise<void>} onChange
 */
export function refreshButton(item, onChange) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "item-refresh";
  btn.innerHTML = icon("refresh");
  btn.append(document.createTextNode(tr("items.refresh")));
  btn.title = tr("items.refresh");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await refreshItem(item, onChange);
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}
