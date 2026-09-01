import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBindings, bindSession, unbindSession, resolveBindings } from "./session-binding";

/**
 * 按**会话**作键：一张单可以有多个会话（会话名唯一，单不唯一），反过来存则每次
 * 会话改名或消亡都要去数组里翻。
 *
 * 名字与 sessionId 都存，是为了改名：id 跨改名不变、跨 tmux server 重启会重排；
 * 名字反过来。两个都存、id 优先名字兜底，各覆盖一半，于是内核不必长出一个"会话
 * 改名事件"。
 */

let root: string;
let saved: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "binding-"));
  saved = process.env.TMUX_NEXT_BINDINGS_PATH;
  process.env.TMUX_NEXT_BINDINGS_PATH = join(root, "bindings.json");
});

afterEach(async () => {
  if (saved === undefined) delete process.env.TMUX_NEXT_BINDINGS_PATH;
  else process.env.TMUX_NEXT_BINDINGS_PATH = saved;
  await rm(root, { recursive: true, force: true });
});

test("没有文件时读出空表", async () => {
  expect(await readBindings()).toEqual({});
});

test("坏 JSON 读成空表，不抛", async () => {
  await writeFile(join(root, "bindings.json"), "{ not json");
  expect(await readBindings()).toEqual({});
});

test("没有 itemId 的记录被丢掉", async () => {
  await writeFile(
    join(root, "bindings.json"),
    JSON.stringify({ 甲: { itemId: "it-1", sessionId: "$1" }, 乙: { sessionId: "$2" } }),
  );
  expect(Object.keys(await readBindings())).toEqual(["甲"]);
});

test("绑定写得进读得回", async () => {
  await bindSession("修登录页", "it-1", "$7");
  const all = await readBindings();
  expect(all["修登录页"]?.itemId).toBe("it-1");
  expect(all["修登录页"]?.sessionId).toBe("$7");
  expect(typeof all["修登录页"]?.boundAt).toBe("number");
});

// 设计的轴心：一张单多个会话是常态，不是边角情况。
test("同一张单可以绑多个会话", async () => {
  await bindSession("跑测试", "it-1", "$7");
  await bindSession("改代码", "it-1", "$8");
  const all = await readBindings();
  expect(all["跑测试"]?.itemId).toBe("it-1");
  expect(all["改代码"]?.itemId).toBe("it-1");
});

test("解绑只解那一条", async () => {
  await bindSession("甲", "it-1", "$1");
  await bindSession("乙", "it-1", "$2");
  await unbindSession("甲");
  expect(Object.keys(await readBindings())).toEqual(["乙"]);
});

test("并发绑三个会话，一条都不丢", async () => {
  await Promise.all([
    bindSession("甲", "it-1", "$1"),
    bindSession("乙", "it-1", "$2"),
    bindSession("丙", "it-2", "$3"),
  ]);
  expect(Object.keys(await readBindings()).sort()).toEqual(["丙", "乙", "甲"].sort());
});

test("活着的会话解析为 live", async () => {
  await bindSession("甲", "it-1", "$1");
  const out = await resolveBindings([{ name: "甲", sessionId: "$1" }]);
  expect(out).toEqual([{ session: "甲", itemId: "it-1", live: true }]);
});

// 会话没了的绑定**不删**：这个仓库有会话恢复机制，一条指向已死会话的绑定恰好是
// "这张单之前开过，要不要恢复"。自动删会把那个入口一起删掉。
test("会话没了仍然留着记录，只是 live 为 false", async () => {
  await bindSession("甲", "it-1", "$1");
  const out = await resolveBindings([]);
  expect(out).toEqual([{ session: "甲", itemId: "it-1", live: false }]);
  expect(Object.keys(await readBindings())).toEqual(["甲"]);
});

test("改过名的会话按 id 认回来，并迁到新名字下", async () => {
  await bindSession("旧名", "it-1", "$7");
  const out = await resolveBindings([{ name: "新名", sessionId: "$7" }]);
  expect(out).toEqual([{ session: "新名", itemId: "it-1", live: true }]);
  const all = await readBindings();
  expect(all["新名"]?.itemId).toBe("it-1");
  expect(all["旧名"]).toBeUndefined();
});

test("id 对不上时按名字兜底", async () => {
  // tmux server 重启后 id 会重排，这时只剩名字能认。
  await bindSession("甲", "it-1", "$7");
  const out = await resolveBindings([{ name: "甲", sessionId: "$99" }]);
  expect(out).toEqual([{ session: "甲", itemId: "it-1", live: true }]);
});
