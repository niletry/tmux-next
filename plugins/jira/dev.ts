import type { JiraConfig } from "./config";

/**
 * 一个工单关联的 PR，以及每个 PR 上挂着的 CI 检查。
 *
 * 两跳，两个来源：
 *
 * - PR 来自 Jira 的 dev-status。它是 Jira 自己的开发面板背后那个接口，用的是我们
 *   已经有的那把 token —— 不需要第二套凭据就能知道一个单有哪些 PR。
 * - CI 不在 Jira 里。实测这个实例 `build.overall.count` 恒为 0：CircleCI 没往 Jira
 *   回报构建。但它以 commit status 的形式挂在 Bitbucket 的 PR 上，所以第二跳去问
 *   Bitbucket，拿到的正是 `ci/circleci: build` 这些。
 *
 * 第二跳走 Bitbucket 而不是 CircleCI，是因为它**按 PR 查、与哪个 CI 无关**：同一个
 * 接口同时给出 CircleCI 和 Codacy 的结果，换仓库、换 CI 都不用改这里。CircleCI 的
 * 凭据只带一个项目 slug，别的仓库的 PR 就问不到了。
 */

export type Check = {
  /** 检查名，原样显示，例如 `ci/circleci: test`。 */
  name: string;
  /** Bitbucket 的原始状态：SUCCESSFUL / FAILED / INPROGRESS / STOPPED。 */
  state: string;
  url: string;
};

export type PullRequest = {
  id: string;
  title: string;
  /** OPEN / MERGED / DECLINED，原样来自 Jira。 */
  status: string;
  url: string;
  branch: string;
  updated: number;
  checks: Check[];
  /**
   * CI 到底问到没有。
   *
   * 空的 checks 有两种含义——「这个 PR 没有任何检查」和「我们没能去问」——把它们
   * 显示成同一种东西会骗人：前者是事实，后者是我们的失败。
   */
  checksKnown: boolean;
};

export type DevResult =
  | { ok: true; prs: PullRequest[] }
  | { ok: false; reason: "auth" | "unreachable" };

const TIMEOUT_MS = 8000;

/** 同时问 Bitbucket 的上限。一个单十几个 PR 时不至于一次打出去十几个连接。 */
const CI_CONCURRENCY = 4;

/**
 * 从 PR 的网页地址里取出 workspace / repo / PR 号。
 *
 * 形如 `https://bitbucket.org/{uuid}/{uuid}/pull-requests/371`，大括号可有可无。
 * 实测有的 PR 的 workspace 段是空的（`https://bitbucket.org/{}/{uuid}/…`）——那种
 * 拼不出可用的 API 地址，返回 null 让调用方跳过 CI，而不是拿个坏 URL 去打。
 */
export function parsePrUrl(
  url: string,
): { workspace: string; repo: string; id: string } | null {
  const m = /^https:\/\/bitbucket\.org\/\{?([^/{}]*)\}?\/\{?([^/{}]*)\}?\/pull-requests\/(\d+)/.exec(url);
  if (!m) return null;
  const [, workspace, repo, id] = m;
  if (!workspace || !repo || !id) return null;
  return { workspace, repo, id };
}

function basic(user: string, secret: string): string {
  return "Basic " + btoa(`${user}:${secret}`);
}

async function json(
  fetcher: typeof fetch,
  url: string,
  auth: string,
): Promise<{ ok: true; data: any } | { ok: false; reason: "auth" | "unreachable" }> {
  let res: Response;
  try {
    res = await fetcher(url, {
      headers: { authorization: auth, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: "auth" };
  if (!res.ok) return { ok: false, reason: "unreachable" };
  try {
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

/** 一个 PR 上的 CI 检查。Bitbucket 没配、或者这一跳失败，都返回 null（＝没问到）。 */
async function checksFor(
  config: JiraConfig,
  prUrl: string,
  fetcher: typeof fetch,
): Promise<Check[] | null> {
  const bb = config.bitbucket;
  if (!bb) return null;
  const parts = parsePrUrl(prUrl);
  if (!parts) return null;

  const api =
    `https://api.bitbucket.org/2.0/repositories/%7B${parts.workspace}%7D/%7B${parts.repo}%7D` +
    `/pullrequests/${parts.id}/statuses`;
  const got = await json(fetcher, api, basic(bb.email, bb.appPassword));
  if (!got.ok) return null;

  const values = Array.isArray(got.data?.values) ? got.data.values : [];
  return values
    .map((v: any) => ({
      name: typeof v?.name === "string" && v.name ? v.name : typeof v?.key === "string" ? v.key : "",
      state: typeof v?.state === "string" ? v.state : "",
      url: typeof v?.url === "string" ? v.url : "",
    }))
    .filter((c: Check) => c.name);
}

/** 有并发上限的 map：一个单挂十几个 PR 时不把连接一次全开出去。 */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 一个工单的 PR 与它们的 CI。
 *
 * dev-status 按 **issue id** 查，不认 key —— 所以调用方必须把搜索结果里的 id 带过来。
 *
 * CI 那一跳的失败不会让整个结果失败：PR 列表本身是有价值的，为了拿不到构建状态就把
 * 它整个丢掉，是拿用户要的东西去赌一个附加项。
 */
export async function fetchDev(
  config: JiraConfig,
  issueId: string,
  fetcher: typeof fetch = fetch,
): Promise<DevResult> {
  const url =
    `${config.url}/rest/dev-status/latest/issue/detail` +
    `?issueId=${encodeURIComponent(issueId)}&applicationType=bitbucket&dataType=pullrequest`;

  const got = await json(fetcher, url, basic(config.email, config.token));
  if (!got.ok) return { ok: false, reason: got.reason };

  const detail = Array.isArray(got.data?.detail) ? got.data.detail : [];
  const raw: any[] = detail.flatMap((d: any) => (Array.isArray(d?.pullRequests) ? d.pullRequests : []));

  const prs = await mapLimited(raw, CI_CONCURRENCY, async (pr): Promise<PullRequest | null> => {
    const prUrl = typeof pr?.url === "string" ? pr.url : "";
    const id = typeof pr?.id === "string" ? pr.id.replace(/^#/, "") : "";
    // 没有编号或地址的 PR 点不开也认不出，渲染出来只是一行噪音。
    if (!id || !prUrl) return null;

    const checks = await checksFor(config, prUrl, fetcher);
    return {
      id,
      title: typeof pr?.name === "string" ? pr.name : "",
      status: typeof pr?.status === "string" ? pr.status : "",
      url: prUrl,
      branch: typeof pr?.source?.branch === "string" ? pr.source.branch : "",
      updated: Date.parse(typeof pr?.lastUpdate === "string" ? pr.lastUpdate : "") || 0,
      checks: checks ?? [],
      checksKnown: checks !== null,
    };
  });

  return { ok: true, prs: prs.filter((p): p is PullRequest => p !== null) };
}
