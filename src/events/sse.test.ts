import { test, expect, beforeEach, afterEach } from "bun:test";
import { eventsResponse } from "./sse";
import { publish, resetBus, subscriberCount } from "./bus";
import { pollingActive, resetPoller, setPollLister, startPolling } from "./poller";

beforeEach(() => {
  resetBus();
  resetPoller();
  // 没有这一行，`eventsResponse` 里的 `startPolling()` 会去列举真的 tmux 会话，
  // 让这个纯粹的流格式测试依赖开发机上恰好开着什么。
  setPollLister(async () => []);
});
afterEach(() => { resetPoller(); });

/**
 * 读出流里已经落下的字节，不等流结束——SSE 的流永远不会结束。
 *
 * 那个 `pending` 必须跨循环留住。每轮新起一个 `reader.read()` 去 race 的话，上一轮
 * 输给超时的那个 read 依然挂着，它稍后拿到的那块数据再也没人去 await——测试于是
 * 随机丢帧，表现成"偶尔收不到事件"，而实现是好的。
 */
async function drain(res: Response, ms = 60): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  const deadline = Date.now() + ms;
  let pending: ReturnType<typeof reader.read> | null = null;
  while (Date.now() < deadline) {
    pending ??= reader.read();
    const got = await Promise.race([pending, Bun.sleep(15).then(() => "timeout" as const)]);
    if (got === "timeout") continue;
    pending = null;
    if (got.done) break;
    out += decoder.decode(got.value, { stream: true });
  }
  await reader.cancel();
  return out;
}

test("响应头是 SSE 该有的那几个", () => {
  const res = eventsResponse(null);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  // 反代默认会攒够一块再吐，事件流会变成几十秒一批，看起来像服务端不发事件。
  expect(res.headers.get("x-accel-buffering")).toBe("no");
  void res.body!.cancel();
});

test("发布的事件按 SSE 帧格式落到流里", async () => {
  const res = eventsResponse(null);
  const read = drain(res);
  await Bun.sleep(10);
  const event = publish({ type: "session.turn", session: "alpha", data: { turn: "waiting" } });
  const text = await read;
  expect(text).toContain(`id: ${event.id}`);
  expect(text).toContain("event: session.turn");
  expect(text).toContain(`data: ${JSON.stringify(event)}`);
});

test("连上就启动轮询，断开就停", async () => {
  expect(pollingActive()).toBe(false);
  const res = eventsResponse(null);
  await Bun.sleep(10);
  expect(pollingActive()).toBe(true);
  await res.body!.cancel();
  await Bun.sleep(10);
  expect(pollingActive()).toBe(false);
  expect(subscriberCount()).toBe(0);
});

test("带着还在缓冲里的 id 重连会拿到补发", async () => {
  // 轮询得是开着的，否则这次重连按"服务端没在看"处理，拿到的是 resync 而不是补发。
  startPolling({ lister: async () => [], intervalMs: 10_000 });
  const first = publish({ type: "session.created", session: "alpha", data: {} });
  publish({ type: "session.turn", session: "alpha", data: {} });
  const res = eventsResponse(first.id);
  const text = await drain(res);
  expect(text).toContain("event: session.turn");
  expect(text).not.toContain("event: session.created");
});

test("带着认不出来的 id 重连先拿到一条 resync", async () => {
  startPolling({ lister: async () => [], intervalMs: 10_000 });
  const res = eventsResponse("evt_deadbeef_9");
  const text = await drain(res);
  expect(text).toContain("event: resync");
});

/**
 * 头部必须立刻能刷出去。Bun 在流产出第一块之前不会发响应头，而常见路径（新连接、
 * 没有 Last-Event-ID、补发为空）原本一个字节都不写——`EventSource.onopen` 于是要等
 * 到 15 秒后的第一次心跳。这条钉的就是"第一帧不为空"。
 */
test("常见路径也立刻写出第一帧，头部不用等心跳", async () => {
  const res = eventsResponse(null);
  const reader = res.body!.getReader();
  const got = await Promise.race([
    reader.read(),
    Bun.sleep(500).then(() => "timeout" as const),
  ]);
  if (got === "timeout") throw new Error("开流 500ms 内一个字节都没有");
  const text = new TextDecoder().decode(got.value);
  // retry 一并钉死客户端的重连间隔——能说这句话的最早时机就是开流第一帧。
  expect(text).toContain("retry: 3000");
  await reader.cancel();
});

/**
 * resync 帧必须带 `id:`。不带的话浏览器手里那个对不上的 id 原封不动，下一次重连还是
 * resync——在一台安静的机器上就是永远 resync。
 */
test("resync 帧带上本进程的 id，把客户端挪到新编号上", async () => {
  startPolling({ lister: async () => [], intervalMs: 10_000 });
  const event = publish({ type: "session.turn", session: "alpha", data: {} });
  const res = eventsResponse("evt_deadbeef_9");
  const text = await drain(res);
  expect(text).toContain("event: resync");
  expect(text).toContain(`id: ${event.id}\nevent: resync`);
});

/**
 * 轮询停着的那段时间里发生的变化被起步的静默填快照吸收，一条事件都没发过——于是
 * `replayFrom` 会回答"你没错过什么"，而那是假的。服务端没资格认一个它没在看的时间段。
 */
test("轮询停着时重连按跟丢处理，即使 id 还在缓冲里", async () => {
  const first = publish({ type: "session.created", session: "alpha", data: {} });
  publish({ type: "session.turn", session: "alpha", data: {} });
  expect(pollingActive()).toBe(false);
  const res = eventsResponse(first.id);
  const text = await drain(res);
  expect(text).toContain("event: resync");
  expect(text).not.toContain("event: session.turn");
});

/** 但没带 id 的新连接不受影响：它本来就没有"错过"可言。 */
test("没带 id 的新连接不会平白拿到 resync", async () => {
  expect(pollingActive()).toBe(false);
  const res = eventsResponse(null);
  const text = await drain(res);
  expect(text).not.toContain("event: resync");
});

test("两个订阅者各自收到同一条事件", async () => {
  const a = eventsResponse(null);
  const b = eventsResponse(null);
  const readA = drain(a);
  const readB = drain(b);
  await Bun.sleep(10);
  publish({ type: "session.ended", session: "alpha", data: {} });
  expect(await readA).toContain("event: session.ended");
  expect(await readB).toContain("event: session.ended");
});

/**
 * `cancel()` 里"退订"和"数到零才停轮询"这两步的顺序是这个模块唯一容易悄悄错掉的
 * 地方：谁先谁后不会让任何一次单订阅者测试变红，但顺序错了或者漏掉计数判断，
 * 后果是轮询在还有人订阅的时候停了——流没报错、心跳照样在跳，事件就是再也不来。
 * 这条测试专门盯住"还有一个订阅者在场时不能停轮询"这件事。
 */
test("两个订阅者，一个断开不影响另一个，轮询要等两个都走了才停", async () => {
  const a = eventsResponse(null);
  const b = eventsResponse(null);
  await Bun.sleep(10);
  expect(pollingActive()).toBe(true);
  expect(subscriberCount()).toBe(2);

  await a.body!.cancel();
  await Bun.sleep(10);
  expect(pollingActive()).toBe(true);
  expect(subscriberCount()).toBe(1);

  await b.body!.cancel();
  await Bun.sleep(10);
  expect(pollingActive()).toBe(false);
  expect(subscriberCount()).toBe(0);
});
