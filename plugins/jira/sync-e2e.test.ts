import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `sync()` 自己那步"选 FULL 还是 INCREMENTAL、算多大的窗口"是这几块拼起来的
 * 那一步：`incrementalJql`、sync-state 的读写、`resolveDevIds` 各自的单测都
 * 只证明了被抽出来的那一小块纯逻辑是对的，没有一条测试真的调用 `sync()` 本身
 * 去看两条分支有没有接对——颠倒 full 判断、或者调 `fetchIssues` 时漏传窗口
 * 参数，整个套件都不会红。这个文件专门补这一段：注入假 fetch，看请求里真正
 * 带的 jql 是什么。顺带盖住时钟往回跳这个边角——那种情况下退回全量是刻意的
 * 选择，不是"忘了钳"，理由见 server.ts 里 `clockWentBackward` 那条注释。
 *
 * 每条用例自己的 config.json / sync-state.json 都在独立的临时目录里；
 * items.json / bindings.json 用同一份空目录整个文件共享——所有假响应的
 * issues 都是空数组，syncIssues 对空列表什么也不写，不会有测试间的串扰。
 */

const stateDir = mkdtempSync(join(tmpdir(), "jira-sync-e2e-items-"));
const itemsPath = join(stateDir, "items.json");
const bindingsPath = join(stateDir, "bindings.json");

const prevJiraDir = process.env.TMUX_NEXT_JIRA_DIR;
const prevItemsPath = process.env.TMUX_NEXT_ITEMS_PATH;
const prevBindingsPath = process.env.TMUX_NEXT_BINDINGS_PATH;
process.env.TMUX_NEXT_ITEMS_PATH = itemsPath;
process.env.TMUX_NEXT_BINDINGS_PATH = bindingsPath;

const { sync } = await import("./server");

const CONFIG_JQL = "assignee = currentUser()";

function writeConfig(jiraDir: string, jql: string = CONFIG_JQL) {
  writeFileSync(
    join(jiraDir, "config.json"),
    JSON.stringify({
      url: "https://example.atlassian.net",
      email: "dev@example.com",
      token: "example-token-not-a-real-secret",
      jql,
    }),
  );
}

function writeState(jiraDir: string, lastSyncAt: number, jql: string = CONFIG_JQL) {
  writeFileSync(join(jiraDir, "sync-state.json"), JSON.stringify({ lastSyncAt, jql }));
}

function readState(jiraDir: string): { lastSyncAt: number; jql: string } | null {
  try {
    return JSON.parse(readFileSync(join(jiraDir, "sync-state.json"), "utf8"));
  } catch {
    return null;
  }
}

/** 假 fetch：接住请求里的 jql，回一个空的 issues 列表——没有单可同步，
 * syncIssues 对空数组什么也不做，不会牵连到别的测试用的 items.json。 */
function fakeSearch(seen: { jql?: string }[], status = 200) {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(input as string);
    seen.push({ jql: url.searchParams.get("jql") ?? undefined });
    if (status !== 200) return new Response(JSON.stringify({ errorMessages: ["boom"] }), { status });
    return new Response(JSON.stringify({ issues: [] }), { status: 200 });
  }) as unknown as typeof fetch;
}

async function withJiraDir<T>(fn: (jiraDir: string) => Promise<T>): Promise<T> {
  const jiraDir = mkdtempSync(join(tmpdir(), "jira-sync-e2e-config-"));
  const prev = process.env.TMUX_NEXT_JIRA_DIR;
  process.env.TMUX_NEXT_JIRA_DIR = jiraDir;
  const realFetch = globalThis.fetch;
  try {
    return await fn(jiraDir);
  } finally {
    globalThis.fetch = realFetch;
    process.env.TMUX_NEXT_JIRA_DIR = prev;
    rmSync(jiraDir, { recursive: true, force: true });
  }
}

test("没有游标时走全量：请求的 jql 就是 config.jql 本身，不带 updated 条件", async () => {
  await withJiraDir(async (jiraDir) => {
    writeConfig(jiraDir);
    const seen: { jql?: string }[] = [];
    globalThis.fetch = fakeSearch(seen);

    await sync();

    expect(seen.length).toBe(1);
    expect(seen[0]!.jql).toBe(CONFIG_JQL);
    expect(seen[0]!.jql).not.toContain("updated >=");
  });
});

test("游标存在且 jql 匹配时走增量：请求带 updated >= \"-Nm\"，N 由 lastSyncAt 算出", async () => {
  await withJiraDir(async (jiraDir) => {
    writeConfig(jiraDir);
    // 10.5 分钟前，不卡在整分钟的边界上：如果用整十分钟，"读文件、发请求"这几步
    // 之间流逝的时间可能是 0 毫秒（机器够快、没跨过一次时钟滴答），diff 恰好等于
    // 600000ms，ceil(10) = 10 而不是 11，N 就会在 12/13 之间跳。多留 500ms 的
    // 偏移量后，diff 稳定落在 (600500, 661000) 区间，ceil 恒为 11，N 恒为 13。
    const lastSyncAt = Date.now() - (10 * 60_000 + 500);
    writeState(jiraDir, lastSyncAt);
    const seen: { jql?: string }[] = [];
    globalThis.fetch = fakeSearch(seen);

    await sync();

    expect(seen.length).toBe(1);
    expect(seen[0]!.jql).toBe(`(${CONFIG_JQL}) AND updated >= "-13m"`);
  });
});

test("游标的 jql 跟当前配置不一样时，游标作废，退回全量", async () => {
  await withJiraDir(async (jiraDir) => {
    writeConfig(jiraDir, CONFIG_JQL);
    writeState(jiraDir, Date.now() - 5 * 60_000, "project = OLD"); // 游标记的是另一条查询
    const seen: { jql?: string }[] = [];
    globalThis.fetch = fakeSearch(seen);

    await sync();

    expect(seen[0]!.jql).toBe(CONFIG_JQL);
    expect(seen[0]!.jql).not.toContain("updated >=");
  });
});

test("即使有一份有效游标，sync({full:true}) 也强制走全量", async () => {
  await withJiraDir(async (jiraDir) => {
    writeConfig(jiraDir);
    writeState(jiraDir, Date.now() - 5 * 60_000, CONFIG_JQL); // 游标本来有效
    const seen: { jql?: string }[] = [];
    globalThis.fetch = fakeSearch(seen);

    await sync({ full: true });

    expect(seen[0]!.jql).toBe(CONFIG_JQL);
    expect(seen[0]!.jql).not.toContain("updated >=");
  });
});

test("拉取失败时游标不前移——原样留着上一次成功的时间", async () => {
  await withJiraDir(async (jiraDir) => {
    writeConfig(jiraDir);
    const originalLastSyncAt = Date.now() - 5 * 60_000;
    writeState(jiraDir, originalLastSyncAt);
    globalThis.fetch = fakeSearch([], 500); // 5xx：unreachable

    await sync();

    expect(readState(jiraDir)).toEqual({ lastSyncAt: originalLastSyncAt, jql: CONFIG_JQL });
  });
});

test("增量同步成功后，游标前移到这次请求发起的时间", async () => {
  await withJiraDir(async (jiraDir) => {
    writeConfig(jiraDir);
    writeState(jiraDir, Date.now() - 5 * 60_000);
    globalThis.fetch = fakeSearch([]);

    const before = Date.now();
    await sync();
    const after = Date.now();

    const state = readState(jiraDir);
    expect(state?.jql).toBe(CONFIG_JQL);
    expect(state!.lastSyncAt).toBeGreaterThanOrEqual(before);
    expect(state!.lastSyncAt).toBeLessThanOrEqual(after);
  });
});

test("时钟往回跳（游标记的时间比现在还晚）时退回全量，不拿负数窗口硬凑", async () => {
  await withJiraDir(async (jiraDir) => {
    writeConfig(jiraDir);
    // lastSyncAt 在"未来"：系统时钟被往回调过。increment 窗口算出来会是负数，
    // recencyClause 会把它钳成"至少 1 分钟"——这恰恰是最危险的答案，时钟不可信
    // 的时候应该整段不信，退回全量,而不是一个假装正常的一分钟增量窗口。
    writeState(jiraDir, Date.now() + 60 * 60_000);
    const seen: { jql?: string }[] = [];
    globalThis.fetch = fakeSearch(seen);

    await sync();

    expect(seen[0]!.jql).toBe(CONFIG_JQL);
    expect(seen[0]!.jql).not.toContain("updated >=");
  });
});

/**
 * 回归：进程重启后，磁盘上的游标依然有效，但进程内的列表缓存（server.ts 里
 * 那个模块级 `cache`）是冷的——增量分支故意绕开 `issues()`，从不写这份缓存，
 * 所以"游标有效就走增量"这条判断单独成立时，冷缓存会被无限期晾在那，
 * `enrich()` 只能从 `issueCache` 的边角料里找，首页大部分单子一个 facet 都
 * 拿不到（生产上实测：353 个单只剩 5 个还挂着 facet）。
 *
 * 不能靠"这是文件里第一条测试"来制造冷缓存——`sync-e2e.test.ts` 是不是第一个
 * 被跑到的文件，跟这份模块实例是不是刚创建、`cache` 有没有被别的用例焐热，是
 * 两件独立的事（同一个 bun 进程里,不同测试文件对同一个源文件仍可能各自拿到
 * 独立的模块实例，顺序也不由这个文件决定）。带查询串的动态 import 能绕开这层
 * 不确定性，直接换一份全新的模块实例，`cache`/`issueCache` 保证是刚初始化的
 * `null`/空 Map——这才是"进程刚启动"的真实写照。
 */
let coldModule: Pick<typeof import("./server"), "sync">;

test("准备一份全新的模块实例，模拟进程刚重启——它的 cache 保证是冷的", async () => {
  // 拼接出来的说明符（而非字符串字面量）是故意的：tsc 对字面量 import() 会
  // 按路径解析模块声明，"./server?query" 不是一个真实文件，会被当成找不到的
  // 模块报错；拼接绕开静态解析，让 tsc 把这次 import() 当 `any` 处理，同时
  // Bun 在运行时仍然把它当一个跟 "./server" 不同的说明符，换来一份全新实例。
  coldModule = await import("./server" + "?cold-cache-regression-test");
});

test("冷缓存回归：磁盘游标有效，但进程内 cache 是冷的——sync() 仍必须强制走全量", async () => {
  await withJiraDir(async (jiraDir) => {
    writeConfig(jiraDir);
    writeState(jiraDir, Date.now() - 5 * 60_000, CONFIG_JQL); // 磁盘上的游标本身完全有效
    const seen: { jql?: string }[] = [];
    globalThis.fetch = fakeSearch(seen);

    await coldModule.sync();

    // 若这里退回了增量（旧行为），请求会带 `updated >=` 子句而不是裸 jql——
    // 这条断言在修复前会失败，正是要抓的回归。
    expect(seen.length).toBe(1);
    expect(seen[0]!.jql).toBe(CONFIG_JQL);
    expect(seen[0]!.jql).not.toContain("updated >=");
  });
});

test("同一份模块实例：上一条全量把 cache 焐热、游标也已前移之后，下一次 sync() 恢复走增量", async () => {
  await withJiraDir(async (jiraDir) => {
    writeConfig(jiraDir);
    // 同样加 500ms 偏移量避开整分钟边界，理由见上面"游标存在且 jql 匹配"那条
    // 用例的注释——这里 diff 稳定落在 (300500, 361000) 区间，ceil 恒为 6，
    // +2 恒为 8。
    writeState(jiraDir, Date.now() - (5 * 60_000 + 500), CONFIG_JQL); // 又一份独立、同样有效的游标
    const seen: { jql?: string }[] = [];
    globalThis.fetch = fakeSearch(seen);

    await coldModule.sync();

    // 证明修复没有把增量整条路都关掉：缓存一旦被上一条测试的全量焐热，
    // 这个模块实例里后续的 sync() 该走增量还是走增量。
    expect(seen.length).toBe(1);
    expect(seen[0]!.jql).toBe(`(${CONFIG_JQL}) AND updated >= "-8m"`);
  });
});

test("跑完还原 env、清理临时目录", () => {
  if (prevJiraDir === undefined) delete process.env.TMUX_NEXT_JIRA_DIR;
  else process.env.TMUX_NEXT_JIRA_DIR = prevJiraDir;
  if (prevItemsPath === undefined) delete process.env.TMUX_NEXT_ITEMS_PATH;
  else process.env.TMUX_NEXT_ITEMS_PATH = prevItemsPath;
  if (prevBindingsPath === undefined) delete process.env.TMUX_NEXT_BINDINGS_PATH;
  else process.env.TMUX_NEXT_BINDINGS_PATH = prevBindingsPath;
  rmSync(stateDir, { recursive: true, force: true });
});
