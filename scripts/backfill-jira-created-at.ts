#!/usr/bin/env bun
/**
 * 一次性脚本：把已经落库的 Jira 单的 createdAt 改回 Jira 上真正的创建时间。
 *
 * dfcb5f7 修了 ensureItemForSource,让**新建**的单拿到 Jira 的真实创建时间,但
 * 明确不改已经存在的单的 createdAt(跟 title/tags 一样当成本地已落定的事,见
 * src/items.ts 的注释和 src/items.test.ts 的对应用例)。结果是那条修复之前就
 * 同步进来的单,createdAt 永远是"第一次同步到它"那一刻的时间——同一批同步
 * 进来的单会全部挤在同一个时间点上,拍平了真实的创建顺序,排序(创建时间:
 * 旧→新)因此看起来是乱的。
 *
 * 这里直接绕过 ensureItemForSource 的"已存在就不碰 createdAt"规则,因为这次
 * 就是要纠正历史数据,不是走线上更新路径。
 *
 * 用法: bun run scripts/backfill-jira-created-at.ts [--dry-run]
 */
import { readJiraConfig } from "../plugins/jira/config";
import { fetchIssues } from "../plugins/jira/client";
import { itemsPath, readItems, type WorkItem } from "../src/items";
import { writeJsonAtomic, serialized } from "../src/json-store";

const CHUNK_SIZE = 100; // 跟 client.ts 的单页上限对齐,一次 JQL 别问太长

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const config = await readJiraConfig();
  if (!config) {
    console.error("Jira 未配置,没有可对照的来源。");
    process.exit(1);
  }

  const items = await readItems();
  const jiraItems = items.filter((i) => i.source?.provider === "jira");
  if (!jiraItems.length) {
    console.log("没有 Jira 来源的单,无需处理。");
    return;
  }

  const createdByKey = new Map<string, number>();
  for (let i = 0; i < jiraItems.length; i += CHUNK_SIZE) {
    const chunk = jiraItems.slice(i, i + CHUNK_SIZE);
    const keys = chunk.map((it) => it.source!.ref);
    const jql = `key in (${keys.join(",")})`;
    const result = await fetchIssues(config, fetch, jql);
    if (!result.ok) {
      console.error(`第 ${i / CHUNK_SIZE + 1} 批查询失败: ${result.reason}`);
      continue;
    }
    for (const issue of result.issues) {
      if (issue.created > 0) createdByKey.set(issue.key, Math.floor(issue.created / 1000));
    }
  }

  let missing = 0;
  const lines: string[] = [];
  const corrected = new Map<string, number>(); // itemId -> real createdAt
  for (const item of jiraItems) {
    const real = createdByKey.get(item.source!.ref);
    if (real === undefined) {
      missing++;
      continue;
    }
    if (real !== item.createdAt) {
      lines.push(
        `${item.source!.ref}: ${new Date(item.createdAt * 1000).toISOString()} -> ${new Date(real * 1000).toISOString()}`,
      );
      corrected.set(item.id, real);
    }
  }

  console.log(lines.join("\n"));
  console.log(
    `\n共 ${jiraItems.length} 张 Jira 单,${corrected.size} 张需要纠正,${missing} 张在 Jira 查不到(可能已删除/无权限)。`,
  );

  if (dryRun) {
    console.log("(--dry-run,未写盘)");
    return;
  }
  if (!corrected.size) return;

  await serialized(async () => {
    const latest = await readItems();
    const out: WorkItem[] = latest.map((it) =>
      corrected.has(it.id) ? { ...it, createdAt: corrected.get(it.id)! } : it,
    );
    await writeJsonAtomic(itemsPath(), out);
  });
  console.log("已写回 items.json。");
}

main();
