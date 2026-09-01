import { test, expect } from "bun:test";
import { fetchIssue, fetchIssues } from "./client";
import type { JiraConfig } from "./config";

/**
 * Jira 客户端。一次真实请求都不发——fetcher 是注进来的。
 *
 * 这里最要紧的两条不是"能解析成功响应"，而是：401 不能被当成"没有单"，以及
 * Jira 的原始错误体不能被原样吐给浏览器（里面带账号信息）。
 */

const CONFIG: JiraConfig = {
  url: "https://example.atlassian.net",
  email: "dev@example.com",
  token: "secret-token",
  jql: "assignee = currentUser()",
  onlyKeyedPrs: true,
};

function fakeFetch(status: number, body: unknown, capture?: (req: Request) => void) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    capture?.(new Request(input as string, init));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

const OK_BODY = {
  issues: [
    {
      id: "10001",
      key: "EXAMPLE-1",
      fields: {
        summary: "登录页在窄屏下换行",
        updated: "2026-08-30T10:00:00.000+0000",
        status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
        issuetype: { name: "Bug", hierarchyLevel: 0 },
        parent: {
          key: "EXAMPLE-100",
          fields: { summary: "登录体验", issuetype: { name: "Epic", hierarchyLevel: 1 } },
        },
      },
    },
  ],
};

test("成功时把响应裁成渲染要用的形状", async () => {
  const res = await fetchIssues(CONFIG, fakeFetch(200, OK_BODY));
  expect(res).toEqual({
    ok: true,
    issues: [
      {
        id: "10001",
        key: "EXAMPLE-1",
        summary: "登录页在窄屏下换行",
        status: "In Progress",
        statusCategory: "indeterminate",
        updated: Date.parse("2026-08-30T10:00:00.000+0000"),
        type: "Bug",
        hierarchy: 0,
        parent: { key: "EXAMPLE-100", summary: "登录体验", hierarchy: 1 },
      },
    ],
  });
});

test("认证走 Basic，JQL 来自配置", async () => {
  let seen: Request | undefined;
  await fetchIssues(CONFIG, fakeFetch(200, OK_BODY, (r) => (seen = r)));
  // /rest/api/3/search 停在 2024 年,2025-05-01 被 Jira Cloud 彻底摘掉;这里认
  // 定新路径 /search/jql,不能只认前缀,不然改回旧路径这条断言也不会报错。
  expect(seen?.url).toStartWith("https://example.atlassian.net/rest/api/3/search/jql?");
  expect(seen?.headers.get("authorization")).toBe(
    "Basic " + btoa("dev@example.com:secret-token"),
  );
  expect(decodeURIComponent(seen?.url ?? "")).toContain("assignee = currentUser()");
});

test("401 和 403 报凭据无效，不是空列表", async () => {
  // 把认证失败显示成"你没有单"，会让人以为 Jira 上真的没单了。
  for (const status of [401, 403]) {
    const res = await fetchIssues(CONFIG, fakeFetch(status, { errorMessages: ["x"] }));
    expect({ status, res }).toEqual({ status, res: { ok: false, reason: "auth" } });
  }
});

test("其余 4xx 报查询有误", async () => {
  const res = await fetchIssues(CONFIG, fakeFetch(400, { errorMessages: ["bad jql"] }));
  expect(res).toEqual({ ok: false, reason: "query" });
});

test("5xx 与网络故障报连不上", async () => {
  expect(await fetchIssues(CONFIG, fakeFetch(503, "gateway"))).toEqual({
    ok: false,
    reason: "unreachable",
  });
  const throwing = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  expect(await fetchIssues(CONFIG, throwing)).toEqual({ ok: false, reason: "unreachable" });
});

test("畸形 JSON 不炸，报连不上", async () => {
  expect(await fetchIssues(CONFIG, fakeFetch(200, "{ not json"))).toEqual({
    ok: false,
    reason: "unreachable",
  });
});

test("缺字段的 issue 被跳过，而不是渲染出一行空白", async () => {
  const res = await fetchIssues(
    CONFIG,
    fakeFetch(200, { issues: [{ fields: { summary: "无 key" } }, OK_BODY.issues[0]] }),
  );
  expect(res.ok && res.issues.map((i) => i.key)).toEqual(["EXAMPLE-1"]);
});

test("失败结果里不含 Jira 的原始错误体", async () => {
  // 那里面会带账号信息，不能原样进浏览器。
  const res = await fetchIssues(
    CONFIG,
    fakeFetch(400, { errorMessages: ["account dev@example.com lacks permission"] }),
  );
  expect(JSON.stringify(res)).not.toContain("lacks permission");
  expect(JSON.stringify(res)).not.toContain("@example.com");
});

test("层级优先用 hierarchyLevel，认得出史诗和子任务", async () => {
  const body = {
    issues: [
      { key: "EXAMPLE-9", fields: { issuetype: { name: "Epic", hierarchyLevel: 1 } } },
      { key: "EXAMPLE-8", fields: { issuetype: { name: "Sub-task", hierarchyLevel: -1 } } },
    ],
  };
  const res = await fetchIssues(CONFIG, fakeFetch(200, body));
  expect(res.ok && res.issues.map((i) => [i.type, i.hierarchy])).toEqual([
    ["Epic", 1],
    ["Sub-task", -1],
  ]);
});

test("老实例没有 hierarchyLevel 时退回 subtask 布尔", async () => {
  // 层级判断不能只认新字段，否则老实例上每个子任务都会被当成普通工单。
  const body = { issues: [{ key: "EXAMPLE-7", fields: { issuetype: { name: "子任务", subtask: true } } }] };
  const res = await fetchIssues(CONFIG, fakeFetch(200, body));
  expect(res.ok && res.issues[0]).toMatchObject({ type: "子任务", hierarchy: -1 });
});

test("完全没有 issuetype 时当普通工单，而不是丢掉这条", async () => {
  // 认不出的类型该显示成普通工单，不该从列表里消失。
  const body = { issues: [{ key: "EXAMPLE-6", fields: { summary: "没有类型" } }] };
  const res = await fetchIssues(CONFIG, fakeFetch(200, body));
  expect(res.ok && res.issues[0]).toMatchObject({ key: "EXAMPLE-6", type: "", hierarchy: 0 });
});

test("没有父级时 parent 是 null，不是半个对象", async () => {
  const body = { issues: [{ id: "1", key: "EXAMPLE-5", fields: { summary: "独立的单" } }] };
  const res = await fetchIssues(CONFIG, fakeFetch(200, body));
  expect(res.ok && res.issues[0]!.parent).toBeNull();
});

test("子任务的父级是任务，层级如实带出来——它不是史诗", async () => {
  // 同一个 parent 字段既装史诗也装父任务，把两者都标成史诗是错的，所以层级要
  // 一路带到显示端由它决定叫什么。
  const body = {
    issues: [
      {
        id: "2",
        key: "EXAMPLE-6",
        fields: {
          issuetype: { name: "Sub-task", hierarchyLevel: -1 },
          parent: { key: "EXAMPLE-5", fields: { summary: "父任务", issuetype: { name: "Task", hierarchyLevel: 0 } } },
        },
      },
    ],
  };
  const res = await fetchIssues(CONFIG, fakeFetch(200, body));
  expect(res.ok && res.issues[0]!.parent).toEqual({ key: "EXAMPLE-5", summary: "父任务", hierarchy: 0 });
});

test("请求里带上 parent 字段，否则父级永远是空的", async () => {
  let seen: Request | undefined;
  await fetchIssues(CONFIG, fakeFetch(200, OK_BODY, (r) => (seen = r)));
  expect(decodeURIComponent(seen?.url ?? "")).toContain("parent");
});

// ---- 单条工单 ---------------------------------------------------------------

test("单条刷新走 /issue/{key}，不拼 JQL", async () => {
  // 这里完全不需要查询语言；而"服务端拼 JQL"这个动作一旦存在，下一个人就会想把它
  // 参数化——JQL 只来自配置这条边界，最好连拼的能力都不给。
  let seen: Request | undefined;
  await fetchIssue(CONFIG, "EXAMPLE-1", fakeFetch(200, { key: "EXAMPLE-1", fields: {} }, (r) => (seen = r)));
  expect(seen?.url).toContain("/rest/api/3/issue/EXAMPLE-1");
  expect(seen?.url).not.toContain("jql");
});

test("单条与列表用同一套解析——两处各写一份必然会飘", async () => {
  const raw = {
    id: "10001",
    key: "EXAMPLE-1",
    fields: {
      summary: "登录页在窄屏下换行",
      updated: "2026-08-30T10:00:00.000+0000",
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      issuetype: { name: "Bug", hierarchyLevel: 0 },
      parent: { key: "EXAMPLE-100", fields: { summary: "登录体验", issuetype: { hierarchyLevel: 1 } } },
    },
  };
  const one = await fetchIssue(CONFIG, "EXAMPLE-1", fakeFetch(200, raw));
  const many = await fetchIssues(CONFIG, fakeFetch(200, { issues: [raw] }));
  expect(one.ok).toBe(true);
  expect(many.ok).toBe(true);
  if (!one.ok || !many.ok) return;
  expect(one.issue).toEqual(many.issues[0]!);
});

test("单条：404 报查询有误，401 报凭据无效", async () => {
  expect(await fetchIssue(CONFIG, "EXAMPLE-9", fakeFetch(404, {}))).toEqual({ ok: false, reason: "query" });
  expect(await fetchIssue(CONFIG, "EXAMPLE-9", fakeFetch(401, {}))).toEqual({ ok: false, reason: "auth" });
});
