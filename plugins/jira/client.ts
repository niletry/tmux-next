import type { JiraConfig } from "./config";

/**
 * Jira Cloud 的搜索接口，裁到渲染要用的那几个字段。
 *
 * fetcher 是参数而不是直接用全局 fetch，好让整套测试一次真实请求都不发——这个
 * 仓库的测试跑得很勤，对着别人的 Jira 打是不可接受的。
 *
 * 失败一律归类再返回。Jira 的错误体里带账号信息，原样透传给浏览器就是把它送出
 * 门；而对调用方来说，"凭据不对"和"查询写错了"是两种完全不同的补救动作，比一段
 * 原始英文有用得多。
 */

export type Issue = {
  key: string;
  summary: string;
  status: string;
  statusCategory: string;
  updated: number;
};

export type IssuesResult =
  | { ok: true; issues: Issue[] }
  | { ok: false; reason: "unconfigured" | "auth" | "query" | "unreachable" };

/** Jira 挂了不能把页面吊死。 */
const TIMEOUT_MS = 8000;

const FIELDS = "summary,status,updated";

export async function fetchIssues(
  config: JiraConfig,
  fetcher: typeof fetch = fetch,
): Promise<IssuesResult> {
  // JQL 只来自配置，永不来自请求：否则这个无认证服务就是个任人查询的 Jira 代理。
  // URLSearchParams 把空格编成 "+"（application/x-www-form-urlencoded），但查询串
  // 里更规范的写法是 %20——换成 %20 才能被当普通 URI 编码正确解出空格。
  const query = new URLSearchParams({ jql: config.jql, fields: FIELDS, maxResults: "50" })
    .toString()
    .replace(/\+/g, "%20");
  const auth = "Basic " + btoa(`${config.email}:${config.token}`);

  let res: Response;
  try {
    res = await fetcher(`${config.url}/rest/api/3/search/jql?${query}`, {
      headers: { authorization: auth, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // 超时、DNS、连接被拒——对用户都是同一件事：现在拿不到。
    return { ok: false, reason: "unreachable" };
  }

  if (res.status === 401 || res.status === 403) return { ok: false, reason: "auth" };
  if (res.status >= 500) return { ok: false, reason: "unreachable" };
  if (!res.ok) return { ok: false, reason: "query" };

  let data: { issues?: unknown };
  try {
    data = (await res.json()) as { issues?: unknown };
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  const rows = Array.isArray(data?.issues) ? data.issues : [];
  const issues: Issue[] = [];
  for (const row of rows) {
    const r = row as { key?: unknown; fields?: Record<string, any> };
    // key 缺了就没法绑定也没法跳转，渲染出来只会是一行空白。
    if (typeof r?.key !== "string" || !r.key) continue;
    const f = r.fields ?? {};
    issues.push({
      key: r.key,
      summary: typeof f.summary === "string" ? f.summary : "",
      status: typeof f.status?.name === "string" ? f.status.name : "",
      statusCategory:
        typeof f.status?.statusCategory?.key === "string" ? f.status.statusCategory.key : "",
      updated: Date.parse(typeof f.updated === "string" ? f.updated : "") || 0,
    });
  }
  return { ok: true, issues };
}
