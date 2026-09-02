import { initTheme } from "./theme-apply.js";
import { initLang, tr } from "./i18n-apply.js";
import { renderHeader } from "./nav.js";
import { url } from "./root.js";
import { dimensionsOf, valuesOf, groupItems, filterItems, pruneSelection } from "./facet-view.js";
import { openPicker } from "./pick-sheet.js";
import { icon, svgShell } from "./icons.js";
import { PLUGINS } from "../plugins/registry.js";

// Before anything renders: paints the cached theme synchronously, then
// reconciles with the machine's stored choice.
initTheme();
initLang().then(async () => {
  // After the language is known: the nav labels come from the dictionary.
  // Awaited, not fired-and-forgotten: renderHeader() is what creates #count
  // (see the comment below), and render()'s first setCount() call was racing
  // it — fetch("api/plugins") inside renderHeader and fetch("api/items") here
  // both resolve in the same tick, and whichever settles first decides whether
  // #count exists yet. Losing the race meant setCount() silently wrote to a
  // node that didn't exist, and it never got a text node created after the
  // fact — worst case was a blank count for up to one 5-second poll interval
  // (see setInterval(refresh, 5000) below), not "permanently blank" as an
  // earlier version of this comment claimed.
  await renderHeader("items");
  render();
});

// `#items` is a static <main> in index.html, present before this module runs
// — unlike `#count` below, which renderHeader() creates later — so grabbing
// it once at module load is safe.
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

/**
 * item.agent 的取值也是内部词（waiting/working/none），字面量映射，理由同
 * AGENT_LABEL 和 list.js:52——死键扫描只认字符串字面量。waiting/working 已经
 * 给 AGENT_LABEL 用过，这里加的是 none：一张单没有会话时那个 chip 该说什么。
 */
const AGENT_VALUE = {
  waiting: () => tr("items.agent.waiting"),
  working: () => tr("items.agent.working"),
  none: () => tr("items.agent.none"),
};

/**
 * 内核维度的字面量映射表：内核只认识这五个维度，写成表而不是拼 `item.${dim}`，
 * 理由同上——死键扫描看不见拼出来的键名。插件维度不在这张表里，它们的显示名
 * 走 tr(facet.dim) 的通用查找，查不到就退回 dim 本身（下面 facetChip 里）。
 */
const ITEM_DIM_LABEL = {
  "item.agent": () => tr("item.agent"),
  "item.sessions": () => tr("item.sessions"),
  "item.source": () => tr("item.source"),
  "item.tag": () => tr("item.tag"),
};

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
 * 一个通用浮层：标题 + 若干行明细 + 关闭。
 *
 * 内核自己的，不复用工单页那个 openSheet——那在插件的 public/ 里，内核 import
 * 插件代码就是把界线反过来越了。几十行的重复，换的是方向正确。
 *
 * 这些行的含义内核一概不知道：它只把 label / value 按 textContent 放进去，
 * tone 决定颜色。是 CI 检查还是别的，只有给出它的插件知道。
 */
function openDetailSheet(title, rows) {
  const back = el("div", "sheet-backdrop");
  const sheet = el("div", "sheet");
  const close = () => back.remove();

  sheet.append(el("h2", "sheet-title", title));
  const list = el("div", "detail-list");
  for (const row of rows) {
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
    list.append(line);
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
 * 新建一张本地单：只要一个标题。
 *
 * 单只有标题是够的——单是工作单元，目录、标签这些是它之后长出来的东西，开会话时
 * 各自会选。开一个只有一格输入的浮层，而不是跳一个页面：这是个两秒钟的动作，跳页
 * 会把当前的分组和筛选丢掉，回来还得重新找到刚才看的地方。
 *
 * @param {() => void} onDone 建成之后重画列表
 */
function openNewItemSheet(onDone) {
  const back = el("div", "sheet-backdrop");
  const sheet = el("div", "sheet");
  const close = () => back.remove();

  sheet.append(el("h2", "sheet-title", tr("items.newItem")));

  const input = document.createElement("input");
  input.type = "text";
  input.className = "sheet-input";
  input.placeholder = tr("items.newItemPlaceholder");
  input.maxLength = 200;
  sheet.append(input);

  const err = el("p", "sheet-error", "");
  err.hidden = true;
  sheet.append(err);

  const row = el("div", "sheet-actions");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "sheet-close";
  cancel.textContent = tr("items.cancel");
  cancel.addEventListener("click", close);

  const create = document.createElement("button");
  create.type = "button";
  create.className = "sheet-create";
  create.textContent = tr("items.create");
  create.disabled = true;

  // 空标题的建单请求服务端会 400，与其让人点了才知道，不如按不下去。
  input.addEventListener("input", () => {
    create.disabled = !input.value.trim();
  });

  let busy = false;
  const submit = async () => {
    const title = input.value.trim();
    if (!title || busy) return;
    busy = true;
    create.disabled = true;
    create.textContent = tr("items.creating");
    err.hidden = true;
    try {
      const res = await fetch(url("api/items"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error(String(res.status));
      close();
      onDone();
      return;
    } catch {
      // 浮层留着、输入留着：失败之后最不该做的事是把人刚打的字扔掉。
      err.textContent = tr("items.createFailed");
      err.hidden = false;
      busy = false;
      create.disabled = false;
      create.textContent = tr("items.create");
    }
  };
  create.addEventListener("click", submit);
  // 打完字直接回车，不用去够按钮——手机上这是唯一顺手的提交方式。
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
    else if (e.key === "Escape") close();
  });

  row.append(cancel);
  row.append(create);
  sheet.append(row);

  back.addEventListener("click", (e) => {
    if (e.target === back) close();
  });
  back.append(sheet);
  document.body.append(back);
  input.focus();
}

function facetChip(facet) {
  // tr() 本身查不到键就退回键名，插件维度（开放集合）和真正没配置的 dim 都
  // 落到这条路；内核的五个维度走上面的字面量表，只是为了不被死键扫描误判。
  const label = ITEM_DIM_LABEL[facet.dim]?.() ?? tr(facet.dim);
  const value = facet.dim === "item.agent" ? (AGENT_VALUE[facet.value]?.() ?? facet.value) : facet.value;
  // 带明细的画成按钮：明细只有点得开才算存在，跟工单页那条检查汇总同一个道理。
  // 内核不知道这些行是什么，只知道"这个维度还有东西可看"。
  const rows = Array.isArray(facet.detail) ? facet.detail : [];
  const chip = rows.length
    ? document.createElement("button")
    : el("span", facet.tone ? `facet ${facet.tone}` : "facet");
  if (rows.length) {
    chip.type = "button";
    chip.className = facet.tone ? `facet has-detail ${facet.tone}` : "facet has-detail";
    chip.addEventListener("click", () => openDetailSheet(`${label}: ${value}`, rows));
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
  // 唯一留下名字的情况：值自己说不出话。"1"、"0/9" 这种光秃秃的数字脱离维度名就
  // 什么都不是——除非插件给了图标，那时图标已经说明了它是什么，字就多余了。
  if (!facet.icon && BARE_NUMBER.test(value)) chip.append(el("span", "f-dim", label));
  chip.append(el("span", "f-value", value));
  chip.title = `${label}: ${value}`;
  return chip;
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
function chipVisible(facet) {
  return !(facet.dim === "item.sessions" && facet.value === "0");
}

/**
 * 一张单下的一行会话：它现在什么状态，点进去。别的动作在会话页上。
 *
 * 参数名是 `target`，不是 `session`——terminal.js 只读 `target`（见它开头那行
 * `searchParams.get("target")`），会话列表与通知落点用的也都是它。这里曾经写成
 * `session=`，结果链接看着对、点进去却打不开会话，而当时的测试只断言了 href 里
 * 含会话名，没断言参数名，所以没抓住。
 */
function sessionRow(session) {
  const row = el("a", "item-session");
  row.href = url(`terminal.html?target=${encodeURIComponent(session.name)}`);
  row.append(el("span", "s-name", session.name));
  row.append(el("span", "s-state", sessionState(session)));
  row.append(el("span", "s-open", tr("items.open")));
  return row;
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
async function claimedProviders() {
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
 * 单张单的动作：刷新（有来源、且有启用的插件认领那个来源才画）、归档/取消归档
 * （永远画）。
 *
 * 两个动作都是"点了就打一次接口，成功了就整页重新 render()"——不在本地拼装
 * 变化后的状态，因为服务端才是真相（尤其刷新，它可能把标题、状态都换了）。
 * 失败复用 push.js 已有的 push.actionFailed：这是唯一一个已经存在、语义是
 * "操作失败"的通用键，没有必要为这两个动作各造一个新键。
 *
 * @param {*} item
 * @param {Set<string>} claimed
 * @param {() => Promise<void>} onChange
 */
function itemActions(item, claimed, onChange, link) {
  const wrap = el("div", "item-actions");

  // 把一个已经跑着的会话挂到这张单下。后端按会话名覆盖写，所以选一个已经挂在
  // 别处的会话就是"改挂"——这正是想要的语义，一个会话同时属于两张单说不通。
  const linkBtn = document.createElement("button");
  linkBtn.type = "button";
  linkBtn.className = "item-link";
  linkBtn.innerHTML = icon("link");
  linkBtn.append(document.createTextNode(tr("items.linkSession")));
  linkBtn.addEventListener("click", () => {
    openPicker({
      title: tr("items.linkSession"),
      options: link.sessions.map((s) => {
        const holder = link.itemOf.get(s.name);
        return {
          id: s.name,
          label: s.name,
          note:
            holder && holder !== item.id
              ? tr("items.boundTo", { title: link.titleOf.get(holder) ?? holder })
              : undefined,
          current: holder === item.id,
        };
      }),
      emptyText: tr("items.noSessions"),
      cancelText: tr("items.cancel"),
      failedText: tr("items.linkFailed"),
      onPick: async (name) => {
        const res = await fetch(url(`api/items/${encodeURIComponent(item.id)}/bind`), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session: name }),
        });
        if (!res.ok) throw new Error(String(res.status));
        await onChange();
      },
    });
  });
  wrap.append(linkBtn);

  if (item.source && claimed.has(item.source.provider)) {
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "item-refresh";
    refresh.innerHTML = icon("refresh");
    refresh.append(document.createTextNode(tr("items.refresh")));
    refresh.title = tr("items.refresh");
    refresh.addEventListener("click", async () => {
      refresh.disabled = true;
      try {
        const res = await fetch(url(`api/items/${encodeURIComponent(item.id)}/refresh`), { method: "POST" });
        if (res.ok) {
          await onChange();
          return;
        }
        // 404 = 那张单没有可刷的东西（单没了、没来源、没有插件认领这个来源）。
        // 三种情况故意收拢成一种：提示一次，不重画——那张单没变，重画只会抖一下
        // 又变回原样。
        alert(tr("push.actionFailed"));
      } catch {
        alert(tr("push.actionFailed"));
      } finally {
        refresh.disabled = false;
      }
    });
    wrap.append(refresh);
  }

  const archived = Boolean(item.closedAt);
  const archive = document.createElement("button");
  archive.type = "button";
  archive.className = "item-archive";
  archive.innerHTML = icon("archive");
  archive.append(document.createTextNode(archived ? tr("items.unarchive") : tr("items.archive")));
  archive.addEventListener("click", async () => {
    archive.disabled = true;
    try {
      const res = await fetch(url(`api/items/${encodeURIComponent(item.id)}`), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        // 归档不是删除：取消归档就是把 closedAt 送回 null，绑定和标签原样留着。
        body: JSON.stringify({ closedAt: archived ? null : Math.floor(Date.now() / 1000) }),
      });
      if (res.ok) await onChange();
      else alert(tr("push.actionFailed"));
    } catch {
      alert(tr("push.actionFailed"));
    } finally {
      archive.disabled = false;
    }
  });
  wrap.append(archive);

  return wrap;
}

/**
 * 单卡片。
 *
 * 「再开一个会话」永远在，不是「打开」——一张单多个会话是常态，不是边角情况。
 */
function itemCard(item, sessions, facets, claimed, onChange, link) {
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

  // facets 可能是 undefined（老后端没这个字段）或空数组——两种都不画这行容器，
  // 不抛。
  const shown = (facets ?? []).filter(chipVisible);
  if (shown.length) {
    const row = el("div", "facets");
    for (const facet of shown) row.append(facetChip(facet));
    card.append(row);
  }

  for (const session of sessions) card.append(sessionRow(session));

  // 三个动作并成一行：开会话是主动作（保留 accent 底色），刷新和归档是维护动作，
  // 都收成小按钮靠右。之前它们占了三行——两个半宽按钮加一条整宽的开会话——在
  // 一屏几十张卡片的列表里，光是卡片自己的操作区就吃掉了大半屏。
  const actions = itemActions(item, claimed, onChange, link);
  const more = el("a", "item-new");
  more.innerHTML = icon("plus");
  more.append(
    document.createTextNode(sessions.length ? tr("items.newSession") : tr("items.firstSession")),
  );
  more.href = url(`new.html?item=${encodeURIComponent(item.id)}`);
  actions.prepend(more);
  card.append(actions);
  return card;
}

/**
 * 分组/筛选的选择存在哪块屏幕上，是设备的事——跟字号同类，不是"这台机器"的事
 * （主题才是）。两把键各管一半状态，互不影响对方的降级路径。
 */
const GROUP_KEY = "tmux-next.items.groupBy";
const FILTER_KEY = "tmux-next.items.filter";
const FIELDS_KEY = "tmux-next.items.fields";
const SHOW_ARCHIVED_KEY = "tmux-next.items.showArchived";

// 手机上第一眼要回答的是"该我动了吗"，所以默认分组维度是 agent 状态而不是随便
// 一个维度或不分组。
const DEFAULT_GROUP_DIM = "item.agent";

/**
 * 读存下来的分组维度。
 *
 * 隐私窗口里碰 localStorage 本身就可能抛，读写都要包 try/catch。存的维度在当前
 * 数据里已经不存在了（插件卸载、这批单恰好没打那个标签）就退回默认，而不是把
 * 一个查无此维度的选择原样交给 groupItems——那样只会画出一个空页，用户看不出
 * 是"没数据"还是"选错了"。`""` 是「不分组」的合法值，不受这条限制。
 * @param {string[]} dims
 */
function loadGroupBy(dims) {
  let stored = null;
  try {
    stored = localStorage.getItem(GROUP_KEY);
  } catch {
    stored = null;
  }
  if (stored === null) return DEFAULT_GROUP_DIM;
  if (stored === "" || dims.includes(stored)) return stored;
  return DEFAULT_GROUP_DIM;
}

function saveGroupBy(dim) {
  try {
    localStorage.setItem(GROUP_KEY, dim);
  } catch {
    // 隐私窗口：记不住就记不住，不是页面能崩的理由。
  }
}

/**
 * 读存下来的筛选选择。JSON 坏了（手改、旧版本写的形状不同）当作没有筛选，
 * 不是当作"什么都不匹配"——前者是安全的默认，后者会让页面看起来像坏了。
 */
function loadFilter() {
  let raw = null;
  try {
    raw = localStorage.getItem(FILTER_KEY);
  } catch {
    raw = null;
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveFilter(selected) {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(selected));
  } catch {
    // 同上。
  }
}

/**
 * 哪些字段被加进了筛选区。
 *
 * 筛选是**按需加字段**，不是把数据里每个维度都摊开：维度是开放集合，插件随时能
 * 再贴几个，全摊开就是几十个取值挤成一片，谁属于哪个字段都看不出来。哪些字段值
 * 得筛是使用者的判断，不是这个文件该替他做的——所以默认一个都不加，由「添加字
 * 段」按需取用。
 *
 * 默认空还有一层好处：分组选择器已经给出了首屏最要紧的那个信号（默认按 agent
 * 状态分组），筛选是精简结果用的第二层，不该在你没要求时先占掉半屏。
 *
 * 返回的是**存下来的原样**，不按当前数据过滤——过滤只发生在渲染那一步。一个维度
 * 暂时没出现在这批单里（插件停用、这批单没打那个标签），它这一行只是不画，不该被
 * 从存储里抹掉；抹掉的话维度回来时你还得重加一遍。
 * @returns {string[]}
 */
function loadFields() {
  let raw = null;
  try {
    raw = localStorage.getItem(FIELDS_KEY);
  } catch {
    raw = null;
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d) => typeof d === "string");
  } catch {
    return [];
  }
}

function saveFields(fields) {
  try {
    localStorage.setItem(FIELDS_KEY, JSON.stringify(fields));
  } catch {
    // 同上。
  }
}

/**
 * 「显示已归档」是设备偏好，跟分组/筛选/字段那三把键同一类——不是"这台机器"的
 * 事（那是主题），存在 localStorage，读写都包 try/catch。
 */
function loadShowArchived() {
  try {
    return localStorage.getItem(SHOW_ARCHIVED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveShowArchived(value) {
  try {
    localStorage.setItem(SHOW_ARCHIVED_KEY, value ? "1" : "0");
  } catch {
    // 隐私窗口：记不住就记不住，不是页面能崩的理由。
  }
}

/**
 * 同步的进行中状态是模块级的，不是某次 draw() 闭包里的——它要跨越"点击时的这次
 * draw()"和"同步完成后触发的整页 render()"存活，后者会重新执行 draw() 生成全新
 * 的工具条节点，只有读同一个模块变量才能让新节点接着显示上一步的结果。
 */
let syncing = false;
let syncMessage = "";

/**
 * 顶栏「同步」：进行中禁用按钮、文案换成 items.syncing；完成后整页 render()，
 * 新工具条会读到这里更新过的 syncMessage。truncated 是「我们没问全」，跟「就这
 * 么多」是两回事，收到就额外说出来，不能悄悄吞掉。
 */
async function doSync() {
  if (syncing) return;
  syncing = true;
  syncMessage = "";
  // 立刻反馈，不等下面的整页 render()：网络慢的时候按钮要马上显得"按下去了"。
  const btn = document.getElementById("sync-items");
  if (btn) {
    btn.disabled = true;
    btn.textContent = tr("items.syncing");
  }
  try {
    const res = await fetch(url("api/items/sync"), { method: "POST" });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    let msg = tr("items.syncDone", { created: data?.created ?? 0, updated: data?.updated ?? 0 });
    if (data?.truncated) msg += " " + tr("items.syncTruncated", { n: data?.total ?? 0 });
    syncMessage = msg;
  } catch {
    syncMessage = tr("items.syncFailed");
  } finally {
    syncing = false;
  }
  await render(true);
}

/** 维度显示名：内核维度走字面量表，插件维度走通用字典查找，理由同 facetChip。 */
function dimLabel(dim) {
  return ITEM_DIM_LABEL[dim]?.() ?? tr(dim);
}

/**
 * 分组标题：item.agent 的取值是内部词，走字典；别的维度是数据本身，原样显示；
 * 没有这个维度的那组（`value === ""`）标题是"不分组"意义上的"没有取值"，跟
 * 未归单是两回事——它仍然参与分组，只是分到了空桶里。
 */
function groupLabel(dim, value) {
  if (value === "") return tr("items.groupNone");
  if (dim === "item.agent") return AGENT_VALUE[value]?.() ?? value;
  return value;
}

/**
 * 一个筛选开关：某维度的某个取值，点一下切换选中态。
 *
 * chip 上只写取值，不再重复维度名——它已经画在自己那一行的标题上了。从前所有维度
 * 的取值平铺成一排时，每个 chip 都得自带"维度: 取值"才分得清归属，而那让一排 chip
 * 长得又臭又长；按字段分行之后，归属由位置表达，chip 就能只说自己那半句。
 */
function filterChip(dim, value, active, onToggle) {
  const display = dim === "item.agent" ? (AGENT_VALUE[value]?.() ?? value) : value;
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = active ? "filter-chip selected" : "filter-chip";
  chip.textContent = display;
  chip.title = `${dimLabel(dim)}: ${display}`;
  chip.setAttribute("aria-pressed", active ? "true" : "false");
  chip.addEventListener("click", onToggle);
  return chip;
}

/**
 * 筛选区里的一个字段：标题 + 一个移除按钮 + 它全部取值的 toggle chips。
 *
 * chips 换行铺开，不横向滚动：横向滚动会把取值藏在屏幕外，而藏起来的筛选项等于
 * 不存在——你不会去滑一个不知道有没有内容的方向。
 */
function filterField(dim, facets, selected, onToggleValue, onRemove) {
  const box = el("div", "filter-field");

  const head = el("div", "field-head");
  head.append(el("span", "field-name", dimLabel(dim)));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "field-remove";
  remove.innerHTML = icon("x", 14);
  remove.title = tr("items.removeField");
  remove.setAttribute("aria-label", tr("items.removeField"));
  remove.addEventListener("click", onRemove);
  head.append(remove);
  box.append(head);

  const values = el("div", "field-values");
  for (const value of valuesOf(facets, dim)) {
    const active = (selected[dim] ?? []).includes(value);
    values.append(filterChip(dim, value, active, () => onToggleValue(value)));
  }
  box.append(values);
  return box;
}

/**
 * 工具条：分组选择器 + 每个维度的筛选 chips。选项都是从当前数据现算的
 * （dimensionsOf/valuesOf），不是写死的表——加一个插件维度不该要求改这个文件。
 * @param {string[]} dims
 * @param {Record<string, Array<{dim: string, value: string}>>} facets
 * @param {string} groupBy
 * @param {Record<string, string[]>} selected
 * @param {boolean} showArchived
 * @param {() => void} onChange
 */
function buildToolbar(dims, facets, groupBy, selected, showArchived, onChange) {
  const bar = el("div", "toolbar");

  // 同步 / 显示已归档 / 分组，三个控件并成第一行。状态文案不进这一行——它可能很长
  // （"只同步了前 200 条"那种），挤进来只会被截断，而那恰恰是不能被悄悄吞掉的话。
  const actions = el("div", "toolbar-actions");
  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.id = "new-item";
  newBtn.className = "new-item-btn";
  newBtn.innerHTML = icon("plus");
  newBtn.append(document.createTextNode(tr("items.newItem")));
  // 这里不能用 onChange（它只拿已经拉到的数据重画一遍，新建的单不在里面），
  // 要 render() 重新去问一次服务端。
  newBtn.addEventListener("click", () => openNewItemSheet(() => render()));
  actions.append(newBtn);

  const syncBtn = document.createElement("button");
  syncBtn.type = "button";
  syncBtn.id = "sync-items";
  syncBtn.className = "sync-btn";
  syncBtn.innerHTML = icon("refresh");
  syncBtn.append(document.createTextNode(syncing ? tr("items.syncing") : tr("items.sync")));
  syncBtn.disabled = syncing;
  syncBtn.addEventListener("click", doSync);
  actions.append(syncBtn);

  const archivedWrap = el("label", "show-archived-wrap");
  const archivedToggle = document.createElement("input");
  archivedToggle.type = "checkbox";
  archivedToggle.id = "show-archived";
  archivedToggle.checked = showArchived;
  archivedToggle.addEventListener("change", () => {
    saveShowArchived(archivedToggle.checked);
    onChange();
  });
  archivedWrap.append(archivedToggle);
  archivedWrap.append(el("span", "toolbar-label", tr("items.showArchived")));
  actions.append(archivedWrap);

  const groupWrap = el("label", "group-by-wrap");
  groupWrap.append(el("span", "toolbar-label", tr("items.groupBy")));
  const select = document.createElement("select");
  select.id = "group-by";
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = tr("items.groupNone");
  select.append(noneOpt);
  for (const dim of dims) {
    const opt = document.createElement("option");
    opt.value = dim;
    opt.textContent = dimLabel(dim);
    select.append(opt);
  }
  select.value = groupBy;
  select.addEventListener("change", () => {
    saveGroupBy(select.value);
    onChange();
  });
  groupWrap.append(select);
  actions.append(groupWrap);

  bar.append(actions);
  // 状态文案自己一行，有内容才画。
  if (syncMessage) bar.append(el("p", "sync-status", syncMessage));

  if (!dims.length) return bar;

  // filter-row 在样式里是 display:contents——它自己不成盒子，标签落进网格左列、
  // filter-body 落进右列，这样「筛选」跟「分组」两个标签才在同一条竖线上。
  const filters = el("div", "filter-row");
  const filterLabel = el("span", "toolbar-label");
  filterLabel.innerHTML = icon("filter", 13);
  filterLabel.append(document.createTextNode(tr("items.filter")));
  filters.append(filterLabel);
  const body = el("div", "filter-body");

  // 存下来的原样 vs 现在画得出来的：一个暂时不在数据里的字段不画，但留在存储里，
  // 所以增删都改 stored，渲染只看 shown。
  const stored = loadFields();
  const shown = stored.filter((d) => dims.includes(d));

  // 选择器紧跟在「筛选」标签后面，跟它并排一行——字段块各占整行，选择器要是排在
  // 它们后面就会被挤到单独一行，白占一行高度。
  const addable = dims.filter((d) => !stored.includes(d));
  if (addable.length) {
    const addWrap = el("label", "add-field-wrap");
    const add = document.createElement("select");
    add.id = "field-picker";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = tr("items.addField");
    add.append(placeholder);
    for (const dim of addable) {
      const opt = document.createElement("option");
      opt.value = dim;
      opt.textContent = dimLabel(dim);
      add.append(opt);
    }
    add.value = "";
    add.addEventListener("change", () => {
      if (!add.value) return;
      saveFields([...stored, add.value]);
      onChange();
    });
    addWrap.append(add);
    body.append(addWrap);
  }

  for (const dim of shown) {
    body.append(
      filterField(
        dim,
        facets,
        selected,
        (value) => {
          const next = { ...selected };
          const cur = new Set(next[dim] ?? []);
          if (cur.has(value)) cur.delete(value);
          else cur.add(value);
          next[dim] = [...cur];
          saveFilter(next);
          onChange();
        },
        () => {
          // 移掉字段时连它的选择一起清掉。留着的话就成了一个看不见却仍在生效的
          // 筛选——页面少了几张单，而屏幕上没有任何东西解释为什么。
          const nextSel = { ...selected };
          delete nextSel[dim];
          saveFilter(nextSel);
          saveFields(stored.filter((d) => d !== dim));
          onChange();
        },
      ),
    );
  }


  filters.append(body);
  bar.append(filters);
  return bar;
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

/**
 * 把"等你回答"的数量映到浏览器标签页——跟 list.js 的 setTabWaiting 同一套
 * 写法，两个页面都可能是首页（start_url 现在指向这里），行为不该分叉。
 */
function setTabWaiting(count) {
  document.title = count ? `(${count}) ${tr("items.title")}` : tr("items.title");
  const link = document.querySelector('link[rel="icon"]');
  if (link) link.href = count ? "favicon-alert.svg" : "favicon.svg";
}

/**
 * @param {boolean} [fromSync] 这次 render() 是不是 doSync() 结束后触发的那一次。
 *
 * syncMessage 是模块级的，不会自己过期——不传或传 false（归档/刷新单张之后的
 * onChange、定时轮询的 refresh()）就清掉它。不清的话，同步一次之后随手归档一张
 * 单，工具条会继续显示一小时前那次同步的结果，像是刚刚才同步过。
 */
async function render(fromSync = false) {
  if (!fromSync) syncMessage = "";
  let body;
  let claimed;
  try {
    const res = await fetch(url("api/items"));
    if (!res.ok) throw new Error(String(res.status));
    body = await res.json();
    // claimedProviders() 自己兜住失败、从不抛，跟 fetch("api/items") 并发问没有
    // 意义——两次请求彼此独立，串起来只是白等一次往返。
    claimed = await claimedProviders();
  } catch {
    renderEmpty(tr("items.offline"));
    return;
  }

  // 后端可能是旧版本，缺字段就当空——半新半旧的服务是常态，不是异常。
  const items = Array.isArray(body?.items) ? body.items : [];
  const sessions = Array.isArray(body?.sessions) ? body.sessions : [];
  const bindings = Array.isArray(body?.bindings) ? body.bindings : [];
  // { itemId: Facet[] }，老后端没有这个字段就当空——跟 items/sessions/bindings
  // 同一套半新半旧兜底。
  const facets = body?.facets && typeof body.facets === "object" ? body.facets : {};

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

  // 「关联已有会话」用的候选表：所有会话，外加每个会话此刻挂在哪张单下，
  // 好在选项上标出来。只算一次，别在每张卡片里重建。
  const link = {
    sessions,
    itemOf: new Map(bindings.filter((b) => b.live).map((b) => [b.session, b.itemId])),
    // 认单认的是单号，不是标题——所以"现挂在某单下"优先报单号，没有来源的本地单
    // 才退回标题。
    titleOf: new Map(items.map((i) => [i.id, i.source?.ref || i.title])),
  };

  const open = items.filter((i) => !i.closedAt);
  // 未归单——不是某个维度的取值，是待归类区：不参与分组也不参与筛选，
  // 永远在最后画。
  const loose = sessions.filter((s) => !bound.has(s.name));

  // 等你回答的数量跟卡片同一份数据算——item.agent 是内核已经判好的状态，标题
  // 不该另算一遍：两处对不上就是页面在说两套话。
  const waiting = open.filter((i) =>
    facets[i.id]?.some((f) => f.dim === "item.agent" && f.value === "waiting"),
  ).length;
  setTabWaiting(waiting);

  // 「压根没有单」现在只看 items 本身，不看 open——items 里全是归档单、
  // open 为空也不等于没东西可看：还有「显示已归档」这个开关能把它们叫回来，
  // 而那个开关画在 draw() 里的工具条上，在这里短路掉就永远够不到它。
  if (!items.length && !loose.length) {
    // 一张单都没有时，新建按钮平时待的那条工具条不会画出来——而这正是最需要它
    // 的时刻。跟上面那条注释同一类坑：在这里短路掉，入口就永远够不到。
    renderEmpty(tr("items.empty"), tr("items.emptyHint"));
    const first = document.createElement("button");
    first.type = "button";
    first.id = "new-item";
    first.className = "new-item-btn";
    first.textContent = tr("items.newItem");
    first.addEventListener("click", () => openNewItemSheet(() => render()));
    root.append(first);
    return;
  }

  // 重画不重新请求：分组/筛选/显示已归档都是本地状态的切换，不该每点一下就
  // 再打一次 /api/items。items/loose/facets/mine 在这个闭包里是常量，
  // showArchived 之下的一切都在 draw() 内部现算，好让切换开关立刻生效。
  function draw() {
    const showArchived = loadShowArchived();
    const visible = showArchived ? items : open;

    // 分组/筛选的选项要限定在"看得见"的这份集合上：facets 是按全部 items（含
    // 归档）算的，选项摊开时就可能出现一个只有归档单才有的取值——点上去正好
    // 落进"没有符合筛选的单"，而屏幕上一张归档单都看不见，用户搞不清哪里出的错。
    const visibleFacets = {};
    for (const it of visible) if (facets[it.id]) visibleFacets[it.id] = facets[it.id];
    const dims = dimensionsOf(visibleFacets);

    const groupBy = loadGroupBy(dims);
    // 先跟当前数据对一次账再筛：存下来的取值可能已经不在数据里了（工单状态变了、
    // 同步换了一批单）。不对账的话它会变成一个看不见、点不掉、却仍在生效的筛选——
    // 页面被筛空，而屏幕上没有任何一个 chip 是选中态，用户无从知道是什么在作怪。
    // 对完账写回去，免得每次渲染都重算同一份失效数据。
    const stored = loadFilter();
    const selected = pruneSelection(visibleFacets, stored);
    if (JSON.stringify(selected) !== JSON.stringify(stored)) saveFilter(selected);
    const filtered = filterItems(visible, visibleFacets, selected);

    // 头部计数数的是筛完之后真正画出来的那些卡片，不是 visible.length——facet
    // 筛选生效时两者会不一样：filtered 是用户此刻在屏幕上能数出来的数字，
    // visible 还包含被筛掉、根本没画出来的单。之前读 visible.length，筛选一开
    // 数字就跟卡片数对不上，看着像页面没反应过来。
    setCount(tr("items.count", { n: filtered.length }));

    root.replaceChildren();
    root.append(buildToolbar(dims, visibleFacets, groupBy, selected, showArchived, draw));

    if (!filtered.length) {
      // 跟"压根没有单"是两件不同的事——这里是筛出来的空（或者归档单都被
      // 开关挡住了），得说清楚，不能看着像页面坏了。
      // 说清楚是筛空的还不够——还得给一个能解除它的东西。否则你知道是筛选在作怪，
      // 也还要自己去猜是哪个字段、翻到哪个 chip。
      const empty = el("p", "empty", tr("items.noneMatch"));
      if (Object.keys(selected).length) {
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "clear-filter";
        clear.textContent = tr("items.clearFilter");
        clear.addEventListener("click", () => {
          saveFilter({});
          draw();
        });
        empty.append(clear);
      }
      root.append(empty);
    } else if (groupBy) {
      for (const group of groupItems(filtered, visibleFacets, groupBy)) {
        const section = el("section");
        section.append(el("h2", "group-name", groupLabel(groupBy, group.value)));
        for (const item of group.items) {
          section.append(itemCard(item, mine.get(item.id) ?? [], visibleFacets[item.id], claimed, render, link));
        }
        root.append(section);
      }
    } else {
      for (const item of filtered) {
        root.append(itemCard(item, mine.get(item.id) ?? [], visibleFacets[item.id], claimed, render, link));
      }
    }

    if (loose.length) root.append(unassignedGroup(loose));
  }

  draw();
}

/**
 * 定时/唤醒触发的刷新要重新进 render()，不能只调 draw()——draw() 闭包着上一次
 * fetch 到的 items/sessions/facets，不重新请求页面就永远吃旧数据（这也是这份单
 * 是 PWA 的 start_url 却从不刷新的根因：list.js 有轮询和可见性唤醒，这个页面
 * 曾经两样都没有）。
 *
 * 滚动位置单独存一下：render() 内部整体 replaceChildren，任由它发生的话，
 * 站在半屏内容中间被每 5 秒弹回顶部，比看着一屏旧数据还糟。分组/筛选的选择
 * 走 localStorage，draw() 每次都会重新读，天然跨这次刷新保留，不用额外处理。
 */
async function refresh() {
  const y = window.scrollY;
  await render();
  window.scrollTo(0, y);
}

setInterval(refresh, 5000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh();
});
