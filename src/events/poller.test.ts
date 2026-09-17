import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  pollOnce, startPolling, stopPolling, pollingActive, setPollLister, resetPoller,
} from "./poller";
import { subscribe, resetBus, type AppEvent } from "./bus";
import type { SessionSummary } from "../tmux/session-list";

function session(sessionId: string, name: string, turn: SessionSummary["turn"] = null): SessionSummary {
  return {
    sessionId, name, windowWidth: 80, windowHeight: 24, lastActivityEpoch: 0,
    attached: false, preview: [], pendingInput: null, idle: false, pinned: false,
    claudeId: null, task: null, path: "/tmp", lastAction: null, turn,
    agent: null, agentLabel: null, version: null,
  };
}

beforeEach(() => { resetBus(); resetPoller(); });
afterEach(() => { stopPolling(); });

test("一轮比对把差异发布到总线", async () => {
  const seen: AppEvent[] = [];
  subscribe((e) => seen.push(e));
  await pollOnce(async () => [session("$1", "alpha")]);
  expect(seen.map((e) => e.type)).toEqual(["session.created"]);
});

/** 快照是跨轮保留的，否则每一轮都会把所有会话重新报一遍 created。 */
test("第二轮没有变化就不发事件", async () => {
  const seen: AppEvent[] = [];
  subscribe((e) => seen.push(e));
  const lister = async () => [session("$1", "alpha")];
  await pollOnce(lister);
  await pollOnce(lister);
  expect(seen.length).toBe(1);
});

test("状态变了第二轮才发 turn", async () => {
  const seen: AppEvent[] = [];
  subscribe((e) => seen.push(e));
  await pollOnce(async () => [session("$1", "alpha", "working")]);
  await pollOnce(async () => [session("$1", "alpha", "waiting")]);
  expect(seen.map((e) => e.type)).toEqual(["session.created", "session.turn"]);
});

/**
 * 列举失败不能让循环死掉。tmux 可能正在重启，下一轮就好了；把这一轮的异常放出去会
 * 让定时器永久停摆，而症状是事件流安静下来，没有任何东西报错。
 */
test("列举抛异常时这一轮无事发生，不抛出去", async () => {
  const count = await pollOnce(async () => { throw new Error("tmux gone"); });
  expect(count).toBe(0);
});

test("列举失败不会清空快照", async () => {
  const seen: AppEvent[] = [];
  subscribe((e) => seen.push(e));
  await pollOnce(async () => [session("$1", "alpha")]);
  await pollOnce(async () => { throw new Error("tmux gone"); });
  await pollOnce(async () => [session("$1", "alpha")]);
  // 若失败那轮把快照清了，第三轮会再报一次 created。
  expect(seen.map((e) => e.type)).toEqual(["session.created"]);
});

/**
 * 起步时快照是空的，而机器上通常已经有十几个会话。若第一轮照常发布，刚连上的客户端
 * 会收到一串 `session.created`，说的是一件没有发生过的事——它们不是刚创建的，只是
 * 这个进程第一次看见。所以第一轮只填快照、不发事件。
 */
test("启动时先静默填一次快照，不把已有会话报成新生", async () => {
  const seen: AppEvent[] = [];
  subscribe((e) => seen.push(e));
  await pollOnce(async () => [session("$1", "alpha")], false);
  expect(seen).toEqual([]);
  // 但快照要填上了：下一轮的变化才是真变化。
  await pollOnce(async () => [session("$1", "alpha", "waiting")]);
  expect(seen.map((e) => e.type)).toEqual(["session.turn"]);
});

test("startPolling 会先静默填一次快照", async () => {
  const seen: AppEvent[] = [];
  subscribe((e) => seen.push(e));
  startPolling({ lister: async () => [session("$1", "alpha")], intervalMs: 10_000 });
  await Bun.sleep(20);
  expect(seen).toEqual([]);
});

test("setPollLister 注入的列举器会被 startPolling 采用", async () => {
  let calls = 0;
  setPollLister(async () => { calls += 1; return []; });
  startPolling({ intervalMs: 10_000 });
  await Bun.sleep(20);
  expect(calls).toBe(1);
});

test("启动和停止改变 pollingActive", () => {
  expect(pollingActive()).toBe(false);
  startPolling({ lister: async () => [], intervalMs: 10_000 });
  expect(pollingActive()).toBe(true);
  stopPolling();
  expect(pollingActive()).toBe(false);
});

/**
 * 用"填快照那一次列举跑了几遍"来判断，而不是用事件条数：起步的静默填充之后，一个
 * 没有变化的机器不会再产生任何事件，数事件就什么也数不出来。间隔设得远大于测试时长，
 * 于是唯一会发生的列举就是各自的起步填充——第二次 startPolling 一次都不该加。
 */
test("重复启动不会叠加出第二个定时器", async () => {
  let calls = 0;
  const lister = async () => { calls += 1; return [session("$1", "alpha")]; };
  startPolling({ lister, intervalMs: 10_000 });
  startPolling({ lister, intervalMs: 10_000 });
  await Bun.sleep(20);
  expect(calls).toBe(1);
  expect(pollingActive()).toBe(true);
});

test("停止之后不再产生事件", async () => {
  const seen: AppEvent[] = [];
  subscribe((e) => seen.push(e));
  let calls = 0;
  startPolling({ lister: async () => { calls += 1; return []; }, intervalMs: 10 });
  await Bun.sleep(35);
  stopPolling();
  const after = calls;
  await Bun.sleep(35);
  expect(calls).toBe(after);
});
