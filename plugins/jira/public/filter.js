// @ts-check
/**
 * 工单列表的筛选。
 *
 * 纯函数、无 DOM：可选项是从**当前这批工单**算出来的，不是写死的清单——写死意味着
 * 每个实例的状态名都要进代码，而且会列出一堆当前一条都没有的选项。
 *
 * 筛选在客户端做，因为数据已经在手上了：再发一次请求去问服务器"只要这个状态的"，
 * 等于为一个瞬时操作付一次网络往返，而工单总数被 JQL 限制在几十条。
 */

/** @typedef {{ key: string, status: string, parent: { key: string, hierarchy: number } | null }} Issue */
/** @typedef {{ epic: string, status: string }} Filters */

/** 空字符串表示不筛。 */
export const NO_FILTERS = { epic: "", status: "" };

/**
 * 这个工单的史诗号，没有就是空字符串。
 *
 * 只认层级 ≥ 1 的父级：`parent` 字段同时装着子任务的父任务，把那个当史诗筛会得到
 * 一堆名不副实的分组。
 *
 * @param {Issue} issue
 * @returns {string}
 */
export function epicOf(issue) {
  return issue.parent && issue.parent.hierarchy >= 1 ? issue.parent.key : "";
}

/**
 * @param {Issue} issue
 * @param {Filters} filters
 * @returns {boolean}
 */
export function matches(issue, filters) {
  if (filters.epic && epicOf(issue) !== filters.epic) return false;
  if (filters.status && issue.status !== filters.status) return false;
  return true;
}

/**
 * 可选项，以及每一项当前有多少条。
 *
 * 每一维的计数是在**其它维已经筛过**之后算的，所以数字就是"点下去会剩几条"，而不是
 * 一个跟当前视图无关的总数——点了才发现是 0 的选项比没有这个选项更让人困惑。
 *
 * @param {Issue[]} issues
 * @param {Filters} filters
 */
export function options(issues, filters) {
  const count = (/** @type {string} */ dim, /** @type {(i: Issue) => string} */ pick) => {
    /** @type {Map<string, number>} */
    const seen = new Map();
    const others = { ...filters, [dim]: "" };
    for (const issue of issues) {
      if (!matches(issue, others)) continue;
      const value = pick(issue);
      if (!value) continue;
      seen.set(value, (seen.get(value) ?? 0) + 1);
    }
    // 数量多的排前面：手机上一行放不下几个，最有用的该先出现。
    return [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };

  return {
    epics: count("epic", epicOf),
    statuses: count("status", (i) => i.status),
  };
}
