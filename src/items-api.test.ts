import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 绝不碰用户的 ~/.tmux-next/。路径在函数体里现读，所以设在 import 之前就够。
const stamp = Math.random().toString(36).slice(2, 10);
process.env.TMUX_NEXT_ITEMS_PATH = join(tmpdir(), `items-test-${stamp}.json`);
process.env.TMUX_NEXT_BINDINGS_PATH = join(tmpdir(), `bindings-test-${stamp}.json`);
// startServer() 启动时会跑一次性的 Jira 绑定迁移；不把它也隔离开的话，本机真实
// 的 ~/.tmux-next/jira/bindings.json 会被读进来，把这份本该是空表的测试数据填满。
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
  expect(await res.json()).toEqual({ items: [], bindings: [] });
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
