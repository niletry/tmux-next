// @ts-check
/**
 * 折叠状态：一组 id，按设备存。
 *
 * 两个调用点，语义相反：会话列表页存**折起的**那几个（它默认全展开），设置页存
 * **展开的**那几个（它默认全折起）。这个模块只认"一组 id"，不认哪一边是默认——
 * 两边都存"偏离默认的那些"，于是"没存过"在各自那边自然等于各自的默认态，不必
 * 为它写一条分支。
 *
 * 按设备而不是按机器，跟字号同类：这是关于这块屏幕的陈述，不是关于这台主机的。
 *
 * 每一条读路径都得退化成空集而不是抛出去。隐私窗口、站点数据被清、浏览器设置里
 * 禁掉存储，这三种在真机上都出现过，而它们是 getItem 自己抛、不是返回 null；再
 * 加上一个半写的值。任何一种都不该让页面画不出来——画出来才是那两页的正事。
 */

/**
 * 存着的那组 id。读不出、读坏、形状不对，都是空集。
 *
 * @param {string} key
 * @returns {Set<string>}
 */
export function readIds(key) {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    // JSON.parse 成功但形状不对是最容易漏的一种：它不抛异常，直接把一个不是
    // 数组的东西送进渲染。数组里混进非字符串同理，一并滤掉。
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id) => typeof id === "string"));
  } catch {
    return new Set();
  }
}

/**
 * 存下这组 id。存不进去只影响"下次打开还记不记得"，不影响此刻。
 *
 * @param {string} key
 * @param {Set<string>} ids
 */
export function writeIds(key, ids) {
  try {
    localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    // 浏览器拒绝存储时折叠照样能用，只是记不住——状态活在 DOM 里直到下次重画。
  }
}

/**
 * 翻转一个 id 并存下来，返回新的那一组。
 *
 * 两个调用点都是"读—翻转—写—重画"，所以翻转也在这里，不在各自页面里抄一遍。
 *
 * @param {string} key
 * @param {string} id
 * @returns {Set<string>}
 */
export function toggleId(key, id) {
  const ids = readIds(key);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  writeIds(key, ids);
  return ids;
}
