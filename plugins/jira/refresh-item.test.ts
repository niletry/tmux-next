import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `refreshItem` 的两条 Important 修复：
 *
 * 1. `refreshIssue` 问不到（未配置、Jira 不通）时，`refreshItem` 必须抛，不能
 *    悄悄 return——否则 `refreshFromSource` 看到的是一个 resolve 掉的
 *    Promise，`/api/items/:id/refresh` 答 `{ok:true}`，页面照着"刷新成功"重画，
 *    而什么都没刷到。这条不需要真的打网络：把 TMUX_NEXT_JIRA_DIR 指到一个没有
 *    config.json 的空目录，`readJiraConfig()` 天然返回 null，`refreshIssue`
 *    天然返回 null，走的是真实代码路径，不是重新实现一遍逻辑再断言。
 *
 * 2. `refreshItem` 成功时必须把新标题写回内核（`ensureItemForSource(...,
 *    {refreshTitle:true})`）——不然远端改了标题，全量同步 (`sync()`) 会跟上，
 *    点这一个单自己的刷新按钮反而不会，用户会觉得"刷新"没生效。这一条需要一次
 *    "成功"的 refreshIssue，所以把 globalThis.fetch 换成假 fetcher，只接住这
 *    次请求；测试自己的断言不发任何请求，用不到真 fetch。
 */

const dir = mkdtempSync(join(tmpdir(), "jira-refresh-item-test-"));
const itemsPath = join(dir, "items.json");
const bindingsPath = join(dir, "bindings.json");

const prevJiraDir = process.env.TMUX_NEXT_JIRA_DIR;
const prevItemsPath = process.env.TMUX_NEXT_ITEMS_PATH;
const prevBindingsPath = process.env.TMUX_NEXT_BINDINGS_PATH;
process.env.TMUX_NEXT_JIRA_DIR = join(dir, "jira-unconfigured");
process.env.TMUX_NEXT_ITEMS_PATH = itemsPath;
process.env.TMUX_NEXT_BINDINGS_PATH = bindingsPath;

// env 必须在 import 之前就位——虽然这几条路径都是逐次现读（CLAUDE.md 的规矩），
// 但提前设总是安全的，也跟仓库里其它同类测试的写法一致。
const { refreshItem } = await import("./server");
const { readItems } = await import("../../src/items");

test("未配置 Jira 时，refreshItem 抛出而不是悄悄返回", async () => {
  await expect(refreshItem("EXAMPLE-404")).rejects.toThrow();
});

test("刷新成功时把新标题写回内核的单", async () => {
  const jiraDir = mkdtempSync(join(tmpdir(), "jira-refresh-item-configured-"));
  writeFileSync(
    join(jiraDir, "config.json"),
    JSON.stringify({
      url: "https://example.atlassian.net",
      email: "dev@example.com",
      token: "example-token-not-a-real-secret",
    }),
  );
  const prevDir = process.env.TMUX_NEXT_JIRA_DIR;
  process.env.TMUX_NEXT_JIRA_DIR = jiraDir;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === "string" ? input : input.toString();
    if (href.includes("/rest/api/3/issue/")) {
      return new Response(
        JSON.stringify({
          id: "10099",
          key: "EXAMPLE-9",
          fields: {
            summary: "远端改过的新标题",
            status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
            issuetype: { name: "Bug", hierarchyLevel: 0 },
          },
        }),
        { status: 200 },
      );
    }
    if (href.includes("/rest/dev-status/")) {
      return new Response(JSON.stringify({ detail: [] }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    await refreshItem("EXAMPLE-9");
    const items = await readItems();
    const item = items.find((i) => i.source?.provider === "jira" && i.source.ref === "EXAMPLE-9");
    expect(item?.title).toBe("远端改过的新标题");
  } finally {
    globalThis.fetch = realFetch;
    process.env.TMUX_NEXT_JIRA_DIR = prevDir;
    rmSync(jiraDir, { recursive: true, force: true });
  }
});

test("跑完还原 env、清理临时目录", () => {
  if (prevJiraDir === undefined) delete process.env.TMUX_NEXT_JIRA_DIR;
  else process.env.TMUX_NEXT_JIRA_DIR = prevJiraDir;
  if (prevItemsPath === undefined) delete process.env.TMUX_NEXT_ITEMS_PATH;
  else process.env.TMUX_NEXT_ITEMS_PATH = prevItemsPath;
  if (prevBindingsPath === undefined) delete process.env.TMUX_NEXT_BINDINGS_PATH;
  else process.env.TMUX_NEXT_BINDINGS_PATH = prevBindingsPath;
  rmSync(dir, { recursive: true, force: true });
});
