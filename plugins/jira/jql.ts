/**
 * 把用户配置的 JQL 包一层"最近更新过"的条件，供增量同步用。纯函数，不碰网络
 * 也不碰磁盘。
 */

/**
 * 用相对时间形式 `updated >= "-<N>m"`，不用绝对时间戳。
 *
 * JQL 的日期字面量按这个 Jira 实例自己配的时区解释，而且只精确到分钟——算出
 * 一个绝对时间戳传过去，等于把"我们这边的时区是不是跟它一致""要不要管 DST"
 * 这类问题都抱回来。相对形式让 Jira 自己去解释"现在往前数 N 分钟"，不管它的
 * 时区配的是什么、今天有没有跨夏令时边界，答案都对。
 */
function recencyClause(minutes: number): string {
  // 非正数没有意义（不该问"未来"），钳到至少 1 分钟。
  const m = Math.max(1, Math.ceil(minutes));
  return `updated >= "-${m}m"`;
}

/**
 * 在用户的 JQL 上叠一条"最近更新过"的条件。
 *
 * 两个坑：
 *
 * 1. 用户的 JQL 必须先加括号再 AND——`project = A OR project = B` 直接拼上
 *    ` AND updated >= ...` 会被解析成 `project = A OR (project = B AND
 *    updated >= ...)`，AND 比 OR 绑得紧，静默漏掉一半结果。
 * 2. JQL 的形状是 `<条件> ORDER BY <字段...>`，ORDER BY 必须留在最后——如果
 *    原始 JQL 带了 ORDER BY，得先把它切下来，AND 只加在条件那一半上，再把
 *    ORDER BY 原样接回去；直接在 ORDER BY 后面拼 AND 是语法错误。
 */
export function incrementalJql(userJql: string, minutes: number): string {
  const recency = recencyClause(minutes);
  const trimmed = userJql.trim();
  if (!trimmed) return recency;

  // ORDER BY 只在末尾合法，大小写不敏感；找最后一次出现，处理字段名恰好
  // 包含 "order by" 子串这种边角情况（真实 JQL 里几乎不会发生，但找最后一个
  // 比找第一个更贴近"它是结尾从句"这条前提）。
  const orderByRe = /\border\s+by\s+/gi;
  let lastIdx = -1;
  for (let m = orderByRe.exec(trimmed); m; m = orderByRe.exec(trimmed)) {
    lastIdx = m.index;
  }

  if (lastIdx === -1) {
    return `(${trimmed}) AND ${recency}`;
  }

  const conditions = trimmed.slice(0, lastIdx).trim();
  const orderBy = trimmed.slice(lastIdx).trim();
  if (!conditions) {
    // 理论上不合法的 JQL（ORDER BY 前面没有条件），别崩，也别加空括号。
    return `${recency} ${orderBy}`;
  }
  return `(${conditions}) AND ${recency} ${orderBy}`;
}
