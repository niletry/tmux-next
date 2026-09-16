import { createItem, readItems, updateItem } from "./model";
import { bindSession, readBindings, resolveBindings, unbindSession } from "./binding";
import { kernelFacets } from "./facets";
import { advanceLifecycle } from "./lifecycle";
import { kernelFields } from "./fields";
import { historyForItem } from "../session-history";
import { listSessions, sessionIdentities } from "../tmux/session-list";
import { notifyLifecycle } from "../push";
import { render, sanitiseName } from "../template";
import { collectFacets, collectFields, runSync, refreshFromSource, notifyLifecycleChange } from "./sources";
import type { Facet } from "../../plugins/types";

/**
 * 单的全部 HTTP 路由。
 *
 * 从 server.ts 搬来，一行没改。留在这里的顺序陷阱有三个，都踩过：
 * /api/items/bind、/api/items/sync、/api/items/by-session 必须排在
 * ^/api/items/([^/]+)$ 之前，否则那条正则把 "bind"/"sync"/"by-session" 当成单号。
 * routes.test.ts 用 200 断言这个顺序，不靠注释。
 */

/**
 * 一张单的全貌：单本身、它此刻活着的会话、以及它这一列 facet。
 *
 * 首页那条 /api/items 是整表算一次；这里把入参收成一张单，算法一模一样（内核的
 * kernelFacets 加插件的 collectFacets），所以浮层里的 chip 和首页卡片上不会是两套
 * 说法——唯一的差别是 cap：首页要护着"一张卡最多几个"，这里问的只有一张单、不是
 * 卡片，传 Infinity 跳过那条封顶，见 collectFacets 的注释。facets 给的是这一张单
 * 的那一列数组，不是 { itemId: Facet[] } 的表——只问一张单的人不该再去表里取一次键。
 *
 * 单不存在就 404，包括"绑定还指着一张已经被扫掉的单"这种：那跟"这个会话没挂单"
 * 对调用方是同一件事，页面两种情况都是不画那个入口。
 */
async function itemDetail(id: string): Promise<Response> {
  const items = await readItems();
  const item = items.find((i) => i.id === id);
  if (!item) return new Response("no such item", { status: 404 });
  const live = await listSessions();
  const bindings = await resolveBindings(
    live.map((s) => ({ name: s.name, sessionId: s.sessionId })),
  );
  const mine = new Set(
    bindings.filter((b) => b.live && b.itemId === item.id).map((b) => b.session),
  );
  const sessions = live.filter((s) => mine.has(s.name));
  const kernel = kernelFacets([item], live, bindings)[item.id] ?? [];
  // 面板不是卡片，不受首页那条"一张卡最多几个"的护栏——见 collectFacets 的 cap 注释。
  const theirs = await collectFacets(
    [{ id: item.id, source: item.source ? { provider: item.source.provider, ref: item.source.ref } : null }],
    undefined,
    undefined,
    Infinity,
  );
  const history = await historyForItem(item.id);
  return Response.json({ item, sessions, facets: [...kernel, ...(theirs[item.id] ?? [])], history });
}

/**
 * 跑一轮 ItemLifecycle：只在 `runSync`/`refreshFromSource` 跑完之后调用，不新开
 * 轮询（见 docs/superpowers/specs/2026-09-04-item-lifecycle-writeback-design.md）。
 *
 * 只用 `sessionIdentities()` 不用 `listSessions()`：状态机只看"绑定活不活"，用不
 * 到会话摘要里的状态/最后动作那些字段——跟 `jiraBindingsView`/`itemBind` 已经在
 * 用的取舍一样，没必要为一对字段多起一次 capture-pane。
 *
 * 每条迁移落盘之后，写回和推送各自独立、互不影响：一个失败不该拖累另一个，也不
 * 该撤销已经落盘的状态——见 spec 的"写回失败不回滚本地状态"。
 */
export async function advanceAllLifecycles(): Promise<void> {
  const items = await readItems();
  const live = await sessionIdentities();
  const bindings = await resolveBindings(live);
  const facets = await collectFacets(
    items.map((i) => ({
      id: i.id,
      source: i.source ? { provider: i.source.provider, ref: i.source.ref } : null,
    })),
  );
  const transitions = advanceLifecycle(items, facets, bindings);
  for (const { item, from, to } of transitions) {
    await updateItem(item.id, { status: to });
    if (item.source) {
      await notifyLifecycleChange(item.source.provider, item.source.ref, from, to);
    }
    if (to === "unclaimed") continue; // 回退不是一次"进展"，不推送。
    await notifyLifecycle(item.id, item.title, to).catch(() => {});
  }
}

export async function itemsRoutes(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/items")) return null;

    if (url.pathname === "/api/items" && req.method === "GET") {
      // 这里改回 listSessions()：首页要在同一次请求里画出每张卡片下的会话行，
      // 那些字段（状态、最后动作……）只有完整摘要里有，sessionIdentities() 的
      // {name, sessionId} 不够。再打一次 /api/sessions 会让"几个会话"和下面
      // 列出的行来自两个时刻。
      const [items, live] = await Promise.all([readItems(), listSessions()]);
      const bindings = await resolveBindings(
        live.map((s) => ({ name: s.name, sessionId: s.sessionId })),
      );
      // 内核的维度和插件的合并成一张表：视图层不该知道一个维度是谁产的。
      const mine = kernelFacets(items, live, bindings);
      const theirs = await collectFacets(
        items.map((i) => ({
          id: i.id,
          source: i.source ? { provider: i.source.provider, ref: i.source.ref } : null,
        })),
      );
      const facets: Record<string, Facet[]> = {};
      for (const item of items) {
        facets[item.id] = [...(mine[item.id] ?? []), ...(theirs[item.id] ?? [])];
      }
      return Response.json({ items, bindings, sessions: live, facets });
    }

    if (url.pathname === "/api/items" && req.method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const b = body as Record<string, unknown>;
      const title = typeof b?.title === "string" ? b.title.trim() : "";
      if (!title) return new Response("missing title", { status: 400 });
      const item = await createItem({
        title: title.slice(0, 200),
        source:
          typeof (b.source as any)?.provider === "string" &&
          typeof (b.source as any)?.ref === "string"
            ? { provider: (b.source as any).provider, ref: (b.source as any).ref }
            : null,
      });
      return Response.json(item, { status: 201 });
    }

    // 这条 DELETE 必须排在下面的 PATCH（^/api/items/([^/]+)$）之前，否则
    // "bind" 会被那条正则当成一个 item id 吞掉。方法不同实际不会撞，但顺序
    // 写对，省掉一次将来的踩坑。
    if (url.pathname === "/api/items/bind" && req.method === "DELETE") {
      const session = url.searchParams.get("session");
      if (!session) return new Response("missing session", { status: 400 });
      await unbindSession(session);
      return Response.json({ ok: true });
    }

    const itemBind = url.pathname.match(/^\/api\/items\/([^/]+)\/bind$/);
    if (itemBind && req.method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const session = (body as Record<string, unknown>)?.session;
      if (typeof session !== "string" || !session) {
        return new Response("missing session", { status: 400 });
      }
      const id = decodeURIComponent(itemBind[1]!);
      const items = await readItems();
      if (!items.some((i) => i.id === id)) return new Response("no such item", { status: 404 });
      // 会话必须真的在，否则绑定会指向一个从没存在过的名字。sessionIdentities()
      // 而非 listSessions()：这里只用得到 name/sessionId，但 sessionId 必须是
      // 真的——丢了它，这条绑定就再也扛不住改名。
      const live = await sessionIdentities();
      const found = live.find((s) => s.name === session);
      if (!found) return new Response("no such session", { status: 404 });
      await bindSession(session, id, found.sessionId);
      return Response.json({ ok: true });
    }

    // 必须排在下面的 ^/api/items/([^/]+)$ 之前，否则 "sync" 会被那条正则
    // 当成一个 item id 吞掉——同一个坑，/api/items/bind 已经踩过一次。
    if (url.pathname === "/api/items/sync" && req.method === "POST") {
      const result = await runSync();
      await advanceAllLifecycles();
      return Response.json(result);
    }

    // 三种情况都归到同一个 404：单不存在、单没有来源、来源没人认领。页面
    // 用这个 404 决定不画刷新按钮，而不是画一个注定失败的按钮——所以三种
    // 情况必须收敛成同一个响应，不能分出更细的状态码。
    const itemRefresh = url.pathname.match(/^\/api\/items\/([^/]+)\/refresh$/);
    if (itemRefresh && req.method === "POST") {
      const id = decodeURIComponent(itemRefresh[1]!);
      const found = (await readItems()).find((i) => i.id === id);
      if (!found?.source) return new Response("no source", { status: 404 });
      const ok = await refreshFromSource(found.source.provider, found.source.ref);
      if (!ok) return new Response("no source", { status: 404 });
      await advanceAllLifecycles();
      return Response.json({ ok: true });
    }

    const itemRender = url.pathname.match(/^\/api\/items\/([^/]+)\/render$/);
    if (itemRender && req.method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const b = body as Record<string, unknown>;
      const id = decodeURIComponent(itemRender[1]!);
      const item = (await readItems()).find((i) => i.id === id);
      if (!item) return new Response("no such item", { status: 404 });

      // 收的是模板串，不是 templateId：渲染因此跟"模板存在哪"完全解耦，设置页能边编辑
      // 边看真实预览而不必先存盘。
      const nameTpl = typeof b?.name === "string" ? b.name : "";
      const inputTpl = typeof b?.input === "string" ? b.input : "";

      // 插件的字段先铺，内核的后盖。collectFields 已经挡住了 item.* 前缀，这个顺序
      // 只是第二道——两道都在，是因为这张表最终会被当成"这张单的事实"用。
      const fields = {
        ...(await collectFields({
          id: item.id,
          source: item.source ? { provider: item.source.provider, ref: item.source.ref } : null,
        })),
        ...kernelFields(item),
      };
      // 会话名那一半还要过 sanitiseName：框里显示的必须就是最终真正会用的名字，否则
      // 模板渲染出"修登录页。"这种带点号的名字，用户会在提交时撞上一个
      // validateRequestedName 的 400——而那个错不是他造成的。净化不出来（null）时给空串,
      // 等于"没提供名字"，服务端按目录生成，正是既有的默认路径。
      //
      // validateRequestedName 本身不改：人手打一个点号仍然该得到诚实的报错。
      const name = sanitiseName(render(nameTpl, fields)) ?? "";
      return Response.json({ name, input: render(inputTpl, fields) });
    }

    // 这条必须排在下面的 ^/api/items/([^/]+)$ 之前，否则 "by-session" 会被那
    // 条正则当成一个单号吞掉——同一个坑，/api/items/bind 与 /api/items/sync 都
    // 踩过。终端页只知道自己的会话名，它认单的入口就是这里。
    //
    // 按**名字**认，不走 resolveBindings 的 id 优先：那一套是为了跨改名与跨
    // tmux server 重启把记录接回去，需要一份活会话清单；这里问的人手上正拿着
    // 一个当下的会话名，多打一次 tmux 只为绕回同一个答案。
    if (url.pathname === "/api/items/by-session" && req.method === "GET") {
      const session = url.searchParams.get("session");
      if (!session) return new Response("missing session", { status: 400 });
      const binding = (await readBindings())[session];
      if (!binding) return new Response("not bound", { status: 404 });
      return itemDetail(binding.itemId);
    }

    const itemGet = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (itemGet && req.method === "GET") {
      return itemDetail(decodeURIComponent(itemGet[1]!));
    }

    // PATCH /api/items/:id：只挑允许改的字段，绝不把请求体整个 Object.assign
    // 进去——id 与 createdAt 必须挡住，不然请求体就能伪造出一张假单。
    const itemPatch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (itemPatch && req.method === "PATCH") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const b = body as Record<string, unknown>;
      const patch: Parameters<typeof updateItem>[1] = {};
      if (typeof b.title === "string" && b.title.trim()) patch.title = b.title.trim().slice(0, 200);
      if (Array.isArray(b.tags)) patch.tags = b.tags.filter((t): t is string => typeof t === "string");
      if (typeof b.closedAt === "number" || b.closedAt === null) patch.closedAt = b.closedAt as number | null;
      const next = await updateItem(decodeURIComponent(itemPatch[1]!), patch);
      if (!next) return new Response("no such item", { status: 404 });
      return Response.json(next);
    }

  return null;
}
