import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 绝不碰用户的 ~/.tmux-next/。
const stamp = Math.random().toString(36).slice(2, 10);
process.env.TMUX_NEXT_TEMPLATES_PATH = join(tmpdir(), `templates-api-${stamp}.json`);
process.env.TMUX_NEXT_ITEMS_PATH = join(tmpdir(), `templates-api-items-${stamp}.json`);
process.env.TMUX_NEXT_BINDINGS_PATH = join(tmpdir(), `templates-api-bindings-${stamp}.json`);
process.env.TMUX_NEXT_JIRA_DIR = join(tmpdir(), `templates-api-jira-${stamp}`);

import { rm } from "node:fs/promises";
import { startServer } from "./server";

let server: { stop(): void; port: number };
const at = (path: string) => `http://127.0.0.1:${server.port}${path}`;

const json = (path: string, method: string, body: unknown) =>
  fetch(at(path), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function makeItem(title: string, extra: Record<string, unknown> = {}) {
  const res = await json("/api/items", "POST", { title, ...extra });
  return (await res.json()) as { id: string };
}

beforeAll(() => {
  server = startServer(0);
});

afterAll(async () => {
  server.stop();
  await rm(process.env.TMUX_NEXT_TEMPLATES_PATH!, { force: true });
  await rm(process.env.TMUX_NEXT_ITEMS_PATH!, { force: true });
  await rm(process.env.TMUX_NEXT_BINDINGS_PATH!, { force: true });
});

afterEach(async () => {
  await rm(process.env.TMUX_NEXT_TEMPLATES_PATH!, { force: true });
  await rm(process.env.TMUX_NEXT_ITEMS_PATH!, { force: true });
});

test("空清单时 GET 给空数组", async () => {
  const body = await (await fetch(at("/api/templates"))).json();
  expect(body.templates).toEqual([]);
});

// 设置页要把可用字段列给模板作者，键名从服务端来，不在页面里再抄一份。
test("GET 带上内核字段名", async () => {
  const body = await (await fetch(at("/api/templates"))).json();
  expect(body.fieldKeys).toContain("item.title");
  expect(body.fieldKeys).toContain("item.ref");
});

test("PUT 写进去，GET 读得到", async () => {
  const put = await json("/api/templates", "PUT", {
    templates: [{ label: "修 bug", name: "{item.ref}", input: "修 {item.title}" }],
  });
  expect(put.status).toBe(200);
  const body = await (await fetch(at("/api/templates"))).json();
  expect(body.templates.length).toBe(1);
  expect(body.templates[0].label).toBe("修 bug");
  expect(body.templates[0].id).toMatch(/^tpl-/);
});

test("PUT 的坏 JSON 是 400", async () => {
  const res = await fetch(at("/api/templates"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "{ not json",
  });
  expect(res.status).toBe(400);
});

test("PUT 回的是净化之后的那一份", async () => {
  const res = await json("/api/templates", "PUT", {
    templates: [{ label: "好的", name: "", input: "" }, { label: "  ", name: "", input: "" }],
  });
  const body = await res.json();
  expect(body.templates.length).toBe(1);
});

test("render 把两段模板都渲染出来", async () => {
  const item = await makeItem("修登录页", { source: { provider: "jira", ref: "EXAMPLE-1" } });
  const res = await json(`/api/items/${item.id}/render`, "POST", {
    name: "{item.ref}",
    input: "看一下 {item.title}",
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ name: "EXAMPLE-1", input: "看一下 修登录页" });
});

test("render 对本地单也能用，来源那几格渲染成空并删行", async () => {
  const item = await makeItem("随手记一件事");
  const res = await json(`/api/items/${item.id}/render`, "POST", {
    name: "{item.title}",
    input: "单号：{item.ref}\n做 {item.title}",
  });
  expect(await res.json()).toEqual({ name: "随手记一件事", input: "做 随手记一件事" });
});

// 会话名要能真的当会话名用：tmux 把 . 和 : 当 session:window.pane 的分隔符，带上它们的
// 会话之后连 kill 都 kill 不掉。所以框里显示的必须是净化之后的那一版。
test("render 的会话名过了净化，点号被剔除", async () => {
  const item = await makeItem("修登录页.v2");
  const res = await json(`/api/items/${item.id}/render`, "POST", {
    name: "{item.title}",
    input: "",
  });
  expect((await res.json()).name).toBe("修登录页v2");
});

test("单不存在是 404", async () => {
  const res = await json("/api/items/it-nope/render", "POST", { name: "x", input: "y" });
  expect(res.status).toBe(404);
});

test("render 的坏 JSON 是 400", async () => {
  const item = await makeItem("x");
  const res = await fetch(at(`/api/items/${item.id}/render`), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  expect(res.status).not.toBe(200);
});
