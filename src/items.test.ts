import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readItems,
  createItem,
  updateItem,
  findBySource,
  ensureItemForSource,
} from "./items";

/**
 * 单是内核概念，Jira 只是来源之一：一张单可以完全没有 source，也可以挂一个。
 * id 由内核生成、永不变——单号可以改、可以事后才补上，而 URL 与绑定必须指得住。
 */

let root: string;
let saved: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "items-"));
  saved = process.env.TMUX_NEXT_ITEMS_PATH;
  process.env.TMUX_NEXT_ITEMS_PATH = join(root, "items.json");
});

afterEach(async () => {
  if (saved === undefined) delete process.env.TMUX_NEXT_ITEMS_PATH;
  else process.env.TMUX_NEXT_ITEMS_PATH = saved;
  await rm(root, { recursive: true, force: true });
});

test("没有文件时读出空表", async () => {
  expect(await readItems()).toEqual([]);
});

test("坏 JSON 读成空表，不抛", async () => {
  await writeFile(join(root, "items.json"), "{ not json");
  expect(await readItems()).toEqual([]);
});

test("没有 title 的记录被丢掉，其余照读", async () => {
  await writeFile(
    join(root, "items.json"),
    JSON.stringify([{ id: "it-1", title: "好的" }, { id: "it-2" }, { title: "没 id" }]),
  );
  const items = await readItems();
  expect(items.map((i) => i.id)).toEqual(["it-1"]);
});

test("建单补齐默认值", async () => {
  const item = await createItem({ title: "修登录页" });
  expect(item.id).toMatch(/^it-[a-z0-9]+$/);
  expect(item.title).toBe("修登录页");
  expect(item.cwd).toBeNull();
  expect(item.source).toBeNull();
  expect(item.tags).toEqual([]);
  expect(item.closedAt).toBeNull();
  expect(typeof item.createdAt).toBe("number");
});

test("建出来的单读得回来", async () => {
  const a = await createItem({ title: "甲" });
  const b = await createItem({ title: "乙", cwd: "/tmp/x" });
  const items = await readItems();
  expect(items.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
  expect(items.find((i) => i.id === b.id)?.cwd).toBe("/tmp/x");
});

test("两张单的 id 不相同", async () => {
  const a = await createItem({ title: "甲" });
  const b = await createItem({ title: "甲" });
  expect(a.id).not.toBe(b.id);
});

test("改标题改得动，id 与 createdAt 不动", async () => {
  const a = await createItem({ title: "旧" });
  const next = await updateItem(a.id, { title: "新" });
  expect(next?.title).toBe("新");
  expect(next?.id).toBe(a.id);
  expect(next?.createdAt).toBe(a.createdAt);
});

test("改不存在的单返回 null", async () => {
  expect(await updateItem("it-nope", { title: "x" })).toBeNull();
});

// 归档不是删除：单从默认视图消失，但它的绑定记录还在。
test("归档写上 closedAt，单仍然读得到", async () => {
  const a = await createItem({ title: "甲" });
  await updateItem(a.id, { closedAt: 1787000000 });
  const items = await readItems();
  expect(items.find((i) => i.id === a.id)?.closedAt).toBe(1787000000);
});

test("按来源找得到，找不到给 null", async () => {
  await createItem({ title: "无源" });
  const withSource = await createItem({
    title: "有源",
    source: { provider: "jira", ref: "EXAMPLE-1" },
  });
  expect((await findBySource("jira", "EXAMPLE-1"))?.id).toBe(withSource.id);
  expect(await findBySource("jira", "EXAMPLE-2")).toBeNull();
  expect(await findBySource("github", "EXAMPLE-1")).toBeNull();
});

test("ensureItemForSource 第二次不再建新的", async () => {
  const first = await ensureItemForSource("jira", "EXAMPLE-1", "EXAMPLE-1");
  const second = await ensureItemForSource("jira", "EXAMPLE-1", "别的标题");
  expect(second.id).toBe(first.id);
  expect((await readItems()).length).toBe(1);
});

test("并发建三张单，一张都不丢", async () => {
  await Promise.all([
    createItem({ title: "甲" }),
    createItem({ title: "乙" }),
    createItem({ title: "丙" }),
  ]);
  expect((await readItems()).length).toBe(3);
});

test("refreshTitle 开着时更新标题", async () => {
  const first = await ensureItemForSource("jira", "EXAMPLE-1", "旧标题");
  const again = await ensureItemForSource("jira", "EXAMPLE-1", "新标题", { refreshTitle: true });
  expect(again.id).toBe(first.id);
  expect(again.title).toBe("新标题");
  expect((await readItems()).length).toBe(1);
});

test("不开 refreshTitle 时标题不动（默认行为不变）", async () => {
  await ensureItemForSource("jira", "EXAMPLE-1", "旧标题");
  const again = await ensureItemForSource("jira", "EXAMPLE-1", "新标题");
  expect(again.title).toBe("旧标题");
});

/**
 * cwd / tags / closedAt 是**本地状态**——你在这个工具里投入的东西。远端的一次
 * 改名不该动它们。这条是测试，不是注释里的承诺。
 */
test("更新标题绝不碰本地状态", async () => {
  const created = await ensureItemForSource("jira", "EXAMPLE-1", "旧标题");
  await updateItem(created.id, { cwd: "/tmp/orbit", tags: ["急"], closedAt: 1787000000 });
  const again = await ensureItemForSource("jira", "EXAMPLE-1", "新标题", { refreshTitle: true });
  expect(again.title).toBe("新标题");
  expect(again.cwd).toBe("/tmp/orbit");
  expect(again.tags).toEqual(["急"]);
  expect(again.closedAt).toBe(1787000000);
});

test("标题为空时不覆盖成空", async () => {
  await ensureItemForSource("jira", "EXAMPLE-1", "旧标题");
  const again = await ensureItemForSource("jira", "EXAMPLE-1", "", { refreshTitle: true });
  expect(again.title).toBe("旧标题");
});
