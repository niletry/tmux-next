import { test, expect } from "bun:test";
import { transitionIssue } from "./writeback";
import type { JiraConfig } from "./config";

const CONFIG: JiraConfig = {
  url: "https://example.atlassian.net",
  email: "dev@example.com",
  token: "secret-token",
  jql: "assignee = currentUser()",
  onlyKeyedPrs: true,
  transitions: { inProgress: "", inReview: "", inMerge: "", done: "" },
  bitbucket: { email: "dev@example.com", appPassword: "app-password" },
};

function fakeFetch(handlers: Record<string, (req: Request) => Response | Promise<Response>>) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as string, init);
    const handler = handlers[req.method + " " + new URL(req.url).pathname];
    if (!handler) throw new Error(`no fake handler for ${req.method} ${req.url}`);
    return handler(req);
  }) as unknown as typeof fetch;
}

test("transitionIssue 找到目标状态名对应的动作，执行它", async () => {
  const calls: string[] = [];
  const fetcher = fakeFetch({
    "GET /rest/api/3/issue/PROJ-1/transitions": () => {
      calls.push("list");
      return Response.json({
        transitions: [
          { id: "11", to: { name: "To Do" } },
          { id: "21", to: { name: "In Review" } },
        ],
      });
    },
    "POST /rest/api/3/issue/PROJ-1/transitions": async (req) => {
      calls.push("do:" + JSON.stringify(await req.json()));
      return new Response(null, { status: 204 });
    },
  });

  await transitionIssue(CONFIG, "PROJ-1", "in review", fetcher);
  expect(calls).toEqual(["list", 'do:{"transition":{"id":"21"}}']);
});

test("transitionIssue 目标状态名大小写不敏感", async () => {
  const fetcher = fakeFetch({
    "GET /rest/api/3/issue/PROJ-1/transitions": () =>
      Response.json({ transitions: [{ id: "21", to: { name: "in review" } }] }),
    "POST /rest/api/3/issue/PROJ-1/transitions": () => new Response(null, { status: 204 }),
  });
  await expect(transitionIssue(CONFIG, "PROJ-1", "In Review", fetcher)).resolves.toBeUndefined();
});

test("transitionIssue 找不到匹配的目标状态就什么也不做，不算失败", async () => {
  const fetcher = fakeFetch({
    "GET /rest/api/3/issue/PROJ-1/transitions": () =>
      Response.json({ transitions: [{ id: "11", to: { name: "To Do" } }] }),
  });
  await expect(transitionIssue(CONFIG, "PROJ-1", "Done", fetcher)).resolves.toBeUndefined();
});

test("transitionIssue 目标状态留空就直接不问，不发请求", async () => {
  const fetcher = (async () => {
    throw new Error("不该被调用");
  }) as unknown as typeof fetch;
  await expect(transitionIssue(CONFIG, "PROJ-1", "", fetcher)).resolves.toBeUndefined();
  await expect(transitionIssue(CONFIG, "PROJ-1", "   ", fetcher)).resolves.toBeUndefined();
});

test("transitionIssue 查询失败时抛出，调用方决定怎么处理", async () => {
  const fetcher = fakeFetch({
    "GET /rest/api/3/issue/PROJ-1/transitions": () => new Response(null, { status: 401 }),
  });
  await expect(transitionIssue(CONFIG, "PROJ-1", "Done", fetcher)).rejects.toThrow();
});
