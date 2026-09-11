import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHistory, recordBind, recordUnbind, recordDead, historyForItem } from "./session-history";

let root: string;
let saved: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "session-history-"));
  saved = process.env.TMUX_NEXT_SESSION_HISTORY_PATH;
  process.env.TMUX_NEXT_SESSION_HISTORY_PATH = join(root, "session-history.json");
});

afterEach(async () => {
  if (saved === undefined) delete process.env.TMUX_NEXT_SESSION_HISTORY_PATH;
  else process.env.TMUX_NEXT_SESSION_HISTORY_PATH = saved;
  await rm(root, { recursive: true, force: true });
});

test("没有文件时读出空表", async () => {
  expect(await readHistory()).toEqual([]);
});

test("recordBind 写一条 open 记录", async () => {
  await recordBind("修登录页", "it-1", "$7");
  const all = await readHistory();
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({ itemId: "it-1", session: "修登录页", sessionId: "$7", endedAt: null });
  expect(typeof all[0]?.boundAt).toBe("number");
});

test("同一 session 换绑到新单，旧记录被关闭、新记录 open", async () => {
  await recordBind("跑测试", "it-1", "$7");
  await recordBind("跑测试", "it-2", "$7");
  const all = await readHistory();
  expect(all).toHaveLength(2);
  const old = all.find((e) => e.itemId === "it-1");
  const fresh = all.find((e) => e.itemId === "it-2");
  expect(old?.endedAt).not.toBeNull();
  expect(fresh?.endedAt).toBeNull();
});

test("recordUnbind 关闭这条 session 的 open 记录，不影响别的 session", async () => {
  await recordBind("甲", "it-1", "$1");
  await recordBind("乙", "it-1", "$2");
  await recordUnbind("甲");
  const all = await readHistory();
  const a = all.find((e) => e.session === "甲");
  const b = all.find((e) => e.session === "乙");
  expect(a?.endedAt).not.toBeNull();
  expect(b?.endedAt).toBeNull();
});

test("recordUnbind 对没有 open 记录的 session 什么都不做", async () => {
  await recordUnbind("不存在的会话");
  expect(await readHistory()).toEqual([]);
});

test("recordDead 关闭指定会话的 open 记录", async () => {
  await recordBind("甲", "it-1", "$1");
  await recordBind("乙", "it-1", "$2");
  await recordDead(["甲"]);
  const all = await readHistory();
  const a = all.find((e) => e.session === "甲");
  const b = all.find((e) => e.session === "乙");
  expect(a?.endedAt).not.toBeNull();
  expect(b?.endedAt).toBeNull();
});

test("historyForItem 只返回该单已关闭的记录，不含仍 open 的", async () => {
  await recordBind("甲", "it-1", "$1");
  await recordBind("乙", "it-1", "$2");
  await recordUnbind("甲");
  const closed = await historyForItem("it-1");
  expect(closed.map((e) => e.session)).toEqual(["甲"]);
});

test("historyForItem 按结束时间倒序（最近的在前）", async () => {
  await recordBind("甲", "it-1", "$1");
  await recordUnbind("甲");
  await recordBind("乙", "it-1", "$2");
  await recordUnbind("乙");
  const closed = await historyForItem("it-1");
  expect(closed.map((e) => e.session)).toEqual(["乙", "甲"]);
});
