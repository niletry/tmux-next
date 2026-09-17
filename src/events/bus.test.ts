import { test, expect, beforeEach } from "bun:test";
import { publish, subscribe, subscriberCount, replayFrom, bootId, resetBus } from "./bus";

beforeEach(() => resetBus());

test("订阅者收到发布的事件", () => {
  const seen: string[] = [];
  subscribe((e) => seen.push(e.type));
  publish({ type: "session.created", session: "a", data: {} });
  expect(seen).toEqual(["session.created"]);
});

test("取消订阅之后不再收到", () => {
  const seen: string[] = [];
  const off = subscribe((e) => seen.push(e.type));
  off();
  publish({ type: "session.created", session: "a", data: {} });
  expect(seen).toEqual([]);
  expect(subscriberCount()).toBe(0);
});

/**
 * 一个订阅者抛异常不能带走其余订阅者。SSE 扇出和（第 3 期的）Webhook 派发会是同一个
 * 总线上的两个订阅者，让一个接收方的失败静音掉另一个，是那种只在生产环境出现的故障。
 */
test("一个订阅者抛异常不影响其他订阅者", () => {
  const seen: string[] = [];
  subscribe(() => { throw new Error("boom"); });
  subscribe((e) => seen.push(e.type));
  publish({ type: "session.ended", session: "a", data: {} });
  expect(seen).toEqual(["session.ended"]);
});

test("seq 单调递增，id 带上 bootId", () => {
  const first = publish({ type: "session.created", session: "a", data: {} });
  const second = publish({ type: "session.ended", session: "a", data: {} });
  expect(second.seq).toBe(first.seq + 1);
  expect(first.id).toBe(`evt_${bootId()}_${first.seq}`);
});

test("按 Last-Event-ID 补发它之后的事件", () => {
  const first = publish({ type: "session.created", session: "a", data: {} });
  publish({ type: "session.turn", session: "a", data: {} });
  const got = replayFrom(first.id);
  expect(got.ok).toBe(true);
  if (!got.ok) throw new Error("unreachable");
  expect(got.events.map((e) => e.type)).toEqual(["session.turn"]);
});

test("没带 Last-Event-ID 是全新连接，不补发也不要求 resync", () => {
  publish({ type: "session.created", session: "a", data: {} });
  const got = replayFrom(null);
  expect(got).toEqual({ ok: true, events: [] });
});

/**
 * bootId 对不上意味着服务器重启过：seq 从头开始，旧 id 指向的位置在新进程里是另一个
 * 事件。这必须是 resync 而不是"补发 seq 之后的全部"，后者会把不相干的事件当成补发内容
 * 交给客户端，而客户端没有任何办法发现这件事。
 */
test("bootId 对不上要求 resync", () => {
  expect(replayFrom("evt_deadbeef_1")).toEqual({ ok: false });
});

test("形状不对的 Last-Event-ID 要求 resync", () => {
  expect(replayFrom("garbage")).toEqual({ ok: false });
});

/**
 * 注意这里要三条事件才构成缺口。客户端说"我看到第 1 条了"，那么第 1 条自己被挤出
 * 缓冲并不算丢——它要的是第 1 条**之后**的。只有当第 2 条也被挤掉、缓冲里最旧的是
 * 第 3 条时，中间才真的缺了东西。把这个测试写成两条事件会让它在一个正确的实现上
 * 失败，然后逼着人把判断改成"最旧的一条在不在"，那是错的。
 */
test("缺口被挤出缓冲时要求 resync", () => {
  const first = publish({ type: "session.created", session: "a", data: {} }, 1000);
  publish({ type: "session.turn", session: "a", data: {} }, 1000);
  // 缓冲按时间保留 300 秒；把时钟推过窗口，前两条都该被挤掉。
  publish({ type: "session.ended", session: "a", data: {} }, 1000 + 301);
  expect(replayFrom(first.id)).toEqual({ ok: false });
});

/** 挤出的是客户端已经看过的那条，不算缺口，照常补发。 */
test("只挤掉已看过的那条不算缺口", () => {
  const first = publish({ type: "session.created", session: "a", data: {} }, 1000);
  const second = publish({ type: "session.ended", session: "a", data: {} }, 1000 + 301);
  const got = replayFrom(first.id);
  expect(got).toEqual({ ok: true, events: [second] });
});
