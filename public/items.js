import { initTheme } from "./theme-apply.js";
import { initLang, tr } from "./i18n-apply.js";
import { renderHeader } from "./nav.js";
import { url } from "./root.js";
import { dimensionsOf, valuesOf, groupItems, filterItems } from "./facet-view.js";

// Before anything renders: paints the cached theme synchronously, then
// reconciles with the machine's stored choice.
initTheme();
initLang().then(() => {
  // After the language is known: the nav labels come from the dictionary.
  renderHeader("items");
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
  "item.cwd": () => tr("item.cwd"),
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
function facetChip(facet) {
  // tr() 本身查不到键就退回键名，插件维度（开放集合）和真正没配置的 dim 都
  // 落到这条路；内核的五个维度走上面的字面量表，只是为了不被死键扫描误判。
  const label = ITEM_DIM_LABEL[facet.dim]?.() ?? tr(facet.dim);
  const value = facet.dim === "item.agent" ? (AGENT_VALUE[facet.value]?.() ?? facet.value) : facet.value;
  const chip = el("span", facet.tone ? `facet ${facet.tone}` : "facet");
  chip.append(el("span", "f-dim", label));
  chip.append(el("span", "f-value", value));
  chip.title = `${label}: ${value}`;
  return chip;
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
 * 单卡片。
 *
 * 「再开一个会话」永远在，不是「打开」——一张单多个会话是常态，不是边角情况。
 */
function itemCard(item, sessions, facets) {
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
  if (facets && facets.length) {
    const row = el("div", "facets");
    for (const facet of facets) row.append(facetChip(facet));
    card.append(row);
  }

  for (const session of sessions) card.append(sessionRow(session));

  const more = el("a", "item-new", sessions.length ? tr("items.newSession") : tr("items.firstSession"));
  more.href = url(`new.html?item=${encodeURIComponent(item.id)}`);
  card.append(more);
  return card;
}

/**
 * 分组/筛选的选择存在哪块屏幕上，是设备的事——跟字号同类，不是"这台机器"的事
 * （主题才是）。两把键各管一半状态，互不影响对方的降级路径。
 */
const GROUP_KEY = "tmux-next.items.groupBy";
const FILTER_KEY = "tmux-next.items.filter";
const FIELDS_KEY = "tmux-next.items.fields";

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
  remove.textContent = "×";
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
 * @param {() => void} onChange
 */
function buildToolbar(dims, facets, groupBy, selected, onChange) {
  const bar = el("div", "toolbar");

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
  bar.append(groupWrap);

  if (!dims.length) return bar;

  const filters = el("div", "filter-row");
  filters.append(el("span", "toolbar-label", tr("items.filter")));

  // 存下来的原样 vs 现在画得出来的：一个暂时不在数据里的字段不画，但留在存储里，
  // 所以增删都改 stored，渲染只看 shown。
  const stored = loadFields();
  const shown = stored.filter((d) => dims.includes(d));

  for (const dim of shown) {
    filters.append(
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
    filters.append(addWrap);
  }

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
  // { itemId: Facet[] }，老后端没有这个字段就当空——跟 items/sessions/bindings
  // 同一套半新半旧兜底。
  const facets = body?.facets && typeof body.facets === "object" ? body.facets : {};

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
  // 未归单——不是某个维度的取值，是待归类区：不参与分组也不参与筛选，
  // 永远在最后画。
  const loose = sessions.filter((s) => !bound.has(s.name));

  // 等你回答的数量跟卡片同一份数据算——item.agent 是内核已经判好的状态，标题
  // 不该另算一遍：两处对不上就是页面在说两套话。
  const waiting = open.filter((i) =>
    facets[i.id]?.some((f) => f.dim === "item.agent" && f.value === "waiting"),
  ).length;
  setTabWaiting(waiting);

  if (!open.length && !loose.length) {
    renderEmpty(tr("items.empty"), tr("items.emptyHint"));
    return;
  }

  const dims = dimensionsOf(facets);

  // 重画不重新请求：分组/筛选是本地状态的切换，不该每点一下 chip 就再打一次
  // /api/items。open/loose/facets 在这个闭包里是常量。
  function draw() {
    const groupBy = loadGroupBy(dims);
    const selected = loadFilter();
    const filtered = filterItems(open, facets, selected);

    root.replaceChildren();
    root.append(buildToolbar(dims, facets, groupBy, selected, draw));

    if (!filtered.length) {
      // 跟"压根没有单"是两件不同的事——这里是筛出来的空，得说清楚，不能看着
      // 像页面坏了。
      root.append(el("p", "empty", tr("items.noneMatch")));
    } else if (groupBy) {
      for (const group of groupItems(filtered, facets, groupBy)) {
        const section = el("section");
        section.append(el("h2", "group-name", groupLabel(groupBy, group.value)));
        for (const item of group.items) section.append(itemCard(item, mine.get(item.id) ?? [], facets[item.id]));
        root.append(section);
      }
    } else {
      for (const item of filtered) root.append(itemCard(item, mine.get(item.id) ?? [], facets[item.id]));
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
