import { readJiraConfig } from "./config";
import { fetchIssues, type Issue, type IssuesResult } from "./client";
import { liveSessions } from "./sessions";
import { readBindings, bindSession, unbindSession, resolveBindings } from "./bindings";
import type { Annotation } from "../types";

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

  if (url.pathname === "/api/jira/bindings" && req.method === "GET") {
    return Response.json({ bindings: await resolveBindings(await liveSessions()) });
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
    const live = await liveSessions();
    const found = live.find((s) => s.name === body.session);
    await bindSession(body.session, body.key, found?.id ?? "");
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

/**
 * 会话列表上的标注：这个会话属于哪个单。
 *
 * 只读绑定文件，**不打 Jira**：这个函数在内核构建列表的路径上，有 300ms 的硬
 * 超时，一次网络往返根本来不及；而且列表页每次打开都会调它，拿它去打 Jira 等于
 * 把速率限制往枪口上撞。标题从已缓存的工单里取，取不到就只显示单号。
 */
export async function annotate(sessions: string[]): Promise<Record<string, Annotation>> {
  const bindings = await readBindings();
  const summaries = new Map<string, Issue>(
    cache?.result.ok ? cache.result.issues.map((i) => [i.key, i]) : [],
  );

  const out: Record<string, Annotation> = {};
  for (const session of sessions) {
    const binding = bindings[session];
    if (!binding) continue;
    const issue = summaries.get(binding.key);
    out[session] = {
      text: binding.key,
      ...(issue?.summary ? { detail: issue.summary } : {}),
      tone: issue?.statusCategory === "done" ? "dim" : "ok",
    };
  }
  return out;
}
