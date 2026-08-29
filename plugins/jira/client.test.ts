import { test, expect } from "bun:test";
import { fetchIssues } from "./client";
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
      key: "EXAMPLE-1",
      fields: {
        summary: "登录页在窄屏下换行",
        updated: "2026-08-30T10:00:00.000+0000",
        status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
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
        key: "EXAMPLE-1",
        summary: "登录页在窄屏下换行",
        status: "In Progress",
        statusCategory: "indeterminate",
        updated: Date.parse("2026-08-30T10:00:00.000+0000"),
      },
    ],
  });
});

test("认证走 Basic，JQL 来自配置", async () => {
  let seen: Request | undefined;
  await fetchIssues(CONFIG, fakeFetch(200, OK_BODY, (r) => (seen = r)));
  expect(seen?.url).toStartWith("https://example.atlassian.net/rest/api/3/search");
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
