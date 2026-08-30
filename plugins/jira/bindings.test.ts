import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBindings, bindSession, unbindSession, resolveBindings } from "./bindings";

/**
 * 绑定按**会话**作键，因为一个单可以有多个会话——这是整个设计的轴心，反过来存
 * （工单 → 会话数组）每次会话改名或消亡都要去数组里翻。
 *
 * 名字和会话 id 都存，是为了改名：#{session_id} 跨改名不变、跨 tmux server 重启
 * 会重排；名字反过来。两个都存，各覆盖一半，就不必给插件接缝再开一个"会话改名
 * 事件"的口子。
 */

let root: string;
let saved: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jira-bind-"));
  saved = process.env.TMUX_NEXT_JIRA_DIR;
  process.env.TMUX_NEXT_JIRA_DIR = root;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.TMUX_NEXT_JIRA_DIR;
  else process.env.TMUX_NEXT_JIRA_DIR = saved;
  await rm(root, { recursive: true, force: true });
});

test("没有文件时读出空表", async () => {
  expect(await readBindings()).toEqual({});
});

test("坏 JSON 读成空表，不抛", async () => {
  await writeFile(join(root, "bindings.json"), "{ not json");
  expect(await readBindings()).toEqual({});
});

test("绑定写得进读得回", async () => {
  await bindSession("修登录页", "EXAMPLE-1", "$7");
  const all = await readBindings();
  expect(all["修登录页"]?.key).toBe("EXAMPLE-1");
  expect(all["修登录页"]?.sessionId).toBe("$7");
  expect(typeof all["修登录页"]?.boundAt).toBe("number");
});

test("一个单可以挂多个会话", async () => {
  // 设计的轴心。会话名唯一而工单不唯一，所以这必须成立。
  await bindSession("改代码", "EXAMPLE-1", "$7");
  await bindSession("跑测试", "EXAMPLE-1", "$8");
  const all = await readBindings();
  expect(Object.keys(all).sort()).toEqual(["改代码", "跑测试"]);
  expect([all["改代码"]?.key, all["跑测试"]?.key]).toEqual(["EXAMPLE-1", "EXAMPLE-1"]);
});

test("解绑只拿掉那一个", async () => {
  await bindSession("改代码", "EXAMPLE-1", "$7");
  await bindSession("跑测试", "EXAMPLE-1", "$8");
  await unbindSession("改代码");
  expect(Object.keys(await readBindings())).toEqual(["跑测试"]);
});

test("会话改名后按 id 认回来，并把名字改正", async () => {
  await bindSession("旧名字", "EXAMPLE-1", "$7");
  const resolved = await resolveBindings([{ id: "$7", name: "新名字" }]);
  expect(resolved).toEqual([{ session: "新名字", key: "EXAMPLE-1", live: true }]);
  // 认回来之后要把记录迁过去，否则每次都要重认一遍。
  expect(Object.keys(await readBindings())).toEqual(["新名字"]);
});

test("tmux 重启后 id 变了，按名字认回来", async () => {
  await bindSession("修登录页", "EXAMPLE-1", "$7");
  const resolved = await resolveBindings([{ id: "$3", name: "修登录页" }]);
  expect(resolved).toEqual([{ session: "修登录页", key: "EXAMPLE-1", live: true }]);
});

test("会话没了的绑定留着，标成不在跑", async () => {
  // 这个仓库有会话恢复机制，指向已死会话的绑定恰好是"这个单之前开过，要不要恢复"。
  // 自动删会把那个入口一起删掉。
  await bindSession("修登录页", "EXAMPLE-1", "$7");
  const resolved = await resolveBindings([]);
  expect(resolved).toEqual([{ session: "修登录页", key: "EXAMPLE-1", live: false }]);
  expect(Object.keys(await readBindings())).toEqual(["修登录页"]);
});

test("并发写不会丢记录", async () => {
  await Promise.all([
    bindSession("a", "EXAMPLE-1", "$1"),
    bindSession("b", "EXAMPLE-2", "$2"),
    bindSession("c", "EXAMPLE-3", "$3"),
  ]);
  expect(Object.keys(await readBindings()).sort()).toEqual(["a", "b", "c"]);
});
