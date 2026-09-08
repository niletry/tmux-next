import type { Issue } from "./client";
import type { SyncResult } from "../handlers";

/**
 * Jira 工单→ items 映射循环，纯函数无网络无磁盘，测试可无头进行。
 *
 * ensure 注入参数，真实调用方在 Task 6 里把它接到 ensureItemForSource。
 * 串行处理（for + await），不是 Promise.all——ensureItemForSource 内部按进程内队列
 * 串行化并写同一份 items.json，并发只会排满它；单条失败 try/catch 跳过，不中断后续。
 *
 * 不在这里再截一刀：`fetched` 已经带着 fetchIssues 自己判出来的 truncated——
 * 这个仓库的 Jira 实例装到 249 条匹配的工单之后，这里曾经单独设的 MAX_SYNC_ITEMS
 * （200）比 fetchIssues 拿回来的还小，导致排在后面的工单每次同步都被截掉、
 * 且没有任何提示。两层上限互相不知道对方设的是多少，迟早会有一层比实际用量还
 * 小；只留 fetchIssues 那一层，「我们没问到」这件事就只有一个地方能说。
 */
export async function syncIssues(
  fetched: { issues: Issue[]; truncated: boolean },
  ensure: (ref: string, title: string) => Promise<{ created: boolean }>,
): Promise<SyncResult> {
  let created = 0;
  let updated = 0;

  // 串行处理每条工单。
  for (const issue of fetched.issues) {
    try {
      const result = await ensure(issue.key, issue.summary);
      if (result.created) {
        created++;
      } else {
        updated++;
      }
    } catch {
      // 单条失败不中断后续。
    }
  }

  return {
    created,
    updated,
    total: created + updated,
    truncated: fetched.truncated,
  };
}
