import type { JiraConfig } from "./config";
import { adfToText } from "./adf";

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
  /** Jira 的内部数字 id。dev-status 按它查，不认 key。 */
  id: string;
  key: string;
  summary: string;
  status: string;
  statusCategory: string;
  updated: number;
  /** 类型名，原样来自实例——它是可以被改名的，所以只当标签用。 */
  type: string;
  /**
   * 父级，没有就是 null。
   *
   * 对普通工单来说父级就是它所属的史诗；对子任务来说是它挂着的那个任务。两者
   * 都来自同一个 `parent` 字段，所以这里把父级的层级一并带上，让显示端自己决定
   * 要不要叫它「史诗」——把子任务的父任务标成史诗是错的。
   */
  parent: { key: string; summary: string; hierarchy: number } | null;
  /**
   * 层级：史诗 1、普通 0、子任务 -1。
   *
   * 判断层级用它而不是用类型名：名字每个实例都能改，层级不能。名字只负责显示。
   */
  hierarchy: number;
  /** 负责人的展示名，未分配是 null——不是空字符串，也不是 "Unassigned"。 */
  assignee: string | null;
};

export type IssuesResult =
  | { ok: true; issues: Issue[] }
  | { ok: false; reason: "unconfigured" | "auth" | "query" | "unreachable" };

/** Jira 挂了不能把页面吊死。 */
const TIMEOUT_MS = 8000;

const FIELDS = "summary,status,updated,issuetype,parent,assignee";

/**
 * 一行搜索结果 → 一个 Issue，认不出就是 null。
 *
 * 抽出来是因为现在有两条路进来：列表用搜索接口，单条刷新用 `/issue/{key}`。两处
 * 各写一份解析，迟早会在某个字段上飘——而飘的那一刻没有任何测试会红，只是某个卡片
 * 少了个史诗。
 */
export function toIssue(row: unknown): Issue | null {
  const r = row as { id?: unknown; key?: unknown; fields?: Record<string, any> };
  // key 缺了就没法绑定也没法跳转，渲染出来只会是一行空白。
  if (typeof r?.key !== "string" || !r.key) return null;
  const f = r.fields ?? {};

  // hierarchyLevel 是较新的字段；老实例只给 subtask 布尔，所以两条都认，
  // 都没有就当普通层级——一个认不出的类型该显示成普通工单，不该消失。
  const t = f.issuetype ?? {};
  const hierarchy =
    typeof t.hierarchyLevel === "number" ? t.hierarchyLevel : t.subtask === true ? -1 : 0;

  // 父级用的是新式的 `parent` 字段，不是老的 Epic Link 自定义字段：这个实例里
  // 两者都还在，但 parent 是现在填得准的那个，而自定义字段的编号每个实例都不同。
  const pRaw = f.parent;
  const pFields = pRaw?.fields ?? {};
  const pType = pFields.issuetype ?? {};
  const parent =
    pRaw && typeof pRaw.key === "string" && pRaw.key
      ? {
          key: pRaw.key,
          summary: typeof pFields.summary === "string" ? pFields.summary : "",
          hierarchy:
            typeof pType.hierarchyLevel === "number"
              ? pType.hierarchyLevel
              : pType.subtask === true
                ? -1
                : 0,
        }
      : null;

  return {
    id: typeof r.id === "string" ? r.id : "",
    key: r.key,
    summary: typeof f.summary === "string" ? f.summary : "",
    status: typeof f.status?.name === "string" ? f.status.name : "",
    statusCategory:
      typeof f.status?.statusCategory?.key === "string" ? f.status.statusCategory.key : "",
    updated: Date.parse(typeof f.updated === "string" ? f.updated : "") || 0,
    type: typeof t.name === "string" ? t.name : "",
    hierarchy,
    parent,
    // 未分配时 Jira 给的是 null（不是缺字段），displayName 缺了同样当未分配——
    // "没有负责人"和"负责人是空字符串"不是一回事，别把后者渲染出来。
    assignee: typeof f.assignee?.displayName === "string" ? f.assignee.displayName : null,
  };
}

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
    const issue = toIssue(row);
    if (issue) issues.push(issue);
  }
  return { ok: true, issues };
}

/**
 * 单条工单的最新样子。
 *
 * 走 `/rest/api/3/issue/{key}` 而不是拼一句 `key = X` 的 JQL：这里完全不需要查询
 * 语言，而"服务端拼 JQL"这个动作一旦存在，下一个人就会想把它参数化——JQL 只来自
 * 配置这条边界，最好连拼的能力都不给。
 *
 * key 由调用方从自己缓存的工单列表里取，不从请求里收。
 */
export async function fetchIssue(
  config: JiraConfig,
  key: string,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true; issue: Issue } | { ok: false; reason: "auth" | "query" | "unreachable" }> {
  const auth = "Basic " + btoa(`${config.email}:${config.token}`);
  let res: Response;
  try {
    res = await fetcher(`${config.url}/rest/api/3/issue/${encodeURIComponent(key)}?fields=${FIELDS}`, {
      headers: { authorization: auth, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: "auth" };
  if (res.status >= 500) return { ok: false, reason: "unreachable" };
  if (!res.ok) return { ok: false, reason: "query" };

  try {
    const issue = toIssue(await res.json());
    return issue ? { ok: true, issue } : { ok: false, reason: "query" };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

/**
 * 一个单的描述正文，纯文本。拿不到就是 null。
 *
 * 单独一发、单独一个 fields 参数，**不把 description 并进共享的 FIELDS**：那个常量是
 * 工单列表用的，一次拉五十条，把正文并进去等于让每次开首页都多下载几十 KB 富文本，
 * 而列表一个字都不显示它。
 */
export async function fetchIssueDescription(
  config: JiraConfig,
  key: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const auth = "Basic " + btoa(`${config.email}:${config.token}`);
  let res: Response;
  try {
    res = await fetcher(
      `${config.url}/rest/api/3/issue/${encodeURIComponent(key)}?fields=description`,
      {
        headers: { authorization: auth, accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const body = (await res.json()) as { fields?: { description?: unknown } };
    const text = adfToText(body?.fields?.description);
    return text || null;
  } catch {
    return null;
  }
}
