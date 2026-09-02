import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 绝不碰用户的 ~/.tmux-next/。路径在函数体里现读，所以设在 import 之前就够。
const stamp = Math.random().toString(36).slice(2, 10);
process.env.TMUX_NEXT_ITEMS_PATH = join(tmpdir(), `items-test-${stamp}.json`);
process.env.TMUX_NEXT_BINDINGS_PATH = join(tmpdir(), `bindings-test-${stamp}.json`);
// 迁移已经搬到 src/index.ts 的 CLI 入口去跑了，startServer() 不再触发它——但这
// 份隔离仍然值得留着：本文件驱动的正是读写 items/bindings 两张表的路由，纵深
// 防御地绝不能让它们指到用户真实的存档上，与迁移是否跑无关。
process.env.TMUX_NEXT_JIRA_DIR = join(tmpdir(), `items-test-jira-${stamp}`);

import { rm } from "node:fs/promises";
import { startServer } from "./server";

let server: { stop(): void; port: number };
const at = (path: string) => `http://127.0.0.1:${server.port}${path}`;

const json = (path: string, method: string, body: unknown) =>
  fetch(at(path), {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function makeItem(title: string, extra: Record<string, unknown> = {}) {
  const res = await json("/api/items", "POST", { title, ...extra });
  return (await res.json()) as { id: string; title: string; createdAt: number };
}

beforeAll(() => {
  server = startServer(0);
});

afterAll(async () => {
  server.stop();
  await rm(process.env.TMUX_NEXT_ITEMS_PATH!, { force: true });
  await rm(process.env.TMUX_NEXT_BINDINGS_PATH!, { force: true });
});

// 这些路由都读同一份文件，每条测试从空表开始。
afterEach(async () => {
  await rm(process.env.TMUX_NEXT_ITEMS_PATH!, { force: true });
  await rm(process.env.TMUX_NEXT_BINDINGS_PATH!, { force: true });
});

test("空的时候给空表", async () => {
  const res = await fetch(at("/api/items"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  // sessions 不能做整体深比较：这台机器跑着真实 tmux 服务器，里面活跃 Claude
  // 会话的 capture-pane 内容（spinner 之类）在两次异步调用之间就可能变化，深
  // 比较必然偶发失败。断言的重点是"响应恰好是这几个键、不多不少"——用键集合
  // 加逐字段校验来兑现，而不是假装这台机器没有会话。
  expect(Object.keys(body).sort()).toEqual(["bindings", "facets", "items", "sessions"]);
  expect(body.items).toEqual([]);
  expect(body.bindings).toEqual([]);
  expect(body.facets).toEqual({});
  expect(Array.isArray(body.sessions)).toBe(true);
});

test("列表带上 facets，没有单时是空表", async () => {
  const body = (await (await fetch(at("/api/items"))).json()) as { facets: Record<string, unknown> };
  expect(body.facets).toEqual({});
});

test("一张没有会话的单，内核给出 agent=none 与 sessions=0", async () => {
  const created = await makeItem("孤零零的单");
  const body = (await (await fetch(at("/api/items"))).json()) as {
    facets: Record<string, Array<{ dim: string; value: string }>>;
  };
  const dims = Object.fromEntries((body.facets[created.id] ?? []).map((f) => [f.dim, f.value]));
  expect(dims["item.agent"]).toBe("none");
  expect(dims["item.sessions"]).toBe("0");
});

test("带 cwd 的单给出目录维度", async () => {
  const created = await makeItem("有目录的单", { cwd: "/tmp/orbit" });
  const body = (await (await fetch(at("/api/items"))).json()) as {
    facets: Record<string, Array<{ dim: string; value: string }>>;
  };
  const dims = Object.fromEntries((body.facets[created.id] ?? []).map((f) => [f.dim, f.value]));
  expect(dims["item.cwd"]).toBe("orbit");
});

// 首页要在一次请求里拿齐画卡片需要的东西：单、绑定、会话摘要、维度。
// 分两次请求会让同一张卡片上的「几个会话」和下面列出的会话来自两个时刻。
test("列表同时带上会话摘要", async () => {
  const body = (await (await fetch(at("/api/items"))).json()) as { sessions: unknown };
  expect(Array.isArray(body.sessions)).toBe(true);
});

test("建单返回 201 与建出来的单", async () => {
  const res = await json("/api/items", "POST", { title: "修登录页", cwd: "/tmp/x" });
  expect(res.status).toBe(201);
  const item = (await res.json()) as { id: string; title: string; cwd: string };
  expect(item.title).toBe("修登录页");
  expect(item.cwd).toBe("/tmp/x");
  expect(item.id).toMatch(/^it-/);
});

test("没有 title 的建单请求被拒", async () => {
  const res = await json("/api/items", "POST", { cwd: "/tmp/x" });
  expect(res.status).toBe(400);
});

test("只有空白的 title 也被拒", async () => {
  const res = await json("/api/items", "POST", { title: "   " });
  expect(res.status).toBe(400);
});

test("坏 JSON body 被拒而不是 500", async () => {
  const res = await json("/api/items", "POST", "{ not json");
  expect(res.status).toBe(400);
});

test("建出来的单在列表里", async () => {
  const created = await makeItem("甲");
  const body = (await (await fetch(at("/api/items"))).json()) as { items: { id: string }[] };
  expect(body.items.map((i) => i.id)).toEqual([created.id]);
});

test("改标题", async () => {
  const created = await makeItem("旧");
  const res = await json(`/api/items/${created.id}`, "PATCH", { title: "新" });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { title: string }).title).toBe("新");
});

test("改不存在的单给 404", async () => {
  const res = await json("/api/items/it-nope", "PATCH", { title: "x" });
  expect(res.status).toBe(404);
});

// 归档走的是同一条 PATCH，不是一条删除路由——单不删，只是从默认视图收起来。
test("归档写得进 closedAt", async () => {
  const created = await makeItem("甲");
  const res = await json(`/api/items/${created.id}`, "PATCH", { closedAt: 1787000000 });
  expect(((await res.json()) as { closedAt: number }).closedAt).toBe(1787000000);
});

// 只挑允许改的字段，绝不把请求体整个 assign 进去。
test("patch 里的 id 与 createdAt 被忽略", async () => {
  const created = await makeItem("甲");
  const res = await json(`/api/items/${created.id}`, "PATCH", {
    id: "it-hijack",
    createdAt: 0,
    title: "乙",
  });
  const next = (await res.json()) as { id: string; createdAt: number; title: string };
  expect(next.id).toBe(created.id);
  expect(next.createdAt).toBe(created.createdAt);
  expect(next.title).toBe("乙");
});

test("绑到不存在的单给 404", async () => {
  const res = await json("/api/items/it-nope/bind", "POST", { session: "whatever" });
  expect(res.status).toBe(404);
});

test("绑到不存在的会话给 404", async () => {
  const created = await makeItem("甲");
  const res = await json(`/api/items/${created.id}/bind`, "POST", {
    session: `no-such-session-${stamp}`,
  });
  expect(res.status).toBe(404);
});

test("解绑没绑过的会话也返回 ok", async () => {
  const res = await fetch(at("/api/items/bind?session=nobody"), { method: "DELETE" });
  expect(res.status).toBe(200);
});

test("/api/sessions 带上 items 与每条会话的 itemId", async () => {
  const body = (await (await fetch(at("/api/sessions"))).json()) as {
    sessions: { itemId: string | null }[];
    items: unknown[];
  };
  expect(Array.isArray(body.items)).toBe(true);
  for (const s of body.sessions) expect(s.itemId).toBeNull();
});

test("同步返回汇总形状", async () => {
  const res = await json("/api/items/sync", "POST", {});
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["created", "total", "truncated", "updated"]);
});

// 顺序今天并不会被违反：^/api/items/([^/]+)$ 那条只挂在 PATCH 上，这里发的
// 是 POST，就算把 sync 挪到它后面，方法不匹配也会跳过去、照样落到 sync 处
// 理器。留着这条顺序是给将来某条不按方法区分的 :id 路由预留的防护，这个测
// 试因此测的不是"顺序对不对"，而是"sync 这条路由确实可达、确实答出了
// SyncResult 的形状"，不是被当成条目当掉。
test("POST /api/items/sync 落到 sync 处理器，答出 SyncResult 形状", async () => {
  const res = await json("/api/items/sync", "POST", {});
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["created", "total", "truncated", "updated"]);
});

test("刷新不存在的单给 404", async () => {
  const res = await json("/api/items/it-nope/refresh", "POST", {});
  expect(res.status).toBe(404);
});

// 没有来源就没有可刷的东西。
test("刷新一张没有来源的本地单给 404", async () => {
  const created = await makeItem("本地的活");
  const res = await json(`/api/items/${created.id}/refresh`, "POST", {});
  expect(res.status).toBe(404);
});

test("刷新一张来源无人认领的单给 404", async () => {
  const created = await (
    await json("/api/items", "POST", { title: "外星来源", source: { provider: "nobody", ref: "x" } })
  ).json() as { id: string };
  const res = await json(`/api/items/${created.id}/refresh`, "POST", {});
  expect(res.status).toBe(404);
});
