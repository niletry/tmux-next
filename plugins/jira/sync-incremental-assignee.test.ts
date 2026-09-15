import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Facet } from "../types";

/**
 * 回归：增量同步（`sync()` 的 else 分支）故意绕开 `issues()`，不写模块级的
 * `cache`——理由是增量结果只有"这次变了的几条"，写进那份"全量列表"缓存会把
 * 页面渲染成"这就是全部工单"。但这条分支连 `issueCache`（`enrich()` 真正读
 * facet 的地方）也一并绕开了，而 Jira 的搜索响应本身是带 assignee 字段的
 * （client.ts 的 FIELDS 里有它）——增量同步问到了负责人，却从没存起来，
 * `enrich()` 只能报"没有这个 facet"，首页的「负责人」chip 空着，得手动点一次
 * 单条「刷新」（走 refreshIssue，单独写 issueCache）才会补上。
 *
 * 用一份全新的模块实例：先用一次全量同步把游标和 cache 焐热（模拟"服务器已经
 * 跑了一阵子，不是刚重启"），再用第二次增量同步带回一条新 issue，直接调
 * enrich() 断言负责人 facet 已经在，全程不碰 refreshIssue。
 */

const stateDir = mkdtempSync(join(tmpdir(), "jira-sync-assignee-items-"));
const itemsPath = join(stateDir, "items.json");
const bindingsPath = join(stateDir, "bindings.json");
const jiraDir = mkdtempSync(join(tmpdir(), "jira-sync-assignee-config-"));

const prevJiraDir = process.env.TMUX_NEXT_JIRA_DIR;
const prevItemsPath = process.env.TMUX_NEXT_ITEMS_PATH;
const prevBindingsPath = process.env.TMUX_NEXT_BINDINGS_PATH;
process.env.TMUX_NEXT_JIRA_DIR = jiraDir;
process.env.TMUX_NEXT_ITEMS_PATH = itemsPath;
process.env.TMUX_NEXT_BINDINGS_PATH = bindingsPath;

const CONFIG_JQL = "assignee = currentUser()";

writeFileSync(
  join(jiraDir, "config.json"),
  JSON.stringify({
    url: "https://example.atlassian.net",
    email: "dev@example.com",
    token: "example-token-not-a-real-secret",
    jql: CONFIG_JQL,
  }),
);

function issueRow(key: string, id: string, summary: string, assignee: string | null) {
  return {
    id,
    key,
    fields: {
      summary,
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      issuetype: { name: "Task", hierarchyLevel: 0 },
      assignee: assignee ? { displayName: assignee } : null,
    },
  };
}

const realFetch = globalThis.fetch;

// 带查询串的动态 import：拿一份全新的模块实例，保证 cache/issueCache 都是
// 刚初始化的 null/空 Map，跟 sync-e2e.test.ts 里同样的手法。
const { sync, enrich } = await import("./server" + "?incremental-assignee-regression-test");

test("增量同步带回的新单：不点单条刷新，负责人 facet 也应该已经在", async () => {
  // 第一次：没有游标，走全量——只用来焐热 cache，结果里不含目标单，避免
  // 断言在这一步就误判为通过。
  globalThis.fetch = (async () => new Response(JSON.stringify({ issues: [] }), { status: 200 })) as unknown as typeof fetch;
  await sync();

  // 第二次：游标已经写盘且 jql 匹配，走增量——响应带一条新单，assignee 已填。
  const NEW_ISSUE = issueRow("NEW-1", "100", "刚建的单", "张三");
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ issues: [NEW_ISSUE] }), { status: 200 })) as unknown as typeof fetch;
  await sync();

  const facets = await enrich([{ id: "it-NEW-1", source: { provider: "jira", ref: "NEW-1" } }]);
  const assignee = facets["it-NEW-1"]?.find((f: Facet) => f.dim === "jira.assignee");
  expect(assignee?.value).toBe("张三");

  globalThis.fetch = realFetch;
});

test("跑完还原 env、清理临时目录", () => {
  if (prevJiraDir === undefined) delete process.env.TMUX_NEXT_JIRA_DIR;
  else process.env.TMUX_NEXT_JIRA_DIR = prevJiraDir;
  if (prevItemsPath === undefined) delete process.env.TMUX_NEXT_ITEMS_PATH;
  else process.env.TMUX_NEXT_ITEMS_PATH = prevItemsPath;
  if (prevBindingsPath === undefined) delete process.env.TMUX_NEXT_BINDINGS_PATH;
  else process.env.TMUX_NEXT_BINDINGS_PATH = prevBindingsPath;
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(jiraDir, { recursive: true, force: true });
});
