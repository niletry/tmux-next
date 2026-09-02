import type { Issue } from "./client";
import type { SyncResult } from "../handlers";

export const MAX_SYNC_ITEMS = 200;

/**
 * Jira 工单→ items 映射循环，纯函数无网络无磁盘，测试可无头进行。
 *
 * ensure 注入参数，真实调用方在 Task 6 里把它接到 ensureItemForSource。
 * 串行处理（for + await），不是 Promise.all——ensureItemForSource 内部按进程内队列
 * 串行化并写同一份 items.json，并发只会排满它；单条失败 try/catch 跳过，不中断后续。
 *
 * 超过 MAX_SYNC_ITEMS 截断且标出 truncated，不是静默吞掉——「我们没问到」和
 * 「没有」是两回事，页面需要知道结果可能不完整。
 */
export async function syncIssues(
  issues: Issue[],
  ensure: (ref: string, title: string) => Promise<{ created: boolean }>,
): Promise<SyncResult> {
  // 按上限截断。
  const truncated = issues.length > MAX_SYNC_ITEMS;
  const toSync = issues.slice(0, MAX_SYNC_ITEMS);

  let created = 0;
  let updated = 0;

  // 串行处理每条工单。
  for (const issue of toSync) {
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
    truncated,
  };
}
