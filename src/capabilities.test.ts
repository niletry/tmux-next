import { test, expect, afterAll } from "bun:test";
import { startServer } from "./server";

const server = startServer(0);
afterAll(() => server.stop());

const base = () => `http://127.0.0.1:${server.port}`;

/**
 * 能力声明代替 URL 版本号。真正会发生的不一致不是"第三方没跟上"，而是手机上的
 * App 和机器上的服务端版本对不上——服务端是 npm 包由用户自己升级，客户端要过应用
 * 商店审核。`/api/v1` 解决不了这个；一份"我实际支持什么"的清单可以。
 */
test("能力端点列出本期已经存在的事件类型", async () => {
  const res = await fetch(`${base()}/api/capabilities`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.events).toContain("session.turn");
  expect(body.events).toContain("session.created");
  expect(body.streamEvents).toContain("resync");
  expect(body.features).toContain("sse");
});

/** 版本要跟 /api/version 说的是同一个，否则客户端会拿到两个都像真的答案。 */
test("版本与 /api/version 一致", async () => {
  const [caps, version] = await Promise.all([
    fetch(`${base()}/api/capabilities`).then((r) => r.json()),
    fetch(`${base()}/api/version`).then((r) => r.json()),
  ]);
  expect(caps.version).toBe(version.version);
  expect(caps.build).toBe(version.build);
});

/**
 * 本期还没做的能力不能出现在清单里。一个提前写上的名字比没有这个端点更糟：客户端
 * 会据此走上一条不存在的路径，而它本可以降级。
 */
test("未实现的能力不出现在清单里", async () => {
  const body = await fetch(`${base()}/api/capabilities`).then((r) => r.json());
  expect(body.features).not.toContain("webhooks");
  expect(body.features).not.toContain("batch-input");
});
