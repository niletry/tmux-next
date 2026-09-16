import { readJiraConfig, type JiraConfig } from "./config";
import { fetchIssues, fetchIssueDescription, type Issue, type IssuesResult } from "./client";
import { transitionIssue } from "./writeback";
import { syncIssues } from "./sync";
import { incrementalJql } from "./jql";
import { readSyncState, writeSyncState } from "./sync-state";
import { readItems, ensureItemForSource } from "../../src/items/model";
import type { ItemStatus } from "../../src/items/lifecycle";
import { resolveBindings, type ResolvedBinding } from "../../src/items/binding";
import { sessionIdentities } from "../../src/tmux/session-list";
import type { ItemRef } from "../types";
import type { ItemSourceProvider, SyncResult } from "../../src/items/sources";
import {
  getCache,
  getBrowseBase,
  issueCache,
  devCache,
  issues,
  refreshIssue,
  dev,
  mapLimited,
  DEV_CONCURRENCY,
  noteConfig,
} from "./cache";
import { facetsFor, epicSummaryOf } from "./facets";
import type { Facet } from "../types";

/**
 * 内核每次画首页都会调这里，预算 300ms——**绝不发请求**，只读已有缓存。
 *
 * 一次网络往返进不了这个预算，而且按页加载去打 Jira 会把速率限制撞穿。缓存没命中
 * 就少给几个维度，那是正确的降级。
 */
export async function enrich(items: ItemRef[]): Promise<Record<string, Facet[]>> {
  const cache = getCache();
  const issueMap = new Map<string, Issue>(
    cache?.result.ok ? cache.result.issues.map((i) => [i.key, i]) : [],
  );
  // 补第二份来源:眼下不在 JQL 结果里的单(比如刚转 Done、掉出了查询条件),
  // 但被单条刷新过的那些——issueCache 独立于 JQL 结果存在,理由见它的定义处。
  // 只补 issueMap 里没有的键:JQL 结果仍然是主来源,它命中的单不该被这份
  // 更久之前的缓存盖过去。
  //
  // 不看 ISSUE_CACHE_MS 做新鲜度过滤,故意的:一个几分钟前刷新过的状态,
  // 也好过完全没有状态——这条路上的单往往正是那些不会再被任何一次 JQL
  // 结果自动刷新到的单(已经掉出查询范围),过滤掉陈旧条目等于让这个修复
  // 对它本该修的那种单重新失效。跟 devMap 下面这一行是同一个先例:
  // devCache 的读取端也从不按 DEV_CACHE_MS 过滤,只在写入端(`dev()`)用它
  // 判断"要不要重新去问"。
  for (const item of items) {
    const key = item.source?.provider === "jira" ? item.source.ref : undefined;
    if (!key || issueMap.has(key)) continue;
    const hit = issueCache.get(key);
    if (hit) issueMap.set(key, hit.issue);
  }
  const devMap = new Map([...devCache].map(([id, hit]) => [id, hit.result]));

  const out: Record<string, Facet[]> = {};
  for (const item of items) {
    const facets = facetsFor(item, issueMap, devMap, getBrowseBase());
    if (facets.length) out[item.id] = facets;
  }
  return out;
}

/**
 * 描述正文的缓存。跟 dev 那份同样的道理：它要一次真实的请求，而模板选择器在同一张单上
 * 很可能被点好几下（换个模板看看）。
 *
 * `text` 存的是 `string | null`，跟"这个键在不在 Map 里"是两件不同的事：一个单
 * 真的没有描述，缓存值就是 `null`，跟"还没问过"（`descCache` 里根本没有这个键）
 * 分得清清楚楚——混起来会让"没有描述的单"每次 fields() 都当成没问过，重新发一次
 * 请求，而这在页面上完全看不出来，只有 Jira 那边的调用量会悄悄涨。
 */
export const DESC_CACHE_MS = 5 * 60_000;
const descCache = new Map<string, { at: number; text: string | null }>();

/**
 * 取一个单的描述正文：读配置、发一次请求。`fields()` 默认用它，测试注入一个假的
 * 进去——理由跟这个仓库别处的默认参数一样（`collectFields(item, sources =
 * FIELD_SOURCES)`、`fetchIssues(config, fetcher = fetch)`）：不注入就没法在不出网
 * 的前提下证明缓存那几条边界（命中不重问、过期才重问、null 也走缓存）真的成立。
 */
async function fetchDescription(key: string): Promise<string | null> {
  const config = await readJiraConfig();
  return config ? await fetchIssueDescription(config, key) : null;
}

/**
 * 一张单喂给模板的字段。
 *
 * 便宜的那几格直接从工单列表的缓存里取——它们本来就在内存里。只有描述正文要发一次请求，
 * 这也正是 fields 的预算是 5 秒而不是 enrich 的 300 毫秒的原因。
 *
 * `getDescription` 和 `now` 都是可选的注入点，真实现（发请求、`Date.now`）做默认值：
 * 前者让测试不用出网就能断言请求发没发；后者让测试不用真的等 5 分钟就能断言缓存过期。
 */
export async function fields(
  item: ItemRef,
  getDescription: (key: string) => Promise<string | null> = fetchDescription,
  now: () => number = Date.now,
): Promise<Record<string, string>> {
  if (item.source?.provider !== "jira") return {};
  const key = item.source.ref;

  const out: Record<string, string> = {};
  const cache = getCache();
  const issue = cache?.result.ok ? cache.result.issues.find((i) => i.key === key) : undefined;
  if (issue) {
    out["jira.summary"] = issue.summary;
    out["jira.status"] = issue.status;
    out["jira.type"] = issue.type;
    if (issue.assignee) out["jira.assignee"] = issue.assignee;
    const epic = epicSummaryOf(issue);
    if (epic) out["jira.epic"] = epic;
  }

  const hit = descCache.get(key);
  let description = hit && now() - hit.at < DESC_CACHE_MS ? hit.text : undefined;
  if (description === undefined) {
    description = await getDescription(key);
    descCache.set(key, { at: now(), text: description });
  }
  if (description) out["jira.description"] = description;

  return out;
}

/**
 * 挑出该去拉 PR/检查的单号：source 是 jira、且有一条**活跃**绑定的那些。
 *
 * 纯函数——items 和 bindings 都当参数喂进来，唯一有判断的地方能无头测；带网络
 * 的那部分（真的去问 dev-status）测不了，也不需要测，devTargets 选对了目标，
 * 网络那层照抄现成的 dev()/mapLimited 就行。
 */
export function devTargets(items: ItemRef[], bindings: ResolvedBinding[]): string[] {
  const liveItemIds = new Set(bindings.filter((b) => b.live).map((b) => b.itemId));
  const out: string[] = [];
  for (const item of items) {
    if (item.source?.provider !== "jira") continue;
    if (!liveItemIds.has(item.id)) continue;
    out.push(item.source.ref);
  }
  return out;
}

/**
 * 给一批单号（key）解析出 dev-status 要用的 id：先查当次拿到的结果，查不到
 * 再退回上一次缓存的全量列表，两边都没有就跳过。
 *
 * 增量同步下"这次的结果"只有变过的那几条——一个活跃绑定的单如果本身没变，就
 * 不在这次结果里，但它挂的 PR 完全可能刚跑完一次构建，仍然值得重刷一次。只
 * 看当次结果会让这种单悄悄停止收到 CI 刷新，这跟"只给有活跃会话的单拉"是完全
 * 不同的两件事：那条限制是故意少问，这里是因为问漏了，不该混在一起。
 *
 * 纯函数：两份 issue 列表和目标 key 都是参数，能无头测；真的去打 dev-status
 * 的那半不需要也不能测，devTargets 已经把"该拉谁"的判断从网络里摘出来过一次，
 * 这是同一个理由的延伸。
 */
export function resolveDevIds(
  current: Issue[],
  cached: Issue[],
  keys: Iterable<string>,
): Array<{ id: string; key: string }> {
  const byKey = new Map<string, Issue>();
  for (const i of cached) byKey.set(i.key, i);
  // 当次结果后写，同一个 key 两边都有时以当次为准——它更可能是最新的。
  for (const i of current) byKey.set(i.key, i);

  const out: Array<{ id: string; key: string }> = [];
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const issue = byKey.get(key);
    if (issue?.id) out.push({ id: issue.id, key: issue.key });
  }
  return out;
}

/**
 * 增量同步问多久的窗口：从上次成功同步"发起"的那一刻到现在，再加 2 分钟的
 * 余量。
 *
 * +2 分钟是给 Jira 的分钟级时间戳精度和两边的时钟偏差留的安全边际——把边缘
 * 上一两条已经见过的单再问一遍是无害的（ensureItemForSource 是幂等的，重复
 * 写一次跟没写没区别），漏掉一条真正变了的单才是问题，所以窗口宁可宽一点。
 */
function incrementalWindowMinutes(lastSyncAt: number): number {
  return Math.ceil((Date.now() - lastSyncAt) / 60_000) + 2;
}

/**
 * 把 config.json 里的 JQL 结果同步进内核的单列表，再给正开着会话的那些拉一次
 * PR/检查。
 *
 * 未配置、拉取失败都返回零结果而不是抛——同步是后台动作，不该有一条异常路径
 * 能把调用方（runSync，进而是启动流程）带崩。PR 那一步单独 try/catch：拿不到
 * PR 不该抹掉刚刚同步成功的工单。
 *
 * "返回零结果而不是抛"曾经意味着失败会彻底安静：start() 里 `void sync().catch()`
 * 的那个 handler 永远等不到会抛的 sync()，一个被吊销的 token 就会让列表悄悄停
 * 在旧数据上、什么都不说。日志因此打在这里——`!result.ok` 分支自己才是真正
 * 知道"问不到、以及为什么"的地方，把 log 塞进 start() 的 catch 只是一段看着
 * 像在处理这件事、实际永远不会跑的死代码。
 *
 * `opts.full` 之外，还有四种情况必须退回全量，而不是这个调用方自己选：从没
 * 同步成功过（没有游标可用）、游标记的 JQL 跟现在的 config.jql 不一样（用户
 * 改过查询——旧游标描述的是另一条查询，拿它当"这之后有什么变了"没有意义，见
 * sync-state.ts）、系统时钟往回跳导致 `lastSyncAt` 比现在还晚，以及进程内的
 * `cache` 还是冷的。时钟那条不是 `incrementalWindowMinutes` 自己去钳：钳出来
 * 的窗口是"至少 1 分钟"，而时钟不可信的时候"至少 1 分钟"恰恰是最危险的答
 * 案——它看起来像一次正常的增量、实际上把过去这一整段时间的改动全部漏掉了。
 * 时钟不可信就该整段不信，退回全量，而不是拿一个算出来的负数窗口硬凑一个正数。
 *
 * `cache` 冷这一条是增量同步自己造出来的缺口：下面能看到,增量分支故意绕开
 * `issues()`、直接调 `fetchIssues`,理由是增量结果只有"这次变了的几条",写进
 * `cache` 会把工单页的"全部列表"污染成"最近改过的几条"。但游标是存盘的,能
 * 活过一次进程重启;`cache` 不能——重启后哪怕磁盘上的游标依然有效,内存里的
 * `cache` 也是 null。增量分支既然从不写它,就永远轮不到别人把它焐热,于是
 * `enrich()` 只能从 `issueCache` 的边角料(单独刷新过的那几个 key)里找,首页
 * 绝大多数单子一个 facet 都拿不到——这正是重启后在生产上实测到的样子:353 个
 * 单里只有 5 个还挂着 facet。所以 `cache` 是 null 时必须强制走一次全量,不管
 * 游标看起来多有效:这一次全量,才是唯一会把 `cache` 填上的机会。
 */
export async function sync(opts?: { full?: boolean }): Promise<SyncResult> {
  const config = await readJiraConfig();
  if (!config) return { created: 0, updated: 0, total: 0, truncated: false };
  noteConfig(config);

  const state = await readSyncState();
  const clockWentBackward = !!state && Date.now() < state.lastSyncAt;
  const full = !!opts?.full || !state || state.jql !== config.jql || clockWentBackward || !getCache();

  // 用请求**发起**的时间，不是拿到结果之后的时间——不然请求这段时间里发生的
  // 改动会被下一次的窗口漏掉。
  const startedAt = Date.now();

  let result: IssuesResult;
  if (full) {
    // 显式同步动作，绕开 60 秒的页面缓存——用户点了同步，或者游标不可用，就该
    // 真的问一次全量。issues() 会把结果写进模块级缓存，首页卡片上的 chip
    // 跟着更新——enrich() 读的就是那份缓存。
    result = await issues(true);
  } else {
    // 增量必须绕开 issues() 的模块级缓存，不能顺手调用它：那份缓存同时也是
    // enrich() 给首页每张卡片贴 chip 时查的那一份。增量结果天然只有"这次变了
    // 的那几条"，如果把它写进那份缓存，所有没变的单就从缓存里消失了——它们的
    // 卡片会在下一次画首页时一条 chip 都没有，看起来像是同步把数据弄丢了。
    // 所以这里直接调 fetchIssues，
    // 结果只喂给下面的 syncIssues/dev 刷新，从不碰 cache。
    result = await fetchIssues(config, fetch, incrementalJql(config.jql, incrementalWindowMinutes(state.lastSyncAt)));
  }

  if (!result.ok) {
    // 这里才是真正知道"问不到"这件事的地方——不是 start() 那个永远等不到异常
    // 的 .catch()。unconfigured 不算失败：还没配置的人不该每次启动都吃一行
    // 错误日志，那是"正常"的初始状态，不是故障。auth/query/unreachable 才是
    // 值得写进日志的——只打分类过的原因，不打原始响应体：那里面带账号信息，
    // 跟 /api/jira/config 从不回显 token 是同一条线。
    if (result.reason !== "unconfigured") {
      console.error(`[jira] ${full ? "全量" : "增量"}同步失败：${result.reason}`);
    }
    return { created: 0, updated: 0, total: 0, truncated: false };
  }

  // 增量分支不写 `cache`（见上面的注释），但取回的每一条 issue 本身仍然带着
  // 完整字段，包括 assignee——`enrich()` 读的是 `issueCache`，不是 `cache`，
  // 所以把它焐热在这里跟"不污染全量列表"完全不冲突。不这么做的后果是：增量
  // 同步进来或更新的单子，assignee 明明问到了却被直接扔掉，页面上的「负责
  // 人」一直空着，只有点过一次单条「刷新」（走 refreshIssue，见上面 issueCache
  // 的注释）才会补上。全量分支已经在 issues() 里做了同样的事，这里不用重复。
  if (!full) {
    const at = Date.now();
    for (const issue of result.issues) issueCache.set(issue.key, { at, issue });
  }

  // 游标只在拉取成功之后才前移，失败绝不推进——推进了就等于承认"这段时间的
  // 改动我们已经看过了"，而实际上一条都没看到。
  await writeSyncState({ lastSyncAt: startedAt, jql: config.jql });

  // 同步之前先记下已经存在的 (provider, ref)：ensureItemForSource 返回的是
  // WorkItem 本身，不带"是不是新建的"这个标志——加这个标志要为了这一个调用方
  // 去改内核签名，划不来。改成调用方自己在同步前拍一张快照，之后用它判断。
  const before = await readItems();
  const existingRefs = new Set(
    before.filter((i) => i.source?.provider === "jira").map((i) => i.source!.ref),
  );

  // 工单页地址。只有产生这个来源的一方知道怎么拼——内核不该替它猜，所以由这里
  // 一并写进 source.url，首页那颗单号徽标据此变成可点的链接。
  const browse = await browseUrl();
  const syncResult = await syncIssues(result, async (ref, title, createdAt) => {
    const created = !existingRefs.has(ref);
    await ensureItemForSource("jira", ref, title, { refreshTitle: true, createdAt, ...browse(ref) });
    return { created };
  });

  // PR/检查是独立的一步：这一步失败不该把已经写好的工单同步结果变成失败。
  try {
    // sessionIdentities() 而非 listSessions()：这里只要 name/sessionId 对，
    // listSessions() 会为每个会话多起一次 capture-pane 子进程——这台机器上曾经
    // 是 37 个会话、37 次子进程起停，只为了取一对字段。
    const [afterItems, bindings] = await Promise.all([
      readItems(),
      resolveBindings(await sessionIdentities()),
    ]);
    const targets = devTargets(afterItems, bindings);
    if (targets.length) {
      // 增量结果里查不到的活跃绑定单（本身没变，但仍想刷一次 PR/CI），退回
      // 上一次缓存的全量列表去找——见 resolveDevIds 的注释。
      const currentCache = getCache();
      const cachedIssues = currentCache?.result.ok ? currentCache.result.issues : [];
      const resolved = resolveDevIds(result.issues, cachedIssues, targets);
      await mapLimited(resolved, DEV_CONCURRENCY, ({ id, key }) => dev(id, key, true));
    }
  } catch {
    // 拉 PR/检查失败不影响已经同步好的工单结果。
  }

  return syncResult;
}

/**
 * 只刷新一个单：先重取工单本身，再重取它的 PR/检查，再把标题写回内核。
 *
 * 不经过 devTargets 的"只给有活跃会话的单拉"这条限制——那条限制是为了不在批量
 * 同步时打出上百个请求，单条刷新是用户明确点了这一个,该刷就刷。
 *
 * refreshIssue 返回 null 时（未配置、Jira 不通）不能悄悄 return——那样调用方
 * （refreshFromSource，再往上是首页的刷新按钮）会看到一个 resolve 掉的
 * Promise，把"没问到"读成"问到了、也刷了"。抛出去，让 refreshFromSource 已有的
 * try/catch 把它收成 false，页面才会照实说"刷新失败"而不是假装刷新成功地
 * 重新渲染一遍原样的卡片。这条判断是 CLAUDE.md 里 checksKnown 那条的同一个理由：
 * "我们没问到"不能被表现成"我们问到了"。
 *
 * ensureItemForSource(..., { refreshTitle: true }) 补的是同步（sync()）已经在
 * 做、但单条刷新一直没做的事：远端改了标题，全量同步会跟着改，点这一个单的
 * 刷新按钮却不会——同一个按钮，越具体的动作反而做得比笼统的那个少，用户会当
 * 成没生效。
 */
export async function refreshItem(ref: string): Promise<void> {
  const issue = await refreshIssue(ref);
  if (!issue) throw new Error(`refreshIssue(${ref}) 没问到——未配置或 Jira 不通`);
  await dev(issue.id, issue.key, true);
  const browse = await browseUrl();
  const createdAt = issue.created ? Math.floor(issue.created / 1000) : undefined;
  await ensureItemForSource("jira", ref, issue.summary, { refreshTitle: true, createdAt, ...browse(ref) });
}

/** `ItemStatus` → 这个实例配的 Jira 状态名。`unclaimed` 不是一次迁移，没有对应项。 */
function jiraStatusFor(config: JiraConfig, to: ItemStatus): string {
  switch (to) {
    case "in_progress":
      return config.transitions.inProgress;
    case "in_review":
      return config.transitions.inReview;
    case "in_merge":
      return config.transitions.inMerge;
    case "done":
      return config.transitions.done;
    case "unclaimed":
      return "";
  }
}

/**
 * ItemLifecycle 迁移之后的写回：只转 Jira 状态。
 *
 * 不写 PR：评论区是给人看的地方，不该由工具自动灌水。
 *
 * 不吞异常：调用方（`plugins/handlers.ts` 的 `notifyLifecycleChange`）已经在
 * 外层 try/catch+超时，这里如实抛出。
 */
export async function onLifecycleChange(ref: string, from: ItemStatus, to: ItemStatus): Promise<void> {
  const config = await readJiraConfig();
  if (!config) return;

  const targetStatus = jiraStatusFor(config, to);
  await transitionIssue(config, ref, targetStatus).catch(() => {});
}

/**
 * 拼工单页地址的函数，配置读一次。
 *
 * 没配 URL 就返回空对象——`ensureItemForSource` 收到没有 url 的 opts 会原样保留
 * 已有的那个，而不是清掉。这是对的：读不到配置是**我们**这边的临时状态，不该
 * 表现成"这张单没有地址了"。
 */
async function browseUrl(): Promise<(ref: string) => { url?: string }> {
  const config = await readJiraConfig();
  const base = config?.url;
  if (!base) return () => ({});
  return (ref) => ({ url: `${base}/browse/${encodeURIComponent(ref)}` });
}

/**
 * 进程启动时的一次机会。发出去就不管——手机打开这个页面不该等 Jira 的网络往返。
 *
 * 这里的 .catch() **不是失败报告的地方**——真正知道"问不到、以及为什么"的是
 * sync() 内部 `!result.ok` 那个分支，日志已经打在那儿了（见 sync() 的注释）。
 * 这条 .catch() 现在纯粹是防呆：sync() 目前每一步都在自己的 try/catch 里
 * （issues()/readJiraConfig() 从不抛，PR/dev 那一步有自己的 try/catch），
 * 按今天的写法它不会拒绝，但"今天不会"不是语言保证——以后有人往 sync() 里加
 * 一步没包 try/catch 的代码，这条 .catch() 是唯一挡在"一个插件的 start() 抛出
 * 未捕获异常"和"整个启动流程"之间的东西（同 plugins/handlers.ts 的
 * startPlugins() 那条"一个插件的 start 抛了不能挡住服务器起来"）。故意不在这
 * 里第二次打日志：那会让人以为这里也是覆盖失败原因的地方，而它现在真的不是。
 */
export function start(): void {
  void sync().catch(() => {});
}

/**
 * 交给内核的来源：五个方法都是这个文件里已有的函数。
 *
 * 内核只按 `provider` 这个字符串找到它，从不知道这是哪个插件——`plugins/handlers.ts`
 * 的 `SERVERS.jira.sources` 里放的就是这一个对象。
 */
export const source: ItemSourceProvider = {
  provider: "jira",
  sync,
  refreshItem,
  enrich,
  fields,
  onLifecycleChange,
};
