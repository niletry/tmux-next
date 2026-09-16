import { SERVERS, enabledPlugins, type PluginServer } from "../../plugins/handlers";
import { PLUGINS } from "../../plugins/registry.js";
import type { Facet, FacetDetail, ItemRef, PluginEnricher } from "../../plugins/types";
import { FIELD_KEY_CHARS } from "../template";
import type { ItemStatus } from "./lifecycle";

/**
 * 数据源契约，以及内核对来源的全部分派。
 *
 * 一个来源就是"能同步、能刷新一张、能贴 chip、能提供模板字段、能在状态变化时
 * 写回"这五件事，别的不管。插件在 plugins/handlers.ts 的 PluginServer.sources
 * 里交出零个或多个来源；内核按 WorkItem.source.provider 查这张表，从不知道
 * 插件 id。
 *
 * 五个方法的语义、预算和失败语义跟它们在 handlers.ts 里时一模一样，只是从
 * 插件级搬到了来源级——这一步的意义在于"一个插件 = 一个来源"不再是隐含假设。
 *
 * **这个文件和 plugins/handlers.ts 互相 import，是一个 ESM 环。它安全的唯一
 * 条件是两边都只在函数体和默认参数表达式里引用对方的导出，模块顶层一处都不用。**
 * 也就是说：这里不能再出现 `const X = Object.entries(SERVERS)…` 那种从对方的
 * 导出在加载时算出来的常量（旧的 ENRICHERS / FIELD_SOURCES 就是这种），
 * handlers.ts 那边也不能在顶层用 SOURCE_TIMEOUT_MS。往顶层加东西之前先读这段。
 */

export type SyncResult = { created: number; updated: number; total: number; truncated: boolean };

export type ItemSourceProvider = {
  /** WorkItem.source.provider 的取值。一个进程里两个来源撞同一个值，后者被丢弃。 */
  provider: string;
  /** 把这个来源同步一遍（新建/更新单）。显式动作，SOURCE_TIMEOUT_MS 预算。 */
  sync?(opts?: { full?: boolean }): Promise<SyncResult>;
  /** 只刷新一张单，ref 是 source.ref。显式动作，SOURCE_TIMEOUT_MS 预算。 */
  refreshItem?(ref: string): Promise<void>;
  /** 给单贴 chip。每次画页都跑，ENRICH_TIMEOUT_MS 预算，绝不发请求。只收到 provider 匹配的单。 */
  enrich?(items: ItemRef[]): Promise<Record<string, Facet[]>>;
  /** 喂模板的字段。按下按钮才跑，FIELD_TIMEOUT_MS 预算，允许一次真实请求。 */
  fields?(item: ItemRef): Promise<Record<string, string>>;
  /** 状态机迁移之后的尽力通知。抛出即失败，内核只记日志，不撤销已落盘的状态。 */
  onLifecycleChange?(ref: string, from: ItemStatus, to: ItemStatus): Promise<void>;
};

/** enrich 每次页面加载都跑，300ms 逼着它只读缓存。 */
export const ENRICH_TIMEOUT_MS = 300;
/** fields 是按下按钮才走的一次显式动作，允许一次真实往返，但有人盯着输入框。 */
export const FIELD_TIMEOUT_MS = 5_000;
/** sync / refreshItem 是显式动作，会真的发请求，30 秒是"慢"和"卡住"之间的线。 */
export const SOURCE_TIMEOUT_MS = 30_000;
/** 合并所有来源之后一张单最多留几条 facet——护的是卡片，不是每个来源的配额。 */
export const MAX_FACETS_PER_ITEM = 6;
/** 一个维度底下最多展开几行明细。一个坏来源不能靠 detail 撑爆浮层。 */
export const MAX_DETAIL_ROWS = 20;
/** 合并所有来源之后一张单最多留几个字段。 */
export const MAX_FIELDS_PER_ITEM = 12;
/** 一个字段的长度上限。描述正文可以很长，但没有哪一段该到 4KB。 */
export const MAX_FIELD_LEN = 4000;
/** 一条 facet 文本的上限，够放一个状态或一个史诗名，不够撑破一张卡片。 */
const MAX_TEXT = 120;
/**
 * 一行明细"发给会话"的文本上限。这不是给人看的一格标签，是要塞进
 * `send-keys` 的一整句话（比如带上 PR 地址和检查名），所以给得比 MAX_TEXT 宽——
 * 但仍然远小于 sendText 自己的 2000 上限（src/tmux/send-text.ts 的 MAX_TEXT），
 * 留出余量不至于来源这边刚好顶格就被下游再截一次。
 */
const MAX_SEND_TEXT = 500;
/** 一个 chip 图标的路径长度上限。够画一个图元组合，不够塞进一整幅图。 */
const MAX_ICON = 2000;

/**
 * 一个插件是否该被这一轮考虑：不在真注册表里的（测试注进来的假插件）一律放行，
 * 在真注册表里的看 enabledPlugins()。TMUX_NEXT_DISABLE_PLUGINS 对来源生效的
 * 唯一一处——来源不经过 /api/<id> 的 404 闸门，这条过滤就是它唯一的闸门。
 */
function isConsidered(id: string, enabled: Set<string>): boolean {
  return !PLUGINS.some((real) => real.id === id) || enabled.has(id);
}

/**
 * 启用的插件交出的全部来源。同一个 provider 出现两次，后者丢弃并记一行日志——
 * 不抛：一个插件写错不能让服务器起不来。
 */
export function sourceProviders(servers: Record<string, PluginServer> = SERVERS): ItemSourceProvider[] {
  const enabled = new Set(enabledPlugins().map((p) => p.id));
  const out: ItemSourceProvider[] = [];
  const seen = new Set<string>();
  for (const [id, server] of Object.entries(servers)) {
    if (!isConsidered(id, enabled)) continue;
    for (const source of server.sources ?? []) {
      if (seen.has(source.provider)) {
        console.error(`[items] 插件 ${id} 的来源 ${source.provider} 已被别的插件认领，丢弃`);
        continue;
      }
      seen.add(source.provider);
      out.push(source);
    }
  }
  return out;
}

/** 有人认领的 provider 列表，给 /api/items 响应用。 */
export function claimedProviders(servers: Record<string, PluginServer> = SERVERS): string[] {
  return sourceProviders(servers).map((s) => s.provider);
}

/** 插件级的 enrich：不绑来源、想给全部单贴 chip 的插件。 */
export function pluginEnrichers(servers: Record<string, PluginServer> = SERVERS): PluginEnricher[] {
  const enabled = new Set(enabledPlugins().map((p) => p.id));
  return Object.entries(servers)
    .filter(([id, s]) => s.enrich && isConsidered(id, enabled))
    .map(([, s]) => s.enrich!);
}

async function withTimeout<T>(work: Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
  const timeout = new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs));
  try {
    return await Promise.race([work, timeout]);
  } catch {
    return fallback;
  }
}

// ---- 净化：从 plugins/handlers.ts 原样搬来 ------------------------------------

/**
 * chip 图标只放行几何图元。
 *
 * 这段字符串最终会进 innerHTML。本仓库的插件是编译期常量（没有运行时加载，见
 * CLAUDE.md），所以这不是在防一个能往里塞代码的攻击者——顶栏的 `plugin.icon`
 * 一直就是这么渲染的，威胁模型没变。它防的是另一件事：这段净化对来源给的
 * **每一个**字段都做了处理（文本限长、tone 白名单、url 只认 http），唯独放一个
 * 字段直通 innerHTML，会让下一个读这段代码的人搞不清这里到底管不管。
 * 一条正则把边界说死，比一句"插件是可信的"注释可靠。
 *
 * 整串必须由自闭合的图元标签组成，**元素名和属性名都是白名单**，属性值里不许出现
 * 尖括号或引号。第一版只白名单了元素名、属性名放任意 `[a-zA-Z-]+`，结果
 * `<path d="M0 0" onload="alert(1)"/>` 语法完全合法地通过了——是那条用例（现在在
 * src/items/sources.test.ts 里）把它逼出来的。所以属性也得逐个列，列的都是几何和
 * 描边属性，没有任何一个能执行代码。
 */
/**
 * 灯带台阶：走到第几步 / 一共几步，两个都必须是非负整数，且 rank 不能越过
 * total——插件不传颜色，颜色（走过的绿、没走到的灰、卡住的红）完全是内核在
 * statusLightRow 里决定的，这里只验形状，不验语义之外的东西。
 */
function safeStage(value: unknown): Facet["stage"] {
  const s = value as Record<string, unknown> | undefined;
  if (!s || typeof s !== "object") return undefined;
  const { rank, total } = s;
  if (typeof rank !== "number" || !Number.isInteger(rank) || rank < 0) return undefined;
  if (typeof total !== "number" || !Number.isInteger(total) || total <= 0) return undefined;
  if (rank >= total) return undefined;
  return { rank, total };
}

/**
 * 排序键：一个不透明的分组名 + 可选的数字序。跟 dim/value 一样限长，rank 必须
 * 是有限数——不然一个 NaN/Infinity 混进比较函数会把整个排序结果搅乱。
 */
function safeSortKey(value: unknown): Facet["sortKey"] {
  const s = value as Record<string, unknown> | undefined;
  if (!s || typeof s !== "object") return undefined;
  const key = trim(s.key, MAX_TEXT);
  if (!key) return undefined;
  const rank = typeof s.rank === "number" && Number.isFinite(s.rank) ? s.rank : undefined;
  return { key, ...(rank !== undefined ? { rank } : {}) };
}

const ICON_SHAPES = new RegExp(
  "^(?:<(?:path|circle|rect|line|polyline|polygon|ellipse)" +
    '(?:\\s+(?:d|cx|cy|r|rx|ry|x|y|x1|y1|x2|y2|width|height|points|transform|' +
    'fill|fill-rule|clip-rule|stroke|stroke-width|stroke-linecap|stroke-linejoin|opacity)' +
    '="[^"<>]*")*\\s*/>)+$',
);

/** 通过就原样返回，否则当作没给图标。 */
function safeIconPaths(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.trim();
  if (!compact || compact.length > MAX_ICON) return undefined;
  return ICON_SHAPES.test(compact) ? compact : undefined;
}

function trim(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * 明细行的链接只认 http/https，别的一律当没给。
 *
 * 插件给的字符串会变成页面上的 href，`javascript:` 就是一条注入路径；相对地址则会
 * 按当前页解析，插件根本不知道自己被挂在哪个路径下。两种都不是"链接坏了"那么轻，
 * 所以这里要的是绝对地址加协议白名单，而不是清洗。拿不准就丢掉——那一行还在，
 * 只是不可点，跟 facet 那条"拿不到就当没有"是同一种降级。
 */
function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 把一个 enrich 的返回值净化成 Facet 表。原来是 collectFacets 里的内联循环，
 * 抽出来是因为来源级和插件级两条路都要过同一道闸。
 */
function sanitiseFacets(got: unknown, asked: Set<string>): Record<string, Facet[]> | null {
  if (!got || typeof got !== "object" || Array.isArray(got)) return null;
  const clean: Record<string, Facet[]> = {};
  for (const [id, raw] of Object.entries(got as Record<string, unknown>)) {
    if (!asked.has(id)) continue; // 来源只能标注被问到的单
    if (!Array.isArray(raw)) continue;
    const facets: Facet[] = [];
    for (const one of raw) {
      const f = one as Record<string, unknown>;
      const dim = trim(f?.dim, MAX_TEXT);
      const value = trim(f?.value, MAX_TEXT);
      if (!dim || !value) continue;
      // `item.*` 是内核自己的命名空间（item.agent 等）——一个坏插件冒充
      // item.agent 就能在页面上再画一个 Agent chip、把卡片重新分到别的
      // 组，让页面替内核的事实撒谎。插件的维度名是开放集合，唯独这个
      // 前缀不让它碰。
      if (dim.startsWith("item.")) continue;
      const tone =
        f?.tone === "ok" || f?.tone === "warn" || f?.tone === "dim" ? f.tone : undefined;
      // 明细跟 facet 本身同一套不信任姿态：截断、封顶、tone 只认三个值。
      // 内核不看这些行是什么意思，只保证它们不会撑破页面。
      const detail: FacetDetail[] = [];
      if (Array.isArray(f?.detail)) {
        for (const rawRow of f.detail.slice(0, MAX_DETAIL_ROWS)) {
          const r = rawRow as Record<string, unknown>;
          const label = trim(r?.label, MAX_TEXT);
          const rowValue = trim(r?.value, MAX_TEXT);
          if (!label) continue;
          const rowTone =
            r?.tone === "ok" || r?.tone === "warn" || r?.tone === "dim" ? r.tone : undefined;
          const rowUrl = safeHttpUrl(r?.url);
          const rowGroup = trim(r?.group, MAX_TEXT);
          const rowGroupUrl = safeHttpUrl(r?.groupUrl);
          const rowSend = trim(r?.send, MAX_SEND_TEXT);
          detail.push({
            label,
            value: rowValue,
            ...(rowTone ? { tone: rowTone } : {}),
            ...(rowUrl ? { url: rowUrl } : {}),
            ...(rowGroup ? { group: rowGroup } : {}),
            ...(rowGroupUrl ? { groupUrl: rowGroupUrl } : {}),
            ...(rowSend ? { send: rowSend } : {}),
          });
        }
      }
      const iconPaths = safeIconPaths(f?.icon);
      const stage = safeStage(f?.stage);
      const sortKey = safeSortKey(f?.sortKey);
      const role = f?.role === "pr" || f?.role === "check" ? f.role : undefined;
      const facetUrl = safeHttpUrl(f?.url);
      facets.push({
        dim,
        value,
        ...(tone ? { tone } : {}),
        ...(detail.length ? { detail } : {}),
        ...(iconPaths ? { icon: iconPaths } : {}),
        ...(role ? { role } : {}),
        ...(facetUrl ? { url: facetUrl } : {}),
        // 布尔就一个用途：这条画成单号前的徽标而不是一格 chip。它不能
        // 让插件多说任何话——徽标里画的还是同一个 value 和同一个图标，
        // 两者都已经过上面的限长与净化。
        ...(f?.badge === true ? { badge: true } : {}),
        // stage 挂在灯带上，light 让一个已有 tone 的 facet 额外在灯带里
        // 出一个点——两个字段本来就在 Facet 类型里声明了，之前只是漏了
        // 在净化时透传，灯带因此从未在任何页面画出过一个点。
        ...(stage ? { stage } : {}),
        ...(f?.light === true ? { light: true } : {}),
        ...(sortKey ? { sortKey } : {}),
      });
    }
    if (facets.length) clean[id] = facets;
  }
  return clean;
}

/**
 * 向来源和插件级 enricher 各要一次 facet，合并成 item id → facet 数组。
 *
 * 失败语义只有一种：**拿不到就当没有**。来源抛了、超时了、返回了不是对象的东西，
 * 都只是这一轮没有维度，首页照常渲染。内核的页面不能因为一个来源而出不来——这是
 * 开这个口子的唯一安全阀。
 *
 * 不按来源分层返回：首页要画的是一行 chips，谁贴的不重要。
 *
 * 来源级只收到自己 provider 的单；插件级收到全部。sources/extra 是参数而不是直接
 * 用真表，好让内核侧的测试能塞进一个会抛、一个会卡住的假来源——注册表是编译期写死
 * 的，没有这两个参数就没法测这条安全阀。
 *
 * cap 默认是 MAX_FACETS_PER_ITEM——首页卡片和批量的生命周期推进都要这个"一张卡最多
 * 几个"的护栏。单张单的详情面板（`itemDetail`）不是卡片，没有那个空间限制，问的又
 * 只有一张单，传 `Infinity` 跳过截断——否则一张 Jira 单只要维度凑够 7 个（type /
 * created / status / epic / assignee / prs / checks），最后一个（往往正是用户点开
 * 详情最想看的 checks）就会被这条为首页设计的护栏悄悄吃掉。
 */
export async function collectFacets(
  items: ItemRef[],
  sources: ItemSourceProvider[] = sourceProviders(),
  extra: PluginEnricher[] = pluginEnrichers(),
  cap: number = MAX_FACETS_PER_ITEM,
): Promise<Record<string, Facet[]>> {
  const asked = new Set(items.map((i) => i.id));
  const jobs: Array<Promise<Record<string, Facet[]> | null>> = [];

  const ask = async (enrich: PluginEnricher, subset: ItemRef[]) => {
    if (!subset.length) return null;
    try {
      const got = await withTimeout(enrich(subset), null, ENRICH_TIMEOUT_MS);
      return sanitiseFacets(got, asked);
    } catch {
      return null;
    }
  };

  for (const source of sources) {
    if (!source.enrich) continue;
    jobs.push(ask(source.enrich, items.filter((i) => i.source?.provider === source.provider)));
  }
  for (const enrich of extra) jobs.push(ask(enrich, items));

  // 合并之后才按单封顶——上限是"一张卡片上最多几个"，不是"每个来源最多几个"。
  const merged: Record<string, Facet[]> = {};
  for (const one of await Promise.all(jobs)) {
    if (!one) continue;
    for (const [id, facets] of Object.entries(one)) (merged[id] ??= []).push(...facets);
  }
  for (const id of Object.keys(merged)) merged[id] = merged[id]!.slice(0, cap);
  return merged;
}

/**
 * 占位符语法认得的键名形状，字符集从 src/template.ts 的 FIELD_KEY_CHARS 导入而不是
 * 自己重写一条正则——两处必须相等：PLACEHOLDER 放宽了却没跟着改这里，会让语法上合法
 * 的来源字段被这里悄悄丢掉，哪里都不报错。
 */
const FIELD_KEY = new RegExp(`^[${FIELD_KEY_CHARS}]+$`);

/**
 * 问认领了这张单来源的那一个来源要字段。本地单没有来源，不问任何人。
 *
 * 失败语义同上：**拿不到就当没有**，模板照常渲染，那几个占位符变成空。
 *
 * timeoutMs 单独开成可注入的尾参数（默认 FIELD_TIMEOUT_MS）：真实预算是 5 秒，但测试
 * "卡住的来源不会吊死调用方"这件事跟等多久无关，注入一个很小的值就能在毫秒级证明同一条
 * 性质，不用真的等 5 秒。
 */
export async function collectFields(
  item: ItemRef,
  sources: ItemSourceProvider[] = sourceProviders(),
  timeoutMs: number = FIELD_TIMEOUT_MS,
): Promise<Record<string, string>> {
  const owner = item.source ? sources.find((s) => s.provider === item.source!.provider) : undefined;
  if (!owner?.fields) return {};
  let got: unknown;
  try {
    got = await withTimeout(owner.fields(item), null, timeoutMs);
  } catch {
    return {};
  }
  if (!got || typeof got !== "object" || Array.isArray(got)) return {};
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(got as Record<string, unknown>)) {
    if (typeof value !== "string" || !value) continue;
    // 占位符写不出来的键，收下也没人能引用它。
    if (!FIELD_KEY.test(key)) continue;
    // item.* 是内核自己的命名空间——让来源写进来等于让它伪造这张单的标题和
    // 单号，而模板渲染分不出是谁写的。
    if (key.startsWith("item.")) continue;
    clean[key] = value.slice(0, MAX_FIELD_LEN);
  }
  return Object.fromEntries(Object.entries(clean).slice(0, MAX_FIELDS_PER_ITEM));
}

/**
 * 每个声明了 sync 的来源各同步一遍，结果相加。
 *
 * 一个来源挂了不该拖垮别的来源：抛了、卡住了，都只是它这一轮贡献零。
 */
export async function runSync(
  sources: ItemSourceProvider[] = sourceProviders(),
  timeoutMs: number = SOURCE_TIMEOUT_MS,
): Promise<SyncResult> {
  const results = await Promise.all(
    sources
      .filter((s) => s.sync)
      .map((s) => withTimeout(s.sync!(), null, timeoutMs).catch(() => null)),
  );
  const total: SyncResult = { created: 0, updated: 0, total: 0, truncated: false };
  for (const r of results) {
    if (!r) continue;
    total.created += r.created;
    total.updated += r.updated;
    total.total += r.total;
    total.truncated = total.truncated || r.truncated;
  }
  return total;
}

/**
 * 按 provider 找来源刷新一张单。没人认领、没实现、抛了、超时，一律 false——
 * 调用方（首页的刷新按钮）不需要区分这几种情况，只需要知道"刷没刷成"。
 */
export async function refreshFromSource(
  provider: string,
  ref: string,
  sources: ItemSourceProvider[] = sourceProviders(),
  timeoutMs: number = SOURCE_TIMEOUT_MS,
): Promise<boolean> {
  const refreshItem = sources.find((s) => s.provider === provider)?.refreshItem;
  if (!refreshItem) return false;
  try {
    return await withTimeout(refreshItem(ref).then(() => true), false, timeoutMs);
  } catch {
    return false;
  }
}

/**
 * 状态机迁移之后通知认领的来源一声。失败全部静默：写回是旁路，状态机本身已经
 * 落盘的迁移不因为这里失败而有任何变化，调用方也不需要知道失败与否。
 */
export async function notifyLifecycleChange(
  provider: string,
  ref: string,
  from: ItemStatus,
  to: ItemStatus,
  sources: ItemSourceProvider[] = sourceProviders(),
  timeoutMs: number = SOURCE_TIMEOUT_MS,
): Promise<void> {
  const onLifecycleChange = sources.find((s) => s.provider === provider)?.onLifecycleChange;
  if (!onLifecycleChange) return;
  try {
    await withTimeout(onLifecycleChange(ref, from, to), undefined, timeoutMs);
  } catch {
    // 尽力而为。
  }
}
