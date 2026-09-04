import { test, expect } from "bun:test";
import { fetchDev, parsePrUrl, mentionsKey } from "./dev";
import type { JiraConfig } from "./config";

/**
 * PR 与 CI 那两跳。一次真实请求都不发——两个 fetcher 都是注进来的。
 *
 * 这里最要紧的不是"能解析成功响应"，而是两条降级：Bitbucket 那一跳挂了不能把 PR
 * 列表一起拖没，以及"没有检查"和"没问到检查"必须是两种可区分的结果。
 */

const CONFIG: JiraConfig = {
  url: "https://example.atlassian.net",
  email: "dev@example.com",
  token: "secret-token",
  jql: "assignee = currentUser()",
  onlyKeyedPrs: false,
  bitbucket: { email: "dev@example.com", appPassword: "app-password" },
  transitions: { inProgress: "", inReview: "", inMerge: "", done: "" },
};

const PR_URL = "https://bitbucket.org/{ws-uuid}/{repo-uuid}/pull-requests/371";

const DEV_BODY = {
  detail: [
    {
      pullRequests: [
        {
          id: "#371",
          name: "[EXAMPLE-1] 修登录页",
          status: "MERGED",
          url: PR_URL,
          lastUpdate: "2026-08-28T01:31:13.834+0000",
          source: { branch: "EXAMPLE-1-fix" },
          destination: { branch: "main" },
        },
      ],
    },
  ],
};

const STATUS_BODY = {
  values: [
    { key: "ci/circleci: build", name: "ci/circleci: build", state: "SUCCESSFUL", url: "https://example.org/b" },
    { key: "ci/circleci: test", name: "ci/circleci: test", state: "FAILED", url: "https://example.org/t" },
  ],
};

/** 按 URL 分派的假 fetcher：Jira 一份、Bitbucket 一份。 */
function routed(opts: {
  dev?: [number, unknown];
  status?: [number, unknown];
  seen?: string[];
}) {
  return (async (input: RequestInfo | URL) => {
    const href = String(input);
    opts.seen?.push(href);
    const pick = href.includes("api.bitbucket.org") ? opts.status : opts.dev;
    if (!pick) throw new Error("network down");
    const [status, body] = pick;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

test("PR 地址解析出 workspace / repo / 编号，大括号有无都认", () => {
  expect(parsePrUrl(PR_URL)).toEqual({ workspace: "ws-uuid", repo: "repo-uuid", id: "371" });
  expect(parsePrUrl("https://bitbucket.org/ws/repo/pull-requests/8")).toEqual({
    workspace: "ws",
    repo: "repo",
    id: "8",
  });
});

test("workspace 段为空的地址拼不出 API，返回 null 而不是坏 URL", () => {
  // 实测存在这种：https://bitbucket.org/{}/{uuid}/pull-requests/654
  expect(parsePrUrl("https://bitbucket.org/{}/{repo-uuid}/pull-requests/654")).toBeNull();
  expect(parsePrUrl("https://example.org/not-a-pr")).toBeNull();
});

test("两跳都通时，PR 带着它的检查回来", async () => {
  const res = await fetchDev(CONFIG, "10001", "EXAMPLE-1", routed({ dev: [200, DEV_BODY], status: [200, STATUS_BODY] }));
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.prs).toHaveLength(1);
  const pr = res.prs[0]!;
  expect(pr.id).toBe("371"); // 前面那个 # 被去掉
  expect(pr.status).toBe("MERGED");
  expect(pr.branch).toBe("EXAMPLE-1-fix");
  expect(pr.destinationBranch).toBe("main");
  expect(pr.repo).toBe("repo-uuid"); // 从 PR 地址解出来，不是另一次请求换来的
  expect(pr.checksKnown).toBe(true);
  expect(pr.checks.map((c) => [c.name, c.state])).toEqual([
    ["ci/circleci: build", "SUCCESSFUL"],
    ["ci/circleci: test", "FAILED"],
  ]);
});

test("dev-status 按 issue id 查，不是按 key", async () => {
  const seen: string[] = [];
  await fetchDev(CONFIG, "10001", "EXAMPLE-1", routed({ dev: [200, DEV_BODY], status: [200, STATUS_BODY], seen }));
  expect(seen[0]).toContain("issueId=10001");
  expect(seen[0]).toContain("applicationType=bitbucket");
});

test("Bitbucket 那一跳挂了，PR 仍然回来，只是检查标成没问到", async () => {
  // CI 是附加项。为了拿不到它就把用户真正要的 PR 列表整个丢掉，是拿本体赌附加。
  const res = await fetchDev(CONFIG, "10001", "EXAMPLE-1", routed({ dev: [200, DEV_BODY], status: [500, "boom"] }));
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.prs[0]!.checksKnown).toBe(false);
  expect(res.prs[0]!.checks).toEqual([]);
});

test("没配 Bitbucket 时不去问，检查同样标成没问到", async () => {
  const seen: string[] = [];
  const { bitbucket, ...noBb } = CONFIG;
  const res = await fetchDev(noBb as JiraConfig, "10001", "EXAMPLE-1", routed({ dev: [200, DEV_BODY], seen }));
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.prs[0]!.checksKnown).toBe(false);
  expect(seen.some((u) => u.includes("api.bitbucket.org"))).toBe(false);
});

test("「没有检查」与「没问到检查」是两种结果", async () => {
  // 空数组配 checksKnown=true 才是"这个 PR 确实没有检查"；把两者显示成一样会骗人。
  const res = await fetchDev(CONFIG, "10001", "EXAMPLE-1", routed({ dev: [200, DEV_BODY], status: [200, { values: [] }] }));
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.prs[0]!.checks).toEqual([]);
  expect(res.prs[0]!.checksKnown).toBe(true);
});

test("没有 PR 是正常答案，不是错误", async () => {
  const res = await fetchDev(CONFIG, "10001", "EXAMPLE-1", routed({ dev: [200, { detail: [{ pullRequests: [] }] }] }));
  expect(res).toEqual({ ok: true, prs: [], hidden: 0 });
});

test("缺编号或地址的 PR 被跳过，而不是渲染成一行噪音", async () => {
  const body = { detail: [{ pullRequests: [{ name: "没有 id" }, DEV_BODY.detail[0]!.pullRequests[0]] }] };
  const res = await fetchDev(CONFIG, "10001", "EXAMPLE-1", routed({ dev: [200, body], status: [200, STATUS_BODY] }));
  expect(res.ok && res.prs.map((p) => p.id)).toEqual(["371"]);
});

test("Jira 那一跳的 401 报凭据无效", async () => {
  expect(await fetchDev(CONFIG, "10001", "EXAMPLE-1", routed({ dev: [401, { errorMessages: ["x"] }] }))).toEqual({
    ok: false,
    reason: "auth",
  });
});

test("失败结果里不含上游的原始错误体", async () => {
  const res = await fetchDev(
    CONFIG,
    "10001",
    "EXAMPLE-1",
    routed({ dev: [400, { errorMessages: ["account dev@example.com lacks permission"] }] }),
  );
  expect(JSON.stringify(res)).not.toContain("lacks permission");
  expect(JSON.stringify(res)).not.toContain("@example.com");
});


// ---- 单号过滤 ----------------------------------------------------------------

/**
 * dev-status 的关联很松：提交信息里提过别的单号，那个 PR 就会挂到这个单下面。
 * 实测三个单里两个挂着别人的 PR，所以有了这个开关。
 */
const STRICT: JiraConfig = { ...CONFIG, onlyKeyedPrs: true };

function twoPrs() {
  return {
    detail: [
      {
        pullRequests: [
          {
            id: "#1",
            name: "[EXAMPLE-1] 本单的",
            status: "OPEN",
            url: "https://bitbucket.org/{ws}/{repo}/pull-requests/1",
            source: { branch: "EXAMPLE-1-fix" },
          },
          {
            id: "#2",
            name: "[EXAMPLE-9] 别的单的",
            status: "MERGED",
            url: "https://bitbucket.org/{ws}/{repo}/pull-requests/2",
            source: { branch: "EXAMPLE-9-other" },
          },
        ],
      },
    ],
  };
}

test("开启后只留下分支或标题带本单单号的 PR，并报出滤掉几条", async () => {
  const res = await fetchDev(STRICT, "10001", "EXAMPLE-1", routed({ dev: [200, twoPrs()], status: [200, { values: [] }] }));
  expect(res.ok && res.prs.map((p) => p.id)).toEqual(["1"]);
  // 数量要报出来：过滤是为了修"显示了不属于这个单的 PR"，它自己再悄悄藏东西就
  // 只是把一种不准换成了另一种。
  expect(res.ok && res.hidden).toBe(1);
});

test("关闭时两条都在，hidden 为 0", async () => {
  const res = await fetchDev(CONFIG, "10001", "EXAMPLE-1", routed({ dev: [200, twoPrs()], status: [200, { values: [] }] }));
  expect(res.ok && res.prs.map((p) => p.id)).toEqual(["1", "2"]);
  expect(res.ok && res.hidden).toBe(0);
});

test("单号只写在标题里也留下——有人不在分支名里写", async () => {
  const body = {
    detail: [
      {
        pullRequests: [
          {
            id: "#3",
            name: "[EXAMPLE-1] 分支名没带单号",
            status: "OPEN",
            url: "https://bitbucket.org/{ws}/{repo}/pull-requests/3",
            source: { branch: "hotfix-login" },
          },
        ],
      },
    ],
  };
  const res = await fetchDev(STRICT, "10001", "EXAMPLE-1", routed({ dev: [200, body], status: [200, { values: [] }] }));
  expect(res.ok && res.prs.map((p) => p.id)).toEqual(["3"]);
});

test("没有单号可比时不过滤——那种情况下过滤等于全删", async () => {
  const res = await fetchDev(STRICT, "10001", "", routed({ dev: [200, twoPrs()], status: [200, { values: [] }] }));
  expect(res.ok && res.prs).toHaveLength(2);
});

test("单号匹配带词边界，相邻编号不会互相认领", () => {
  // EXAMPLE-45 与 EXAMPLE-451 是最容易撞的那种形状。
  expect(mentionsKey("EXAMPLE-451-fix", "EXAMPLE-45")).toBe(false);
  expect(mentionsKey("EXAMPLE-45-fix", "EXAMPLE-45")).toBe(true);
  expect(mentionsKey("feature/example-45", "EXAMPLE-45")).toBe(true); // 分支名常写小写
  expect(mentionsKey("EXAMPLE-45", "EXAMPLE-45")).toBe(true);
  expect(mentionsKey("", "EXAMPLE-45")).toBe(false);
});
