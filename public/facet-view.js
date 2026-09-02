// @ts-check
/**
 * 首页的分组与筛选。
 *
 * 维度和取值都**从当前数据里现算**，不维护一张写死的表——加一个插件维度不该需要
 * 动这个文件，这正是 facet 这套设计要买到的东西。做法沿用工单页 filter.js 的先例。
 *
 * 单独成文件、`@ts-check`、无头可测：页面文件不做类型检查，而这一层是这一期唯一
 * 真有判断的地方，一个空指针就能让整页画不出来。
 */

/** @typedef {{ dim: string, value: string, tone?: "ok" | "warn" | "dim" }} Facet */
/** @typedef {Record<string, Facet[]>} FacetMap */

/**
 * `item.agent` 的分组顺序：手机上第一眼要回答的是「该我动了吗」，所以这个维度按
 * 紧急程度排，不按数据里的出现顺序。别的维度没有天然次序，就按出现顺序。
 *
 * 只有三个值——"idle" 不在其中。活着的会话要么在等你（waiting）要么在干活
 * （working）；"idle" 是这仓库里"卡在提示符等你"的既有叫法，跟 waiting 是同一件
 * 事的另一个名字，agent 维度不会产出它。
 */
export const AGENT_ORDER = ["waiting", "working", "none"];

const AGENT_DIM = "item.agent";

/**
 * 数据里出现过的维度，按首次出现排序、去重。
 * @param {FacetMap} facets
 * @returns {string[]}
 */
export function dimensionsOf(facets) {
  const out = [];
  const seen = new Set();
  for (const list of Object.values(facets ?? {})) {
    for (const f of list ?? []) {
      if (seen.has(f.dim)) continue;
      seen.add(f.dim);
      out.push(f.dim);
    }
  }
  return out;
}

/**
 * 某个维度出现过的取值，去重、按出现排序。
 * @param {FacetMap} facets
 * @param {string} dim
 * @returns {string[]}
 */
export function valuesOf(facets, dim) {
  const out = [];
  const seen = new Set();
  for (const list of Object.values(facets ?? {})) {
    for (const f of list ?? []) {
      if (f.dim !== dim || seen.has(f.value)) continue;
      seen.add(f.value);
      out.push(f.value);
    }
  }
  return out;
}

/**
 * 一张单在某维度上的全部取值。
 * @param {FacetMap} facets
 * @param {string} id
 * @param {string} dim
 * @returns {string[]}
 */
function valuesFor(facets, id, dim) {
  return (facets?.[id] ?? []).filter((f) => f.dim === dim).map((f) => f.value);
}

/**
 * 按维度分组。
 *
 * 一张单在这个维度上有多个取值（多个标签）时**进入每一组**——它确实同时属于那几
 * 组，挑一个显示等于骗人。没有这个维度的单落进最后一个 `value: ""` 的组，绝不让它
 * 凭空消失。
 *
 * agent 维度按 `AGENT_ORDER` 排序，但那张表是个白名单不是过滤器：数据里出现的、
 * 表里没有的取值不会被丢弃，而是按出现顺序追加在已知值之后——否则一个陌生取值会
 * 从页面上直接消失，这跟"缺维度的单不该凭空消失"是同一条规矩。
 *
 * @template {{ id: string }} T
 * @param {T[]} items
 * @param {FacetMap} facets
 * @param {string} dim
 * @returns {Array<{ value: string, items: T[] }>}
 */
export function groupItems(items, facets, dim) {
  /** @type {Map<string, T[]>} */
  const byValue = new Map();
  /** @type {T[]} */
  const missing = [];

  for (const item of items) {
    const values = valuesFor(facets, item.id, dim);
    if (!values.length) {
      missing.push(item);
      continue;
    }
    for (const value of values) {
      const list = byValue.get(value);
      if (list) list.push(item);
      else byValue.set(value, [item]);
    }
  }

  let order;
  if (dim === AGENT_DIM) {
    const known = AGENT_ORDER.filter((v) => byValue.has(v));
    const unknown = [...byValue.keys()].filter((v) => !AGENT_ORDER.includes(v));
    order = [...known, ...unknown];
  } else {
    order = [...byValue.keys()];
  }

  const groups = order.map((value) => ({ value, items: byValue.get(value) ?? [] }));
  if (missing.length) groups.push({ value: "", items: missing });
  return groups;
}

/**
 * 按选中的取值筛选。同一维度内是**或**，跨维度是**与**。
 *
 * 取值为空数组的维度当作没选，而不是当作"一个都不匹配"——清空一个筛选器应该是回到
 * 全部，不是清空页面。
 *
 * @template {{ id: string }} T
 * @param {T[]} items
 * @param {FacetMap} facets
 * @param {Record<string, string[]>} selected
 * @returns {T[]}
 */
export function filterItems(items, facets, selected) {
  const active = Object.entries(selected ?? {}).filter(([, vs]) => vs && vs.length);
  if (!active.length) return items;
  return items.filter((item) =>
    active.every(([dim, wanted]) => {
      const mine = valuesFor(facets, item.id, dim);
      return mine.some((v) => wanted.includes(v));
    }),
  );
}

/**
 * 把选中的取值跟当前数据对一次账：数据里已经没有的，丢掉。
 *
 * 为什么必须有这一步：chips 只画 `valuesOf` —— 当前数据里真实存在的取值。一旦某个
 * 被选中的取值从数据里消失（工单状态变了、同步换了一批单），它就变成一个**看不见、
 * 点不掉、却仍在生效**的筛选：页面被筛空，而屏幕上没有任何一个 chip 是选中态，用户
 * 完全无从知道发生了什么，也没有任何一个可点的东西能解除它。
 *
 * 这跟"移除字段时要连它的选择一起清掉"是同一个失败模式，只是走的另一条路：那次是
 * 字段被拿掉，这次是取值自己没了。两处都必须保证——**能生效的筛选，必须是看得见、
 * 点得掉的那些**。
 *
 * 取值全部失效的维度整条丢掉，而不是留一个空数组：空数组在 filterItems 里等价于
 * 没选，但留着会让存储里慢慢堆满没有意义的键。
 *
 * @param {FacetMap} facets
 * @param {Record<string, string[]>} selected
 * @returns {Record<string, string[]>}
 */
export function pruneSelection(facets, selected) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [dim, wanted] of Object.entries(selected ?? {})) {
    if (!Array.isArray(wanted) || !wanted.length) continue;
    const alive = new Set(valuesOf(facets, dim));
    const kept = wanted.filter((v) => alive.has(v));
    if (kept.length) out[dim] = kept;
  }
  return out;
}
