import { afterAll, beforeAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TMUX_NEXT_GALLERY_DIR = join(
  tmpdir(),
  `plugroute-test-${Math.random().toString(36).slice(2, 10)}`,
);

import { mkdirSync, writeFileSync } from "node:fs";
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
