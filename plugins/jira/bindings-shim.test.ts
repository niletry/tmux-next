import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jiraBindingsView, claimIssue } from "./server";
import { readItems } from "../../src/items";
import { readBindings } from "../../src/session-binding";

/**
 * 垫片只做翻译：内核存的是 itemId，Jira 页认的是单号。翻译发生在这里，是为了让
 * 同一个事实只有一个写者——否则两个页面会对同一个会话给出不同说法。
 */

let root: string;
const saved: Record<string, string | undefined> = {};
const VARS = ["TMUX_NEXT_ITEMS_PATH", "TMUX_NEXT_BINDINGS_PATH"];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "shim-"));
  for (const v of VARS) saved[v] = process.env[v];
  process.env.TMUX_NEXT_ITEMS_PATH = join(root, "items.json");
  process.env.TMUX_NEXT_BINDINGS_PATH = join(root, "bindings.json");
});

afterEach(async () => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v]!;
  }
  await rm(root, { recursive: true, force: true });
});

test("认领一个单号会建出一张挂了来源的单，并绑上会话", async () => {
  await claimIssue("跑测试", "EXAMPLE-1", "$1");
  const items = await readItems();
  expect(items.length).toBe(1);
  expect(items[0]!.source).toEqual({ provider: "jira", ref: "EXAMPLE-1" });
  expect((await readBindings())["跑测试"]?.itemId).toBe(items[0]!.id);
});

test("同一个单号的第二个会话不再建单", async () => {
  await claimIssue("跑测试", "EXAMPLE-1", "$1");
  await claimIssue("改代码", "EXAMPLE-1", "$2");
  expect((await readItems()).length).toBe(1);
});

test("视图把 itemId 翻回单号", async () => {
  await claimIssue("跑测试", "EXAMPLE-1", "$1");
  const view = await jiraBindingsView([{ name: "跑测试", sessionId: "$1" }]);
  expect(view).toEqual([{ session: "跑测试", key: "EXAMPLE-1", live: true }]);
});

test("没有 jira 来源的单不出现在这个视图里", async () => {
  const { createItem } = await import("../../src/items");
  const local = await createItem({ title: "本地的活" });
  const { bindSession } = await import("../../src/session-binding");
  await bindSession("随手开的", local.id, "$9");
  const view = await jiraBindingsView([{ name: "随手开的", sessionId: "$9" }]);
  expect(view).toEqual([]);
});

test("会话没了仍然列出来，live 为 false", async () => {
  await claimIssue("跑测试", "EXAMPLE-1", "$1");
  expect(await jiraBindingsView([])).toEqual([
    { session: "跑测试", key: "EXAMPLE-1", live: false },
  ]);
});
