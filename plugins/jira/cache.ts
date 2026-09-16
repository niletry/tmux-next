import { readJiraConfig, type JiraConfig } from "./config";
import { fetchIssue, fetchIssues, type Issue, type IssuesResult } from "./client";
import { fetchDev, type DevResult } from "./dev";

/**
 * 工单插件的服务端。
 *
 * 浏览器永不直连 Jira：token 会漏，CORS 也不通。所有对外请求都从这里出去，而
 * **JQL 只来自 config.json**——接受浏览器传来的 JQL，就等于把这个无认证的服务
 * 变成一个任人查询的 Jira 代理。
 */

/** 拉一次要几秒，而列表页会被反复打开；60 秒足够挡住连点，又不至于让人觉得刷不动。 */
const CACHE_MS = 60_000;

let cache: { at: number; result: IssuesResult } | null = null;

/** `sync()` 判断游标要不要退回全量、`enrich()` 判断有没有热数据要用到这份引用。 */
export function getCache(): { at: number; result: IssuesResult } | null {
  return cache;
}

/**
 * 单个 issue 的缓存,按 key,跟 JQL 结果缓存分开存。
 *
 * JQL 结果缓存装的是"当前这条查询命中了什么",而这条查询通常长着
 * `status not IN (Done, Closed, Abandoned)` 这样的尾巴——工单一旦转到 Done
 * 就不再匹配,下一次 `issues()` 的结果里直接没有它了。`enrich()` 曾经只从这份
 * 缓存里找 issue,于是一个刚做完的单立刻从卡片上掉光所有 facet(状态、PR、
 * 检查全没了),而点「刷新」也救不回来:`refreshIssue` 单独去问了这一个 key,
 * 但只在它还在 `cache` 的列表里时才写得进去——不在,查到的结果就被扔掉。
 *
 * 单独一份缓存是解法:一次针对某个 key 的 fetch,结果该不该留下来,不该取决于
 * 这个 key 眼下在不在查询范围里。
 */
export const ISSUE_CACHE_MS = 5 * 60_000;
export const issueCache = new Map<string, { at: number; issue: Issue }>();

/**
 * Jira 实例地址，无尾斜杠——`facetsFor` 用它拼史诗 chip 的链接。只在
 * `readJiraConfig()` 成功之后才更新，未配置或读取失败时保留上一次的值
 * （启动时是空串，`facetsFor` 空串就不给链接）。
 */
let browseBase = "";

/** 记下这次读到的配置对应的浏览地址——三处成功读到 config 的调用点共用同一份逻辑。 */
export function noteConfig(config: JiraConfig): void {
  browseBase = config.url.replace(/\/+$/, "");
}

export function getBrowseBase(): string {
  return browseBase;
}

export async function issues(refresh: boolean): Promise<IssuesResult> {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache.result;
  const config = await readJiraConfig();
  if (!config) return { ok: false, reason: "unconfigured" };
  noteConfig(config);
  const result = await fetchIssues(config);
  // 只缓存成功：一次网络抖动不该让人盯着错误看满一分钟。
  if (result.ok) {
    cache = { at: Date.now(), result };
    // 顺手预热单号缓存,让它在正常流程(定时/手动全量同步)里就有内容,不是只有
    // 点过一次单条刷新的单才留得下东西。
    const at = Date.now();
    for (const issue of result.issues) issueCache.set(issue.key, { at, issue });
  }
  return result;
}

/**
 * PR 与 CI 的缓存，按 issue id。
 *
 * 比工单列表的缓存活得久，因为它贵得多：一个单一次 dev-status，每个 PR 再一次
 * Bitbucket。五十个单全量刷一遍是上百次请求，做成开页即拉会把速率限制撞穿。
 *
 * 所以默认吃缓存，刷新是显式的——而且可以只刷一个单。盯着一个 PR 等 CI 跑完的
 * 时候，你要的是这一个单的最新状态，不是把另外四十九个也重问一遍。
 */
const DEV_CACHE_MS = 5 * 60_000;

export const devCache = new Map<string, { at: number; result: DevResult }>();

/**
 * 仓库的人读名字，跨 issue 长期缓存——不像 devCache 那样五分钟过期，因为名字
 * 本身几乎不会变。这个进程活多久就缓多久，issue 之间共享同一份，是 fetchDev
 * 特意留出的那个可注入参数存在的理由：dev.ts 自己不持有这份状态。
 */
const repoNameCache = new Map<string, string>();

/** 同时在跑的 dev-status 请求数。批量刷新时不至于一次打出去五十个连接。 */
export const DEV_CONCURRENCY = 4;

export async function dev(issueId: string, issueKey: string, refresh: boolean): Promise<DevResult> {
  const hit = devCache.get(issueId);
  if (!refresh && hit && Date.now() - hit.at < DEV_CACHE_MS) return hit.result;

  const config = await readJiraConfig();
  if (!config) return { ok: false, reason: "auth" };

  const result = await fetchDev(config, issueId, issueKey, fetch, repoNameCache);
  // 只缓存成功。一次抖动不该让这个单的 PR 消失五分钟。
  if (result.ok) devCache.set(issueId, { at: Date.now(), result });
  return result;
}

/** 有并发上限的 map，跟 dev.ts 里那个同源，此处不共享是为了不把内部函数导出去。 */
export async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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
 * 重取一条工单，并把它写回列表缓存。
 *
 * 写回是要紧的一步：不写回的话，这次拿到的新状态只活在这一个响应里，页面下一次
 * 重画（或者别处触发的一次渲染）就会用回缓存里的旧值，看起来像是刷新没生效。
 */
export async function refreshIssue(key: string): Promise<Issue | null> {
  const config = await readJiraConfig();
  if (!config) return null;
  noteConfig(config);
  const got = await fetchIssue(config, key);
  if (!got.ok) return null;

  // 无条件写进单号缓存——这一步不看这个 key 在不在 JQL 结果里,理由见 issueCache
  // 上面的注释:一次刷新问到的答案,不该因为工单已经不在查询范围里就被扔掉。
  issueCache.set(key, { at: Date.now(), issue: got.issue });

  if (cache?.result.ok) {
    const list = cache.result.issues;
    const at = list.findIndex((i) => i.key === key);
    if (at >= 0) list[at] = got.issue;
    // 不在列表里的单不追加进去:`cache` 是"这条 JQL 眼下命中了什么"的真相来源,
    // /api/jira 拿它原样渲染成"当前查询结果"——塞一个查询本该排除的单进去,
    // 会让工单页显示出一条它自己的查询条件说不该出现的行。
  }
  return got.issue;
}

/**
 * 仅供测试：把 `cache`/`issueCache` 拨回"进程刚启动"时的状态。
 *
 * 拆出这个文件之前，`sync-e2e.test.ts` 靠带查询串的动态 import
 * （`import("./server" + "?tag")`）换一份全新的模块实例来保证冷缓存——那时
 * `cache` 直接声明在 server.ts 里，重新执行那份顶层代码就够了。缓存挪进这个
 * 独立文件之后，同一招不再成立：调用方（比如 `source.ts`）里 `import ... from
 * "./cache"` 是静态的相对路径，跟具体走了哪个查询串的 import 无关，解析出来
 * 永远是这一个模块实例——带查询串重新执行的是调用方自己的顶层作用域，不是这
 * 份被它 import 进去的缓存。所以需要一个显式的口子让测试真的清零它。
 */
export function __resetForTest(): void {
  cache = null;
  issueCache.clear();
}
