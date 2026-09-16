import { afterAll, beforeAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TMUX_NEXT_GALLERY_DIR = join(
  tmpdir(),
  `plugroute-test-${Math.random().toString(36).slice(2, 10)}`,
);
process.env.TMUX_NEXT_JIRA_DIR = join(
  tmpdir(),
  `jira-test-${Math.random().toString(36).slice(2, 10)}`,
);

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { startServer } from "./server";
import { pluginStateDir } from "../plugins/state";
import { enabledPlugins } from "../plugins/handlers";

let server: { stop(): void; port: number };
const base = () => `http://127.0.0.1:${server.port}`;

beforeAll(() => {
  mkdirSync(process.env.TMUX_NEXT_GALLERY_DIR!, { recursive: true });
  writeFileSync(join(process.env.TMUX_NEXT_GALLERY_DIR!, "a.png"), "png");
  server = startServer(0);
});
afterAll(() => server.stop());

test("/api/plugins 报出启用的插件", async () => {
  const ids = (await (await fetch(`${base()}/api/plugins`)).json()) as string[];
  expect(ids).toContain("gallery");
});

test("插件的路由挂在自己的前缀下", async () => {
  const res = await fetch(`${base()}/api/gallery`);
  expect(res.status).toBe(200);
  const items = (await res.json()) as { name: string }[];
  expect(items.map((i) => i.name)).toContain("a.png");
});

test("插件不认的子路径落到 404，而不是被它吞掉", async () => {
  const res = await fetch(`${base()}/api/gallery/nonesuch`);
  expect(res.status).toBe(404);
});

// 设置页那颗动作按钮（比如 Jira 的「完整同步」）。这里的 TMUX_NEXT_JIRA_DIR 是
// 一个全新的临时目录、没有 config.json，所以声明过的动作也答 false——这条断言
// 要的不是"同步真的成功了"，而是"请求真的落到了这条路由、答的是 {ok:boolean}"。
test("声明过的插件动作会被调用，答 { ok }", async () => {
  const res = await fetch(`${base()}/api/plugins/jira/actions/full-sync`, { method: "POST" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: false });
});

// 清单没声明的动作键不能碰到插件——跟 savePluginSettings 只认声明过的配置键
// 是同一道闸门，这里断言的是路由把它挡在了内核这一侧，从不落到 404（跟 settings
// 路由不同：这条路由从不 404，一律 200 { ok: false }）。
test("没声明的动作键不会落到插件", async () => {
  const res = await fetch(`${base()}/api/plugins/jira/actions/not-a-real-action`, {
    method: "POST",
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: false });
});

test("状态目录可以用 env 顶掉，且惰性读取", () => {
  // 惰性：这个 env 是在文件顶部、import 之前设的，模块加载时若捕获了值，
  // 下面这两行就会读到 home 底下的真实目录——正是 CLAUDE.md 里那条规矩。
  expect(pluginStateDir("gallery")).toBe(process.env.TMUX_NEXT_GALLERY_DIR!);
  process.env.TMUX_NEXT_DEMO_DIR = "/tmp/demo-state";
  expect(pluginStateDir("demo")).toBe("/tmp/demo-state");
  delete process.env.TMUX_NEXT_DEMO_DIR;
});

test("带连字符的 id 映射成带下划线的 env 名", () => {
  process.env.TMUX_NEXT_TWO_WORDS_DIR = "/tmp/two-words";
  expect(pluginStateDir("two-words")).toBe("/tmp/two-words");
  delete process.env.TMUX_NEXT_TWO_WORDS_DIR;
});

test("插件页面从 /p/<id>/ 出", async () => {
  const res = await fetch(`${base()}/p/gallery/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("html");
  expect(await res.text()).toContain('data-i18n="gallery.title"');
});

test("插件页面的脚本也出得来", async () => {
  const res = await fetch(`${base()}/p/gallery/gallery.js`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("javascript");
});

test("爬不出插件的 public 目录", async () => {
  // 浏览器会先把 ../ 规范化掉，但裸客户端不会——服务端自己得拒。
  for (const evil of [
    "/p/gallery/../../src/server.ts",
    "/p/gallery/..%2F..%2Fsrc%2Fserver.ts",
    "/p/gallery/.env",
  ]) {
    const res = await fetch(base() + evil);
    expect({ evil, ok: res.status === 200 }).toEqual({ evil, ok: false });
  }
});

test("不存在的插件 id 是 404", async () => {
  expect((await fetch(`${base()}/p/nosuch/`)).status).toBe(404);
});

test("旧地址 301 到新地址", async () => {
  const res = await fetch(`${base()}/gallery.html`, { redirect: "manual" });
  expect(res.status).toBe(301);
  expect(res.headers.get("location")).toBe("p/gallery/");
});

test("禁用一个插件，它的 API 就不在了", () => {
  const before = enabledPlugins().map((p) => p.id);
  expect(before).toContain("gallery");
  process.env.TMUX_NEXT_DISABLE_PLUGINS = "gallery";
  try {
    expect(enabledPlugins().map((p) => p.id)).not.toContain("gallery");
  } finally {
    delete process.env.TMUX_NEXT_DISABLE_PLUGINS;
  }
  // env 清掉就回来——说明它是每次调用现读的，不是加载时定死的。
  expect(enabledPlugins().map((p) => p.id)).toContain("gallery");
});

test("禁用后 API 和页面双双 404，重新启用后双双恢复", async () => {
  process.env.TMUX_NEXT_DISABLE_PLUGINS = "gallery";
  try {
    expect((await fetch(`${base()}/api/gallery`)).status).toBe(404);
    expect((await fetch(`${base()}/p/gallery/`)).status).toBe(404);
  } finally {
    delete process.env.TMUX_NEXT_DISABLE_PLUGINS;
  }
  // enabledPlugins() 是逐请求现读的，env 一撤，两处都得原样恢复。
  expect((await fetch(`${base()}/api/gallery`)).status).toBe(200);
  expect((await fetch(`${base()}/p/gallery/`)).status).toBe(200);
});

test("通知页也是个插件：API、页面、顶栏三处都在", async () => {
  const ids = (await (await fetch(`${base()}/api/plugins`)).json()) as string[];
  expect(ids).toContain("notifications");
  expect((await fetch(`${base()}/api/notifications`)).status).toBe(200);
  expect((await fetch(`${base()}/p/notifications/`)).status).toBe(200);
  const old = await fetch(`${base()}/notifications.html`, { redirect: "manual" });
  expect(old.status).toBe(301);
  expect(old.headers.get("location")).toBe("p/notifications/");
});

test("jira 插件挂在自己的前缀下，未配置时如实说未配置", async () => {
  const ids = (await (await fetch(`${base()}/api/plugins`)).json()) as string[];
  expect(ids).toContain("jira");

  // 这个测试进程没有 config.json（TMUX_NEXT_JIRA_DIR 指向临时目录），
  // 所以这里检的是"没配置"这条路径，而不是去打真实的 Jira。
  const cfg = await (await fetch(`${base()}/api/jira/config`)).json();
  expect(cfg).toEqual({ configured: false });
});

test("配置接口从不回显 token", async () => {
  const text = await (await fetch(`${base()}/api/jira/config`)).text();
  expect(text).not.toContain("token");
});

test("已配置时，配置接口也从不回显 token", async () => {
  // 上一条测试跑的是未配置路径——那条路径下不管回不回显 token 都会通过，因为
  // 响应体里压根没有这个字段。真正要防的是已配置分支，所以这里单独造一份配置。
  //
  // 配置写进*另一个*临时目录，只在这个测试期间把 TMUX_NEXT_JIRA_DIR 指过去、
  // 用完立刻在 finally 里指回来并删掉临时目录——readJiraConfig() 是逐次现读
  // 路径的，指针一恢复，同文件里后面那条"未配置"断言（issues 端点）就不会因为
  // 残留的 config.json 被拖去真的打 Jira。
  const dir = mkdtempSync(join(tmpdir(), "jira-configured-test-"));
  const token = "example-token-not-a-real-secret";
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      url: "https://example.atlassian.net",
      email: "dev@example.com",
      token,
    }),
  );
  const prevDir = process.env.TMUX_NEXT_JIRA_DIR;
  process.env.TMUX_NEXT_JIRA_DIR = dir;
  try {
    const res = await fetch(`${base()}/api/jira/config`);
    const text = await res.text();
    expect(text).not.toContain(token);
    const body = JSON.parse(text);
    expect(body).toEqual({
      configured: true,
      url: "https://example.atlassian.net",
      email: "dev@example.com",
    });
  } finally {
    process.env.TMUX_NEXT_JIRA_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("没有页面的插件，/p/<id>/ 301 到首页", async () => {
  // jira 退役了自己的页面：清单没有 page，目录里也没有 public/index.html。
  const res = await fetch(`${base()}/p/jira/`, { redirect: "manual" });
  expect(res.status).toBe(301);
  expect(res.headers.get("location")).toBe("../../");
  const idx = await fetch(`${base()}/p/jira/index.html`, { redirect: "manual" });
  expect(idx.status).toBe(301);
});

test("没有页面的插件不在 /api/plugins 之外多出任何页面资源", async () => {
  expect((await fetch(`${base()}/p/jira/jira.js`)).status).toBe(404);
});

test("插件不认识的子路径落到 404", async () => {
  expect((await fetch(`${base()}/api/jira/nonesuch`)).status).toBe(404);
});
