import { readJiraConfig } from "./config";
import { fetchIssue, fetchIssues, type Issue, type IssuesResult } from "./client";
import { fetchDev, type DevResult } from "./dev";
import { syncIssues } from "./sync";
import { readItems, ensureItemForSource } from "../../src/items";
import { bindSession, unbindSession, resolveBindings, type ResolvedBinding } from "../../src/session-binding";
import { sessionIdentities } from "../../src/tmux/session-list";
import type { Facet, ItemRef } from "../types";
import type { SyncResult } from "../handlers";

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

async function issues(refresh: boolean): Promise<IssuesResult> {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache.result;
  const config = await readJiraConfig();
  if (!config) return { ok: false, reason: "unconfigured" };
  const result = await fetchIssues(config);
  // 只缓存成功：一次网络抖动不该让人盯着错误看满一分钟。
  if (result.ok) cache = { at: Date.now(), result };
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

const devCache = new Map<string, { at: number; result: DevResult }>();

/** 同时在跑的 dev-status 请求数。批量刷新时不至于一次打出去五十个连接。 */
const DEV_CONCURRENCY = 4;

async function dev(issueId: string, issueKey: string, refresh: boolean): Promise<DevResult> {
  const hit = devCache.get(issueId);
  if (!refresh && hit && Date.now() - hit.at < DEV_CACHE_MS) return hit.result;

  const config = await readJiraConfig();
  if (!config) return { ok: false, reason: "auth" };

  const result = await fetchDev(config, issueId, issueKey);
  // 只缓存成功。一次抖动不该让这个单的 PR 消失五分钟。
  if (result.ok) devCache.set(issueId, { at: Date.now(), result });
  return result;
}

/** 有并发上限的 map，跟 dev.ts 里那个同源，此处不共享是为了不把内部函数导出去。 */
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
 * 重取一条工单，并把它写回列表缓存。
 *
 * 写回是要紧的一步：不写回的话，这次拿到的新状态只活在这一个响应里，页面下一次
 * 重画（或者别处触发的一次渲染）就会用回缓存里的旧值，看起来像是刷新没生效。
 */
async function refreshIssue(key: string): Promise<Issue | null> {
  const config = await readJiraConfig();
  if (!config) return null;
  const got = await fetchIssue(config, key);
  if (!got.ok) return null;

  if (cache?.result.ok) {
    const list = cache.result.issues;
    const at = list.findIndex((i) => i.key === key);
    if (at >= 0) list[at] = got.issue;
  }
  return got.issue;
}

/**
 * 内核的绑定，翻译成 Jira 页认得的形状。
 *
 * 只挑 source 是 jira 的单——本地单与将来别家来源的单不属于这个视图。翻译放在
 * 插件这边而不是内核那边，是因为"itemId ↔ 单号"是 Jira 的语言，内核不认识它。
 */
export async function jiraBindingsView(
  live: Array<{ name: string; sessionId: string }>,
): Promise<Array<{ session: string; key: string; live: boolean }>> {
  const [items, bindings] = await Promise.all([readItems(), resolveBindings(live)]);
  const keyOf = new Map(
    items.filter((i) => i.source?.provider === "jira").map((i) => [i.id, i.source!.ref]),
  );
  const out: Array<{ session: string; key: string; live: boolean }> = [];
  for (const b of bindings) {
    const key = keyOf.get(b.itemId);
    if (!key) continue;
    out.push({ session: b.session, key, live: b.live });
  }
  return out;
}

/** 认领：这个单号还没有单就建一张，然后把会话绑上去。 */
export async function claimIssue(session: string, key: string, sessionId: string): Promise<void> {
  const item = await ensureItemForSource("jira", key, key);
  await bindSession(session, item.id, sessionId);
}

/** 内核的会话列表，映射成绑定解析要的最小形状。 */
async function liveFromKernel(): Promise<Array<{ name: string; sessionId: string }>> {
  // sessionIdentities() 而非 listSessions()：这里只要 name/sessionId 对，
  // listSessions() 会为每个会话多起一次 capture-pane 子进程——这台机器上曾经
  // 是 37 个会话、37 次子进程起停，只为了取一对字段。
  return sessionIdentities();
}

/**
 * 一张单能从两个缓存里读出哪些维度。纯函数，缓存当参数喂进来，于是能无头地测。
 *
 * 只认 source 是 jira 的单——传进来的是**全部**单（内核不按 provider 预筛，那会在
 * 内核里写死"provider 名就是插件 id"），挑是这边的事。
 */
/**
 * 一个检查状态对应的色调。
 *
 * 跟工单页 jira.js 的 checkTone 是同一套判断，只是那边产 CSS 类名、这边产 facet
 * 的 tone——两处都只认 Bitbucket 的原始状态词，改判断要一起改。
 */
/**
 * PR 状态的色调。MERGED 是"这条已经不用管了"所以压暗，DECLINED 才是要看一眼的。
 * OPEN 不给色——列表里绝大多数都是 OPEN，全部染色等于没染。
 */
function prFacetTone(status: string): "ok" | "warn" | "dim" | undefined {
  if (status === "MERGED") return "dim";
  if (status === "DECLINED") return "warn";
  return undefined;
}

function checkFacetTone(state: string): "ok" | "warn" | "dim" {
  if (state === "FAILED" || state === "STOPPED") return "warn";
  if (state === "INPROGRESS") return "dim";
  return "ok";
}

export function facetsFor(
  item: ItemRef,
  issues: Map<string, Issue>,
  dev: Map<string, DevResult>,
): Facet[] {
  if (item.source?.provider !== "jira") return [];
  const issue = issues.get(item.source.ref);
  if (!issue) return []; // 缓存没命中：少给几个维度，不阻塞、不给陈旧值

  const facets: Facet[] = [
    {
      dim: "jira.status",
      value: issue.status,
      tone:
        issue.statusCategory === "done" ? "dim" : issue.statusCategory === "indeterminate" ? "ok" : undefined,
    },
  ];
  // 史诗名走 `parent`，不是一个独立的 epicName 字段：`parent` 同时装着普通工单的
  // 史诗和子任务的父任务，`hierarchy >= 1` 才是史诗——跟 public/filter.js 的
  // epicKeyOf 和 public/jira.js 里卡片上的判断保持一致。
  if (issue.parent && issue.parent.hierarchy >= 1) {
    facets.push({ dim: "jira.epic", value: issue.parent.summary || issue.parent.key });
  }
  // 未分配是 null，不产出维度——"没有负责人"和"负责人是某个空值"是两回事，
  // 混成一个维度会让卡片上出现一个读不出意思的 chip。
  if (issue.assignee) {
    facets.push({ dim: "jira.assignee", value: issue.assignee });
  }

  const got = dev.get(issue.id);
  if (got?.ok) {
    facets.push({
      dim: "jira.prs",
      value: String(got.prs.length),
      // 数字说不出是哪个分支、开着还是并了。明细一行一个 PR：标题、状态、链接。
      // 这里给 url 而 checks 不给，是因为一个 PR 有自己的地址而一次检查在这份数据
      // 里没有——不是两处标准不一样。
      detail: got.prs.map((pr) => ({
        label: pr.title || pr.branch,
        value: pr.status,
        tone: prFacetTone(pr.status),
        url: pr.url,
      })),
    });
    // 只统计问到过检查的 PR：checksKnown 为 false 是"我们没问到"，跟"没有检查"是
    // 两回事，收成一个数字会让页面往好看的方向撒谎。
    const known = got.prs.filter((pr) => pr.checksKnown);
    const all = known.flatMap((pr) => pr.checks);
    if (known.length && all.length) {
      const failed = all.filter((c) => c.state === "FAILED").length;
      facets.push({
        dim: "jira.checks",
        value: `${failed}/${all.length}`,
        tone: failed ? "warn" : "ok",
        // 汇总数字只说"几个挂了"，说不出**是哪个**挂了——而那才是看到红色之后
        // 唯一想知道的事。明细把每个检查的名字（形如 ci/circleci: test）和状态
        // 带上去，首页因此不必再跳一趟工单页。
        // 不带 url：内核不渲染插件给的链接（那就得管协议白名单），要点进某次构建
        // 仍然去工单页。
        detail: all.map((c) => ({
          label: c.name,
          value: c.state,
          tone: checkFacetTone(c.state),
        })),
      });
    }
  }
  return facets;
}

/**
 * 内核每次画首页都会调这里，预算 300ms——**绝不发请求**，只读已有缓存。
 *
 * 一次网络往返进不了这个预算，而且按页加载去打 Jira 会把速率限制撞穿。缓存没命中
 * 就少给几个维度，那是正确的降级。
 */
export async function enrich(items: ItemRef[]): Promise<Record<string, Facet[]>> {
  const issueMap = new Map<string, Issue>(
    cache?.result.ok ? cache.result.issues.map((i) => [i.key, i]) : [],
  );
  const devMap = new Map([...devCache].map(([id, hit]) => [id, hit.result]));

  const out: Record<string, Facet[]> = {};
  for (const item of items) {
    const facets = facetsFor(item, issueMap, devMap);
    if (facets.length) out[item.id] = facets;
  }
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
 */
export async function sync(): Promise<SyncResult> {
  // 显式同步动作，绕开 60 秒的页面缓存——用户点了同步，就该真的问一次。
  const result = await issues(true);
  if (!result.ok) {
    // 这里才是真正知道"问不到"这件事的地方——不是 start() 那个永远等不到异常
    // 的 .catch()。unconfigured 不算失败：还没配置的人不该每次启动都吃一行
    // 错误日志，那是"正常"的初始状态，不是故障。auth/query/unreachable 才是
    // 值得写进日志的——只打分类过的原因，不打原始响应体：那里面带账号信息，
    // 跟 /api/jira/config 从不回显 token 是同一条线。
    if (result.reason !== "unconfigured") {
      console.error(`[jira] 启动同步失败：${result.reason}`);
    }
    return { created: 0, updated: 0, total: 0, truncated: false };
  }

  // 同步之前先记下已经存在的 (provider, ref)：ensureItemForSource 返回的是
  // WorkItem 本身，不带"是不是新建的"这个标志——加这个标志要为了这一个调用方
  // 去改内核签名，划不来。改成调用方自己在同步前拍一张快照，之后用它判断。
  const before = await readItems();
  const existingRefs = new Set(
    before.filter((i) => i.source?.provider === "jira").map((i) => i.source!.ref),
  );

  const syncResult = await syncIssues(result.issues, async (ref, title) => {
    const created = !existingRefs.has(ref);
    await ensureItemForSource("jira", ref, title, { refreshTitle: true });
    return { created };
  });

  // PR/检查是独立的一步：这一步失败不该把已经写好的工单同步结果变成失败。
  try {
    const [afterItems, bindings] = await Promise.all([readItems(), resolveBindings(await liveFromKernel())]);
    const targets = new Set(devTargets(afterItems, bindings));
    if (targets.size) {
      const keyById = new Map(result.issues.map((i) => [i.key, i.id]));
      const ids = [...targets].map((key) => keyById.get(key)).filter((id): id is string => !!id);
      const keyOfId = new Map(result.issues.map((i) => [i.id, i.key]));
      await mapLimited(ids, DEV_CONCURRENCY, (id) => dev(id, keyOfId.get(id) ?? "", true));
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
  await ensureItemForSource("jira", ref, issue.summary, { refreshTitle: true });
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

export async function handle(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/jira/config" && req.method === "GET") {
    const config = await readJiraConfig();
    // token 从不出门。url 和 email 出门是为了页面能显示"连的是哪个实例"。
    return Response.json(
      config ? { configured: true, url: config.url, email: config.email } : { configured: false },
    );
  }

  if (url.pathname === "/api/jira/issues" && req.method === "GET") {
    return Response.json(await issues(url.searchParams.get("refresh") === "1"));
  }

  // PR 与 CI。带 id 就是一个单——这是"只刷这一个"的入口；不带就是当前列表里的全部，
  // 走缓存加并发上限，而不是让浏览器自己发五十个请求。
  if (url.pathname === "/api/jira/dev" && req.method === "GET") {
    const refresh = url.searchParams.get("refresh") === "1";
    const one = url.searchParams.get("id");

    // 单号从缓存的工单列表里查，不从请求里收：它决定哪些 PR 被留下，让浏览器指定
    // 等于把过滤规则交给调用方。
    const listed = await issues(false);
    const keyById = new Map(listed.ok ? listed.issues.map((i) => [i.id, i.key]) : []);

    if (one !== null) {
      // id 只可能是 Jira 的内部数字 id，它会被拼进一个对外的 URL。
      if (!/^\d{1,19}$/.test(one)) return new Response("bad id", { status: 400 });
      const key = keyById.get(one) ?? "";

      // 单条刷新连工单本身一起刷。
      //
      // 从前它只刷 PR 与构建，于是一个长在卡片上的刷新按钮只刷了卡片的一半：状态
      // 还是几分钟前的样子。那不是 bug，但会被读成 bug——按钮在哪张卡上，就该把那
      // 张卡刷新。
      const fresh = refresh && key ? await refreshIssue(key) : null;

      return Response.json({
        dev: { [one]: await dev(one, key, refresh) },
        ...(fresh ? { issue: fresh } : {}),
      });
    }

    if (!listed.ok) return Response.json({ dev: {} });
    const ids = listed.issues.map((i) => i.id).filter(Boolean);
    const results = await mapLimited(ids, DEV_CONCURRENCY, (id) =>
      dev(id, keyById.get(id) ?? "", refresh),
    );
    return Response.json({ dev: Object.fromEntries(ids.map((id, i) => [id, results[i]!])) });
  }

  if (url.pathname === "/api/jira/bindings" && req.method === "GET") {
    return Response.json({ bindings: await jiraBindingsView(await liveFromKernel()) });
  }

  if (url.pathname === "/api/jira/bindings" && req.method === "POST") {
    let body: { session?: unknown; key?: unknown };
    try {
      body = await req.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }
    if (typeof body.session !== "string" || !body.session) {
      return new Response("bad session", { status: 400 });
    }
    if (typeof body.key !== "string" || !/^[A-Z][A-Z0-9]*-\d+$/.test(body.key)) {
      // 单号形状收窄：它会进文件名以外的地方展示，也会拼进 Jira 的 URL。
      return new Response("bad key", { status: 400 });
    }
    const live = await liveFromKernel();
    const found = live.find((s) => s.name === body.session);
    await claimIssue(body.session, body.key, found?.sessionId ?? "");
    return Response.json({ ok: true });
  }

  if (url.pathname === "/api/jira/bindings" && req.method === "DELETE") {
    const session = url.searchParams.get("session") ?? "";
    if (!session) return new Response("bad session", { status: 400 });
    await unbindSession(session);
    return Response.json({ ok: true });
  }

  return null;
}
