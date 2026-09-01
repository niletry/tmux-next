import { readJiraConfig } from "./config";
import { fetchIssue, fetchIssues, type Issue, type IssuesResult } from "./client";
import { fetchDev, type DevResult } from "./dev";
import { readItems, ensureItemForSource } from "../../src/items";
import { bindSession, unbindSession, resolveBindings } from "../../src/session-binding";
import { sessionIdentities } from "../../src/tmux/session-list";

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
