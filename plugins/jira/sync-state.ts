import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { pluginStateDir } from "../state";

/**
 * 增量同步的游标：上一次成功同步"发起"的时间，以及那次用的 JQL。
 *
 * jql 存下来不是为了展示，是为了**作废**这个游标：如果用户在设置页改了
 * config.jql，旧游标描述的是另一条查询——"这条查询里，updated 之后变了什么"
 * 对新的查询没有意义（新查询可能匹配到一批老游标从没见过的单，把它们当"没变"
 * 跳过就是漏同步）。所以 jql 不一致时，调用方（sync()）该退回全量。
 */
export type SyncState = { lastSyncAt: number; jql: string };

function syncStatePath(): string {
  return join(pluginStateDir("jira"), "sync-state.json");
}

/**
 * 读游标，或者 null。全函数：文件不在、JSON 坏了、字段形状不对，一律读成
 * "没有游标"——跟 config.ts 的 readJiraConfig 同一个道理，没有一种值得让
 * 同步失败。
 */
export async function readSyncState(): Promise<SyncState | null> {
  try {
    const data = (await Bun.file(syncStatePath()).json()) as Record<string, unknown>;
    if (typeof data?.lastSyncAt !== "number" || typeof data?.jql !== "string") return null;
    return { lastSyncAt: data.lastSyncAt, jql: data.jql };
  } catch {
    return null;
  }
}

export async function writeSyncState(state: SyncState): Promise<void> {
  const dir = pluginStateDir("jira");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "sync-state.json"), JSON.stringify(state, null, 2));
}
