import { initTheme } from "./theme-apply.js";
import { initLang, tr } from "./i18n-apply.js";
import { renderHeader } from "./nav.js";
import { url } from "./root.js";
import { dimensionsOf, valuesOf, groupItems, filterItems, pruneSelection } from "./facet-view.js";
import { openPicker } from "./pick-sheet.js";
import { icon } from "./icons.js";
// 卡片的画法从这里来，浮层用的也是同一份——见 public/item-card.js 顶上的注释。
// 表格视图（itemTable）画的也是这几件，只是换个排法摆进格子里。
import {
  ITEM_DIM_LABEL,
  AGENT_VALUE,
  facetChip,
  chipVisible,
  sessionRow,
  itemHead,
  claimedProviders,
  refreshButton,
} from "./item-card.js";
import { tableColumns, facetsIn } from "./item-table.js";

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





/**
 * 把一个已经跑着的会话挂到这张单下。
 *
 * 后端按会话名覆盖写，所以选一个已经挂在别处的会话就是"改挂"——这正是想要的
 * 语义，一个会话同时属于两张单说不通。
 *
 * @param {*} item
 * @param {*} link
 * @param {() => Promise<void>} onChange
 */
function pickSessionFor(item, link, onChange) {
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
}



/**
 * 归档 / 取消归档。归档不是删除：取消归档就是把 closedAt 送回 null，绑定和标签
 * 原样留着。
 *
 * @param {*} item
 * @param {() => Promise<void>} onChange
 */
async function toggleArchive(item, onChange) {
  const archived = Boolean(item.closedAt);
  try {
    const res = await fetch(url(`api/items/${encodeURIComponent(item.id)}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ closedAt: archived ? null : Math.floor(Date.now() / 1000) }),
    });
    if (res.ok) await onChange();
    else alert(tr("push.actionFailed"));
  } catch {
    alert(tr("push.actionFailed"));
  }
}


/**
 * 卡片右上角的 ⋯ 和它掀起的动作浮层。
 *
 * 卡片底部那一行原本并排四个按钮——开会话、关联已有会话、刷新、归档——在手机上
 * 挤成两行，而后三个都是偶尔才用一次的：关联已有会话是"这单我已经开着终端了"，
 * 刷新是盯着某个 PR 时才按，归档一张单一辈子按一次。它们跟"新会话"抢的是
 * 同一片视觉重量，结果四个按钮谁都不显眼。
 *
 * 所以只留主动作在行里，其余收进右上角——跟会话卡片的 ⋯ 同一个位置、同一个
 * 36px、同一套 .sheet-menu，两份列表的手势因此是一样的。
 *
 * 这里不分宽窄屏：会话卡片那套"窄屏 ⋯、宽屏摊开一行"是因为它的三个动作里有两个
 * 是常用的（置顶、结束）；这三个不是，宽屏上摊开它们只是把不常用的东西放大。
 *
 * @param {*} item
 * @param {() => Promise<void>} onChange
 * @param {*} link
 */
function itemMore(item, onChange, link) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "item-more";
  btn.innerHTML = icon("more", 18);
  btn.title = tr("items.more");
  btn.setAttribute("aria-label", tr("items.more"));
  btn.addEventListener("click", () => openItemActions(item, onChange, link));
  return btn;
}

function openItemActions(item, onChange, link) {
  const back = el("div", "sheet-backdrop");
  const sheet = el("div", "sheet");
  sheet.append(el("p", "sheet-name", item.title));

  const menu = el("div", "sheet-menu");
  const close = () => back.remove();

  const linkBtn = el("button", "btn item-link", tr("items.linkSession"));
  linkBtn.type = "button";
  linkBtn.addEventListener("click", () => {
    close();
    pickSessionFor(item, link, onChange);
  });
  menu.append(linkBtn);

  const archive = el(
    "button",
    "btn item-archive",
    tr(item.closedAt ? "items.unarchive" : "items.archive"),
  );
  archive.type = "button";
  archive.addEventListener("click", () => {
    close();
    toggleArchive(item, onChange);
  });
  menu.append(archive);

  const cancel = el("button", "btn", tr("items.cancel"));
  cancel.type = "button";
  cancel.addEventListener("click", close);
  menu.append(cancel);

  sheet.append(menu);
  back.addEventListener("click", (e) => {
    if (e.target === back) close();
  });
  back.append(sheet);
  document.body.append(back);
}

/**
 * 单卡片。
 *
 * 「新会话」永远在，不是「打开」——一张单多个会话是常态，不是边角情况。
 */
function itemCard(item, sessions, facets, claimed, onChange, link) {
  const card = el("article", "item-card");

  const head = itemHead(item, facets, sessions.length);
  // 不常用的三个动作收在右上角。绝对定位（.item-more），所以标题不管截断还是
  // 换行，它都待在同一个角上。浮层里没有这一颗：那边是只读的。
  head.append(itemMore(item, onChange, link));
  card.append(head);

  // facets 可能是 undefined（老后端没这个字段）或空数组——两种都不画这行容器，
  // 不抛。
  const shown = (facets ?? []).filter(chipVisible);
  if (shown.length) {
    const row = el("div", "facets");
    for (const facet of shown) row.append(facetChip(facet));
    card.append(row);
  }

  for (const session of sessions) card.append(sessionRow(session, onChange));

  // 行里留常用的两个：开会话和刷新。关联已有会话、归档进了右上角的 ⋯——四个
  // 按钮并排时谁都不显眼，而那两个是偶尔才用一次的。
  const actions = el("div", "item-actions");
  actions.append(newSessionLink(item, sessions.length));
  if (item.source && claimed.has(item.source.provider)) {
    actions.append(refreshButton(item, onChange));
  }
  card.append(actions);
  return card;
}

/**
 * 「新会话」/「开第一个会话」。文案随这张单此刻有没有会话变，但动作是同一
 * 个——一张单多个会话是常态，不是边角情况。卡片和表格共用。
 */
function newSessionLink(item, count) {
  const more = el("a", "item-new");
  more.innerHTML = icon("plus");
  more.append(document.createTextNode(count ? tr("items.newSession") : tr("items.firstSession")));
  more.href = url(`new.html?item=${encodeURIComponent(item.id)}`);
  return more;
}

/**
 * 分组/筛选的选择存在哪块屏幕上，是设备的事——跟字号同类，不是"这台机器"的事
 * （主题才是）。两把键各管一半状态，互不影响对方的降级路径。
 */
const GROUP_KEY = "tmux-next.items.groupBy";
const VIEW_KEY = "tmux-next.items.view";
const FILTER_KEY = "tmux-next.items.filter";
const FIELDS_KEY = "tmux-next.items.fields";
const SHOW_ARCHIVED_KEY = "tmux-next.items.showArchived";
const SESSION_FILTER_KEY = "tmux-next.items.sessionFilter";
/** 三态：空串=全部，`none`=没开工，`active`=在跑。 */
const SESSION_FILTER_VALUES = ["", "none", "active"];

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

/**
 * 卡片还是表格。
 *
 * 默认卡片，认不出来的值也当卡片：存的东西可能来自旧版本、也可能被人手改过，而
 * 卡片是任何宽度上都成立的那一种。表格的切换器在 900px 以下不画（样式里那一条），
 * 所以手机上永远存不进 `table`；桌面把窗口拖窄时存着的 table 仍会画，那时靠
 * `.table-wrap` 的横滚兜住——不读 matchMedia，那要自己管窗口变化和重画时机，
 * 而这个判断背后没有任何状态（同 CLAUDE.md 里卡片动作行那条）。
 */
const VIEW_VALUES = ["cards", "table"];

function loadView() {
  try {
    const raw = localStorage.getItem(VIEW_KEY) ?? "";
    return VIEW_VALUES.includes(raw) ? raw : "cards";
  } catch {
    return "cards";
  }
}

function saveView(value) {
  try {
    localStorage.setItem(VIEW_KEY, value);
  } catch {
    // 隐私窗口：记不住就记不住，不是页面能崩的理由。
  }
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
 * 按「开没开工」筛：全部 / 没开工 / 在跑。
 *
 * 这条本来就能从筛选行里挑出来（`item.agent` 选那几个取值），单拎出来是因为它是
 * 这份列表最常用的两次筛选——"接下来该干哪张"和"我手上正跑着什么"。摊在工具条
 * 上一步就到，不用先想起有这么个维度、再翻到那一颗 chip。
 *
 * 做成三态而不是一个复选框：复选框只能问"是不是没开工"，反过来那一半问不出来，
 * 而那一半恰恰是同样常用的一问。
 *
 * 判据取 `item.agent` 而不是「有没有会话行」：agent 是内核已经判好的状态，两处
 * 各算一遍迟早会对不上，那时页面就在说两套话。
 */
function loadSessionFilter() {
  try {
    const raw = localStorage.getItem(SESSION_FILTER_KEY) ?? "";
    // 认不出来的值当"全部"：存的东西可能来自旧版本，也可能被人手改过，
    // 那时给一份筛空的列表比给全部更让人摸不着头脑。
    return SESSION_FILTER_VALUES.includes(raw) ? raw : "";
  } catch {
    return "";
  }
}

function saveSessionFilter(value) {
  try {
    localStorage.setItem(SESSION_FILTER_KEY, value);
  } catch {
    // 记不住不影响这一次筛选是对的。
  }
}

/** 这张单此刻有没有活着的会话。 */
function hasNoSession(facets) {
  return (facets ?? []).some((f) => f.dim === "item.agent" && f.value === "none");
}

/** 一张单是否通过当前的开工筛选。 */
function passesSessionFilter(mode, facets) {
  if (mode === "none") return hasNoSession(facets);
  if (mode === "active") return !hasNoSession(facets);
  return true;
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
/**
 * 哪个维度的弹层开着。同一时刻只留一个——两个摊开就又回到了满屏取值。
 *
 * 记的是**维度名**而不是那个 DOM 节点：选一个取值会触发整页重绘，节点会被换掉，
 * 记节点等于每选一次就关一次，多选就成了"点开-选一个-再点开"的重复劳动。记维度
 * 名，重绘后照着它把弹层重新开出来。
 */
let openDim = null;

/** 点弹层外面收起来。只注册一次——每次重绘都加一个的话，监听器会越堆越多。 */
if (typeof document !== "undefined") {
  document.addEventListener("click", () => {
    if (!openDim) return;
    openDim = null;
    for (const pop of document.querySelectorAll(".field-pop")) pop.hidden = true;
    for (const btn of document.querySelectorAll(".field-btn")) btn.setAttribute("aria-expanded", "false");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !openDim) return;
    openDim = null;
    for (const pop of document.querySelectorAll(".field-pop")) pop.hidden = true;
    for (const btn of document.querySelectorAll(".field-btn")) btn.setAttribute("aria-expanded", "false");
  });
}

/**
 * 一个筛选字段：平时只是一颗按钮，点开才列取值。
 *
 * 原来是把这个维度的**每一个取值**都摊成 chip 常驻在页上。史诗有五条、每条是一
 * 整句标题，状态有七条——两个字段就折了四行，一屏里第一张卡片之前先被吃掉 250px，
 * 而这些取值绝大多数时候没人要看。
 *
 * 现在收成「史诗 2 ▾」这样一颗按钮：**没选就只有名字，选了才带个数字**，屏幕上
 * 因此永远只有一行。取值挪进弹层，那里横向宽度是整块的，长史诗名不必再截断成
 * "QBO → 迁移账套到新总账 in-pl…"。
 *
 * 「移除字段」也挪进弹层：它是低频动作，常驻在外面时跟取值 chip 抢同一片
 * 视觉，而误点它会把已选的筛选一并清掉。
 */
function filterField(dim, facets, selected, onToggleValue, onRemove) {
  const box = el("div", "filter-menu");
  const chosen = selected[dim] ?? [];

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = chosen.length ? "field-btn on" : "field-btn";
  btn.setAttribute("aria-expanded", "false");
  btn.append(el("span", "field-btn-name", dimLabel(dim)));
  // 只在选了东西时才显示数字。没选时多一个"0"只是噪音，而这一行的全部意义
  // 就是把噪音去掉。
  if (chosen.length) btn.append(el("span", "field-btn-count", String(chosen.length)));
  box.append(btn);

  const pop = el("div", "field-pop");
  // 重绘之后照着 openDim 恢复：这一颗本来就开着的话，它还得开着。
  pop.hidden = openDim !== dim;
  if (openDim === dim) btn.setAttribute("aria-expanded", "true");

  const values = el("div", "field-values");
  for (const value of valuesOf(facets, dim)) {
    const active = chosen.includes(value);
    values.append(filterChip(dim, value, active, () => onToggleValue(value)));
  }
  pop.append(values);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "field-remove";
  remove.innerHTML = icon("x", 13);
  remove.append(document.createTextNode(tr("items.removeField")));
  remove.addEventListener("click", onRemove);
  pop.append(remove);

  btn.addEventListener("click", (e) => {
    // 不让这一下冒到 document 上，否则刚打开就被"点外面"那条监听收起来。
    e.stopPropagation();
    const wasOpen = openDim === dim;
    for (const other of document.querySelectorAll(".field-pop")) other.hidden = true;
    for (const other of document.querySelectorAll(".field-btn")) other.setAttribute("aria-expanded", "false");
    openDim = wasOpen ? null : dim;
    pop.hidden = !openDim;
    btn.setAttribute("aria-expanded", String(Boolean(openDim)));
  });
  // 点弹层内部不关：选一个取值之后往往还要再选一个，每选一次就收起来会让
  // 多选变成"点开-选一个-再点开"的重复劳动。
  pop.addEventListener("click", (e) => e.stopPropagation());

  box.append(pop);
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
  newBtn.className = "toolbar-control is-secondary";
  newBtn.innerHTML = icon("plus");
  newBtn.append(document.createTextNode(tr("items.newItem")));
  // 这里不能用 onChange（它只拿已经拉到的数据重画一遍，新建的单不在里面），
  // 要 render() 重新去问一次服务端。
  newBtn.addEventListener("click", () => openNewItemSheet(() => render()));
  actions.append(newBtn);

  const syncBtn = document.createElement("button");
  syncBtn.type = "button";
  syncBtn.id = "sync-items";
  syncBtn.className = "toolbar-control is-primary";
  syncBtn.innerHTML = icon("refresh");
  syncBtn.append(document.createTextNode(syncing ? tr("items.syncing") : tr("items.sync")));
  syncBtn.disabled = syncing;
  syncBtn.addEventListener("click", doSync);
  actions.append(syncBtn);

  const archivedWrap = el("label", "toolbar-control is-field show-archived-wrap");
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

  // 开没开工。跟「分组」同一种控件、同一档——两个都是"这份列表给我看什么"，
  // 不跟同步那种动作混。三态而不是复选框：反过来那一半（"我手上正跑着什么"）
  // 是同样常用的一问，复选框问不出来。
  const sessionWrap = el("label", "toolbar-control is-field group-by-wrap");
  sessionWrap.append(el("span", "toolbar-label", tr("items.sessionFilter")));
  const sessionSelect = document.createElement("select");
  sessionSelect.id = "session-filter";
  // 文案写成字面量的 tr() 而不是 tr(变量)：死键扫描只认字面量，键名当参数传就
  // 看不见了，三条键会被判成没人用。这是 public/list.js:52 起就有的写法。
  for (const [value, label] of [
    ["", () => tr("items.sessionAll")],
    ["none", () => tr("items.sessionNone")],
    ["active", () => tr("items.sessionActive")],
  ]) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label();
    sessionSelect.append(opt);
  }
  sessionSelect.value = loadSessionFilter();
  sessionSelect.addEventListener("change", () => {
    saveSessionFilter(sessionSelect.value);
    onChange();
  });
  sessionWrap.append(sessionSelect);
  actions.append(sessionWrap);

  const groupWrap = el("label", "toolbar-control is-field group-by-wrap");
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

  // 视图切换跟「分组」并排：两个都是"这份列表怎么排给我看"，不跟同步那种动作混。
  // 900px 以下整个控件不画（.view-mode-wrap），手机上表格没有意义。
  const viewWrap = el("label", "toolbar-control is-field view-mode-wrap");
  viewWrap.append(el("span", "toolbar-label", tr("items.view")));
  const viewSelect = document.createElement("select");
  viewSelect.id = "view-mode";
  // 字面量的 tr()，不是 tr(变量)——死键扫描只认字面量（同 list.js:52 的写法）。
  for (const [value, label] of [
    ["cards", () => tr("items.viewCards")],
    ["table", () => tr("items.viewTable")],
  ]) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label();
    viewSelect.append(opt);
  }
  viewSelect.value = loadView();
  viewSelect.addEventListener("change", () => {
    saveView(viewSelect.value);
    onChange();
  });
  viewWrap.append(viewSelect);
  actions.append(viewWrap);

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

/**
 * 表格视图：同一份数据的第二种排法。
 *
 * 卡片是给手机的，一张单一块、纵向读；坐在电脑前扫二十张单时要的是另一件事——
 * 同一个字段在所有单上对齐成一列，一眼看出哪几张卡在同一个状态上。所以这里跟卡片
 * 共用全部构件（item-card.js 的 itemHead / facetChip / sessionRow，加上这里的
 * newSessionLink / refreshButton / itemMore），
 * 换的只是排法：两边各画一套的话，"这颗 chip 什么时候带明细"这类判断迟早在一边被
 * 改、另一边没跟上，而那是安静的——两种视图看着都对，只是说法不一样了。
 *
 * 分组是一行贯通全表的标题行，不是每组另起一张表：另起一张表的话每组都带一次表头，
 * 列就不再在整页上对齐，而对齐正是选表格的理由。
 *
 * @param {Array<{value: string | null, items: any[]}>} groups value 为 null 表示不分组
 * @param {string} groupBy
 * @param {string[]} cols facet 列的维度
 */
function itemTable(groups, groupBy, cols, mine, facets, claimed, onChange, link) {
  // 横滚在包一层上，不在 <table> 上：桌面把窗口拖窄到 900px 以下时（那时切换器
  // 已经不画了，但存着的选择还在生效）表格靠它退化成横滚，而不是撑破整页布局。
  const wrap = el("div", "table-wrap");
  const table = el("table", "item-table");
  const span = 4 + cols.length;

  const thead = el("thead");
  const hr = el("tr");
  hr.append(el("th", "col-item", tr("items.colItem")));
  // 这两列的表头就是维度自己的名字——固定列和 facet 列在表头上没有两套说法。
  hr.append(el("th", "col-agent", tr("item.agent")));
  hr.append(el("th", "col-sessions", tr("item.sessions")));
  for (const dim of cols) hr.append(el("th", "col-facet", dimLabel(dim)));
  hr.append(el("th", "col-actions", tr("items.colActions")));
  thead.append(hr);
  table.append(thead);

  for (const group of groups) {
    const body = el("tbody");
    if (group.value !== null) {
      const row = el("tr", "group-row");
      const cell = el("th", "group-name", groupLabel(groupBy, group.value));
      cell.colSpan = span;
      row.append(cell);
      body.append(row);
    }
    for (const item of group.items) {
      body.append(itemRow(item, mine.get(item.id) ?? [], facets[item.id], cols, claimed, onChange, link));
    }
    table.append(body);
  }

  wrap.append(table);
  return wrap;
}

/** 表格里的一张单。构件全部来自卡片那一套，见 itemTable 顶上的注释。 */
function itemRow(item, sessions, facets, cols, claimed, onChange, link) {
  const row = el("tr", "item-row");

  // 标题格就是卡片的头部，只是会话数传 0——那件事在这里有自己的一列，画两遍
  // 就是同一句话说两次。徽标（来源+类型）跟着一起来，跟卡片上是同一枚。
  const first = el("td", "col-item");
  first.append(itemHead(item, facets, 0));
  row.append(first);

  // agent 和会话数这两个维度不再画进 facet 列（tableColumns 已经把它们挡掉了），
  // 它们在这里各有自己的固定列。agent 走 facetChip 而不是自己拼一个词：tone 是
  // 它带的，颜色跟卡片上那颗必须是同一颗。
  const agent = el("td", "col-agent");
  for (const f of facetsIn(facets, "item.agent")) agent.append(facetChip(f));
  row.append(agent);

  // 会话格里是链接本身，不是一个数字：数字回答"有几个"，而在这份列表里下一步动作
  // 永远是"点进去看某一个"。
  // onChange 传下去，所以行里那个解绑 × 跟卡片上是同一颗，不是只读的复制品。
  const cell = el("td", "col-sessions");
  for (const session of sessions) cell.append(sessionRow(session, onChange));
  row.append(cell);

  for (const dim of cols) {
    const td = el("td", "facet-cell");
    // 一个维度可以有多个取值（标签就是），全画——只画第一个等于在表格里悄悄丢数据。
    for (const f of facetsIn(facets, dim)) td.append(facetChip(f));
    row.append(td);
  }

  // 动作跟卡片一样分两档：常用的两个摊在行里，关联/归档收在 ⋯ 后面。表格里
  // ⋯ 也进这一格——卡片上它绝对定位在右上角，那是卡片的角，表格没有那个角。
  const actions = el("td", "col-actions");
  const wrap = el("div", "item-actions");
  wrap.append(newSessionLink(item, sessions.length));
  if (item.source && claimed.has(item.source.provider)) {
    wrap.append(refreshButton(item, onChange));
  }
  wrap.append(itemMore(item, onChange, link));
  actions.append(wrap);
  row.append(actions);
  return row;
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
    // 跟工具条上那颗是同一个动作，所以是同一档外观——这里只是它在"工具条画不
    // 出来"时的复述。
    first.className = "toolbar-control is-secondary";
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
    // 开工筛选跟筛选行是"与"的关系，不是替代：两个都设就是"没会话、且状态是 X"。
    // 它排在 facet 筛选之后，所以计数、空状态那几条判断照旧只看一个 filtered。
    const sessionMode = loadSessionFilter();
    const filtered = filterItems(visible, visibleFacets, selected).filter((it) =>
      passesSessionFilter(sessionMode, visibleFacets[it.id]),
    );

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
    } else if (loadView() === "table") {
      // 分组在表格下照旧生效，只是画成跨列的标题行；不分组时就是一组、没有标题行。
      const groups = groupBy
        ? groupItems(filtered, visibleFacets, groupBy)
        : [{ value: null, items: filtered }];
      root.append(
        itemTable(
          groups,
          groupBy,
          tableColumns(dims, loadFields()),
          mine,
          visibleFacets,
          claimed,
          render,
          link,
        ),
      );
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
