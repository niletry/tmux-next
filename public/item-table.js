// @ts-check
/**
 * 首页列表视图里"该画哪些 facet"这一层。
 *
 * 单独成文件、`@ts-check`、无头可测，理由跟 facet-view.js 一样：页面文件不做类型
 * 检查，而这里的计算是列表里唯一真有判断的地方——算错了，一张单要么少一个 chip，
 * 要么多一个永远空着的 chip，两种都是安静地错。
 *
 * chip 不是从数据里的维度全摊开来的：维度是开放集合，插件随时能再贴几个，全摊开
 * 就是一行永远换不完行的 chip。哪些值得画是使用者的判断，而这个判断在筛选区已经
 * 做过一次了（「添加字段」），所以列表直接复用它，不发明第二套开关。
 */

/** @typedef {{ dim: string, value: string, tone?: "ok" | "warn" | "dim" }} Facet */

/**
 * 已经有固定列的维度。它们照样能被加进筛选区（筛选和显示是两件事），但加了之后
 * 不该再单独成列——那是两列一模一样的东西。
 */
export const FIXED_DIMS = ["item.agent", "item.sessions"];

/**
 * 表格里 facet 列的维度，按用户加字段的顺序。
 *
 * @param {string[]} dims 当前这批单里真出现过的维度
 * @param {string[]} fields 存下来的筛选字段（原样，未对账）
 * @returns {string[]}
 */
export function tableColumns(dims, fields) {
  const present = new Set(dims ?? []);
  const out = [];
  const seen = new Set(FIXED_DIMS);
  for (const dim of fields ?? []) {
    if (seen.has(dim) || !present.has(dim)) continue;
    seen.add(dim);
    out.push(dim);
  }
  return out;
}

/**
 * 一张单在某个维度上的全部 facet。
 *
 * 返回数组而不是第一个：一个维度可以有多个取值（标签就是），只画第一个等于在
 * 表格里悄悄丢数据。
 *
 * @param {Facet[] | undefined} list
 * @param {string} dim
 * @returns {Facet[]}
 */
export function facetsIn(list, dim) {
  return (list ?? []).filter((f) => f.dim === dim);
}
