import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ItemRef } from "../types";

/**
 * 回归测试：一个工单从配置的 JQL 里掉出去（比如转成了 Done，而 JQL 尾巴是
 * `status not IN (Done, Closed, Abandoned)`）之后，`enrich()` 不该把它的所有
 * facet 全部清空，`refreshIssue`（走 `refreshItem`/单条刷新按钮）也不该白问
 * 一次——这两件事在修复前分别是：`enrich()` 只从 JQL 结果缓存里找 issue；
 * `refreshIssue` 找不到这个 key 在列表里的位置（`findIndex` 返回 -1）就把刚
 * 问到的结果直接扔掉，`if (at >= 0)` 只保护了"写回列表"这一步，从没有第二个
 * 地方接住 `at < 0` 的情况——修复前这条路径上 `refreshIssue` 返回的 issue
 * 有地方存，但 `enrich()` 压根不知道去哪儿找它,所以两条修复缺一个都不够。
 *
 * 所有用例都不出网：两个 Jira 端点都换成假 fetch，配置目录指到临时目录。
 */

const dir = mkdtempSync(join(tmpdir(), "jira-issue-cache-test-"));
const jiraDir = mkdtempSync(join(tmpdir(), "jira-issue-cache-config-"));
const itemsPath = join(dir, "items.json");
const bindingsPath = join(dir, "bindings.json");

writeFileSync(
  join(jiraDir, "config.json"),
  JSON.stringify({
    url: "https://example.atlassian.net",
    email: "dev@example.com",
    token: "example-token-not-a-real-secret",
    jql: "status not IN (Done, Closed, Abandoned)",
  }),
);

const prevJiraDir = process.env.TMUX_NEXT_JIRA_DIR;
const prevItemsPath = process.env.TMUX_NEXT_ITEMS_PATH;
const prevBindingsPath = process.env.TMUX_NEXT_BINDINGS_PATH;
process.env.TMUX_NEXT_JIRA_DIR = jiraDir;
process.env.TMUX_NEXT_ITEMS_PATH = itemsPath;
process.env.TMUX_NEXT_BINDINGS_PATH = bindingsPath;

const { issues, refreshIssue } = await import("./cache");
const { enrich } = await import("./source");

function issueRow(key: string, id: string, summary: string, status = "In Progress") {
  return {
    id,
    key,
    fields: {
      summary,
      status: { name: status, statusCategory: { key: "indeterminate" } },
      issuetype: { name: "Task", hierarchyLevel: 0 },
    },
  };
}

const realFetch = globalThis.fetch;

function itemFor(key: string): ItemRef {
  return { id: `it-${key}`, source: { provider: "jira", ref: key } };
}

test("掉出 JQL 结果、但刷新过的单：enrich 仍然给它状态 facet", async () => {
  // JQL 结果里只有一条活跃的单；DONE-1 已经转成 Done,不在这次结果里——
  // 这正是配置里 `status not IN (Done, ...)` 尾巴造成的现实情况。
  const listRows = [issueRow("ACTIVE-1", "1", "还在做的单")];
  const doneRow = issueRow("DONE-1", "2", "刚做完的单", "Done");
  const counts = { list: 0, single: 0 };

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === "string" ? input : input.toString();
    if (href.includes("/rest/api/3/search/jql")) {
      counts.list++;
      return new Response(JSON.stringify({ issues: listRows }), { status: 200 });
    }
    if (href.includes("/rest/api/3/issue/DONE-1")) {
      counts.single++;
      return new Response(JSON.stringify(doneRow), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    await issues(true); // 预热 JQL 结果缓存,只含 ACTIVE-1
    const fresh = await refreshIssue("DONE-1"); // 单独刷新一个不在列表里的单
    expect(fresh?.key).toBe("DONE-1");

    const facets = await enrich([itemFor("ACTIVE-1"), itemFor("DONE-1")]);
    const doneStatus = facets[`it-DONE-1`]?.find((f) => f.dim === "jira.status");
    expect(doneStatus?.value).toBe("Done");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("refreshIssue 刷新一个不在列表里的单：不会把它塞进 JQL 结果缓存", async () => {
  const listRows = [issueRow("ACTIVE-2", "3", "还在做的单")];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === "string" ? input : input.toString();
    if (href.includes("/rest/api/3/search/jql")) {
      return new Response(JSON.stringify({ issues: listRows }), { status: 200 });
    }
    if (href.includes("/rest/api/3/issue/DONE-2")) {
      return new Response(JSON.stringify(issueRow("DONE-2", "4", "另一个做完的单", "Done")), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    await issues(true);
    await refreshIssue("DONE-2");
    const listed = await issues(false); // 60 秒内命中缓存,读到的还是刷新前那份列表
    expect(listed.ok && listed.issues.map((i) => i.key)).toEqual(["ACTIVE-2"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("refreshIssue 刷新一个在列表里的单：原地更新，不重复也不丢", async () => {
  const oldRow = issueRow("ACTIVE-3", "5", "旧标题");
  const newRow = issueRow("ACTIVE-3", "5", "新标题");
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === "string" ? input : input.toString();
    if (href.includes("/rest/api/3/search/jql")) {
      return new Response(JSON.stringify({ issues: [oldRow] }), { status: 200 });
    }
    if (href.includes("/rest/api/3/issue/ACTIVE-3")) {
      return new Response(JSON.stringify(newRow), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    await issues(true);
    const fresh = await refreshIssue("ACTIVE-3");
    expect(fresh?.summary).toBe("新标题");
    const listed = await issues(false);
    expect(listed.ok && listed.issues.length).toBe(1);
    expect(listed.ok && listed.issues[0]!.summary).toBe("新标题");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("enrich 从不发请求：注入一个会抛的 fetch 也不受影响", async () => {
  globalThis.fetch = (() => {
    throw new Error("enrich 不该发任何请求");
  }) as unknown as typeof fetch;

  try {
    // 不 await 任何网络相关的准备——目的就是证明 enrich 本身不碰 fetch。
    const facets = await enrich([itemFor("WHATEVER-1")]);
    expect(facets).toEqual({});
  } finally {
    globalThis.fetch = realFetch;
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
  rmSync(jiraDir, { recursive: true, force: true });
});
