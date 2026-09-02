import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `sync()` 打日志的那一分支——不是 start() 的 .catch()，那里永远等不到会拒绝的
 * sync()（见 plugins/jira/server.ts 里两处的注释）。真正知道"问不到、以及为什么"
 * 的是 `sync()` 内部 `!result.ok` 那个分支，这条测试盯的是它。
 *
 * 用注入/桩替掉的失败，不发真实请求：
 * - "auth" 场景：config.json 是真的，把 globalThis.fetch 换成答 401 的假路由，
 *   走的是 fetchIssues() 真实的分类逻辑（不是重新实现一遍再断言）。
 * - "unconfigured" 场景：压根不给 config.json，readJiraConfig() 天然返回 null，
 *   同样是真实代码路径。
 */

const dir = mkdtempSync(join(tmpdir(), "jira-sync-log-test-"));
const itemsPath = join(dir, "items.json");
const bindingsPath = join(dir, "bindings.json");

const prevJiraDir = process.env.TMUX_NEXT_JIRA_DIR;
const prevItemsPath = process.env.TMUX_NEXT_ITEMS_PATH;
const prevBindingsPath = process.env.TMUX_NEXT_BINDINGS_PATH;
process.env.TMUX_NEXT_ITEMS_PATH = itemsPath;
process.env.TMUX_NEXT_BINDINGS_PATH = bindingsPath;

const { sync } = await import("./server");

/** 桩掉 console.error，接住调用而不真的往 stderr 写，跑完照原样还回去。 */
function stubConsoleError() {
  const calls: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  return { calls, restore: () => { console.error = orig; } };
}

test("拉取失败被分类为 auth 时，sync() 打一行分类过的日志——不带原始响应体", async () => {
  const jiraDir = mkdtempSync(join(tmpdir(), "jira-sync-log-auth-"));
  writeFileSync(
    join(jiraDir, "config.json"),
    JSON.stringify({
      url: "https://example.atlassian.net",
      email: "dev@example.com",
      token: "example-token-not-a-real-secret",
    }),
  );
  process.env.TMUX_NEXT_JIRA_DIR = jiraDir;

  const realFetch = globalThis.fetch;
  // Jira 的 401 响应体里带账号信息——这条假路由回一个明显能被认出来的敏感串，
  // 断言里专门盯着它绝不能出现在任何一次 console.error 调用里。
  const SENSITIVE = "SECRET-ACCOUNT-DETAIL-DO-NOT-LOG";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ errorMessages: [SENSITIVE] }), { status: 401 })) as unknown as typeof fetch;

  const { calls, restore } = stubConsoleError();
  try {
    await sync();
    expect(calls.length).toBeGreaterThan(0);
    const flat = calls.map((c) => c.join(" ")).join("\n");
    expect(flat).toContain("auth");
    expect(flat).not.toContain(SENSITIVE);
  } finally {
    restore();
    globalThis.fetch = realFetch;
    rmSync(jiraDir, { recursive: true, force: true });
  }
});

test("没配置 Jira 时 sync() 不打错误日志——那是正常的初始状态，不是故障", async () => {
  const jiraDir = mkdtempSync(join(tmpdir(), "jira-sync-log-unconfigured-"));
  process.env.TMUX_NEXT_JIRA_DIR = jiraDir; // 空目录，没有 config.json

  const { calls, restore } = stubConsoleError();
  try {
    await sync();
    expect(calls.length).toBe(0);
  } finally {
    restore();
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
