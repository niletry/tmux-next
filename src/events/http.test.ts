import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { test, expect, afterAll, beforeEach, afterEach } from "bun:test";

// 先改环境变量再 import server：所有落盘路径都是在函数里惰性读的，这样这个文件
// 一个字节也不会写到用户真实的 ~/.tmux-next/。和 notify-bus.test.ts 同一套。
const tmp = (name: string, ext = "") =>
  joinPath(tmpdir(), `${name}-events-http-${Math.random().toString(36).slice(2, 10)}${ext}`);

process.env.TMUX_NEXT_KEY_USAGE_PATH = tmp("ku", ".json");
process.env.TMUX_NEXT_GALLERY_DIR = tmp("gallery");
process.env.TMUX_NEXT_PINS_PATH = tmp("pins", ".json");
process.env.TMUX_NEXT_SESSIONS_DIR = tmp("sessions");
process.env.CLAUDE_PROJECTS_DIR = tmp("projects");
process.env.TMUX_NEXT_PUSH_DIR = tmp("push");
process.env.TMUX_NEXT_VAPID_PATH = tmp("vapid", ".json");
process.env.TMUX_NEXT_NOTIFICATIONS_PATH = tmp("notif", ".jsonl");
process.env.TMUX_NEXT_LANG_PATH = tmp("lang", ".json");
process.env.TMUX_NEXT_THEME_PATH = tmp("theme", ".json");
process.env.TMUX_NEXT_ITEMS_PATH = tmp("items", ".json");
process.env.TMUX_NEXT_BINDINGS_PATH = tmp("bindings", ".json");

import { startServer } from "../server";
import { publish, resetBus, subscriberCount } from "./bus";
import { pollingActive, resetPoller, setPollLister } from "./poller";

/**
 * 真的走一遍 HTTP。
 *
 * 在这之前每条事件流的测试都在进程内直接调 `eventsResponse()`——路由有没有接上、
 * 响应头到底什么时候被刷出去、客户端真的断开时 `cancel()` 到底会不会被调用，全都
 * 没有任何东西验证过。「常见路径上流一个字节都不写，于是响应头晚 15 秒才到」这个
 * 缺陷就藏在这个缝里：进程内调用拿到的是 `Response` 对象，头本来就在手上。
 */
const server = startServer(0);
afterAll(() => server.stop());

beforeEach(() => {
  resetBus();
  resetPoller();
  // 没有这一行，`/api/events` 会去列举开发机上真实的 tmux 会话。
  setPollLister(async () => []);
});
afterEach(() => resetPoller());

const url = () => `http://127.0.0.1:${server.port}/api/events`;

test("响应头在心跳之前很久就到了", async () => {
  const started = Date.now();
  const ctrl = new AbortController();
  const res = await fetch(url(), { signal: ctrl.signal });
  const elapsed = Date.now() - started;

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  // 心跳是 15 秒。头部要是等第一次心跳，这里就是 15000 上下；开流先垫一帧是 2ms 级。
  // 一秒这个阈值宽到不会因为机器慢而飘，又远小于任何"其实在等心跳"的情形。
  expect(elapsed).toBeLessThan(1000);

  ctrl.abort();
  await Bun.sleep(30);
});

test("开流第一帧里有 retry，客户端的重连间隔由服务端定", async () => {
  const ctrl = new AbortController();
  const res = await fetch(url(), { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain("retry: 3000");
  ctrl.abort();
  await Bun.sleep(30);
});

test("发布的事件成帧送到真实客户端手里", async () => {
  const ctrl = new AbortController();
  const res = await fetch(url(), { signal: ctrl.signal });
  const reader = res.body!.getReader();
  await reader.read(); // 开流那一帧
  await Bun.sleep(20);

  const event = publish({ type: "session.turn", session: "alpha", data: { turn: "waiting" } });

  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && !text.includes("event: session.turn")) {
    const got = await Promise.race([
      reader.read(),
      Bun.sleep(50).then(() => "timeout" as const),
    ]);
    if (got === "timeout") break;
    if (got.done) break;
    text += decoder.decode(got.value, { stream: true });
  }
  expect(text).toContain(`id: ${event.id}`);
  expect(text).toContain("event: session.turn");

  ctrl.abort();
  await Bun.sleep(30);
});

/**
 * 真实的断开——不是在进程内调 `body.cancel()`，而是客户端把 TCP 连接掐了——必须
 * 走到 `cancel()`：退订，并且在最后一个订阅者走掉时停掉轮询。少了这一步，每一次
 * 断线重连都留下一个死订阅者，而轮询永远跑着。
 */
test("客户端中止请求会退订并停掉轮询", async () => {
  const ctrl = new AbortController();
  const res = await fetch(url(), { signal: ctrl.signal });
  const reader = res.body!.getReader();
  await reader.read();
  await Bun.sleep(20);
  expect(subscriberCount()).toBe(1);
  expect(pollingActive()).toBe(true);

  ctrl.abort();
  await Bun.sleep(100);
  expect(subscriberCount()).toBe(0);
  expect(pollingActive()).toBe(false);
});
