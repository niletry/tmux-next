import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateJiraBindings } from "./migrate-items";
import { readItems } from "./items";
import { readBindings } from "./session-binding";

let root: string;
const saved: Record<string, string | undefined> = {};
const VARS = ["TMUX_NEXT_ITEMS_PATH", "TMUX_NEXT_BINDINGS_PATH", "TMUX_NEXT_JIRA_DIR"];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "migrate-"));
  for (const v of VARS) saved[v] = process.env[v];
  process.env.TMUX_NEXT_ITEMS_PATH = join(root, "items.json");
  process.env.TMUX_NEXT_BINDINGS_PATH = join(root, "bindings.json");
  process.env.TMUX_NEXT_JIRA_DIR = join(root, "jira");
  await mkdir(join(root, "jira"), { recursive: true });
});

afterEach(async () => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v]!;
  }
  await rm(root, { recursive: true, force: true });
});

async function writeOldBindings(data: unknown) {
  await writeFile(join(root, "jira", "bindings.json"), JSON.stringify(data));
}

test("旧文件不存在时什么都不做", async () => {
  expect(await migrateJiraBindings()).toEqual({ migrated: 0 });
  expect(await readItems()).toEqual([]);
});

test("每个不同的单号建一张单，标题先用单号", async () => {
  await writeOldBindings({
    跑测试: { key: "EXAMPLE-1", sessionId: "$1", boundAt: 1 },
    改代码: { key: "EXAMPLE-1", sessionId: "$2", boundAt: 2 },
    另一件: { key: "EXAMPLE-2", sessionId: "$3", boundAt: 3 },
  });

  expect(await migrateJiraBindings()).toEqual({ migrated: 3 });

  const items = await readItems();
  expect(items.length).toBe(2);
  expect(items.map((i) => i.title).sort()).toEqual(["EXAMPLE-1", "EXAMPLE-2"]);
  expect(items.every((i) => i.source?.provider === "jira")).toBe(true);
});

test("绑定搬进内核，一张单下的两个会话都在", async () => {
  await writeOldBindings({
    跑测试: { key: "EXAMPLE-1", sessionId: "$1", boundAt: 1 },
    改代码: { key: "EXAMPLE-1", sessionId: "$2", boundAt: 2 },
  });
  await migrateJiraBindings();

  const bindings = await readBindings();
  const items = await readItems();
  const id = items[0]!.id;
  expect(bindings["跑测试"]?.itemId).toBe(id);
  expect(bindings["改代码"]?.itemId).toBe(id);
  expect(bindings["跑测试"]?.sessionId).toBe("$1");
});

// 幂等：items.json 已存在就整个跳过，绝不重复建单。
test("再跑一次不重复建单", async () => {
  await writeOldBindings({ 甲: { key: "EXAMPLE-1", sessionId: "$1", boundAt: 1 } });
  await migrateJiraBindings();
  expect(await migrateJiraBindings()).toEqual({ migrated: 0 });
  expect((await readItems()).length).toBe(1);
});

test("不删旧文件——留一版回退证据", async () => {
  await writeOldBindings({ 甲: { key: "EXAMPLE-1", sessionId: "$1", boundAt: 1 } });
  await migrateJiraBindings();
  expect(await Bun.file(join(root, "jira", "bindings.json")).exists()).toBe(true);
});

test("旧文件坏了就当没有，不抛", async () => {
  await writeFile(join(root, "jira", "bindings.json"), "{ not json");
  expect(await migrateJiraBindings()).toEqual({ migrated: 0 });
});

// 写盘顺序：bindings.json 先、items.json 后（后者是幂等判据）。用一个真实故障
// 逼一次"写到一半"：把 items.json 的路径指到一个已存在的目录上，writeJsonAtomic
// 内部的 rename(tmp, path) 在目标是目录时会真的抛错（EISDIR），而不是靠 mock 假装。
// 抛错发生在第三步，此时 bindings.json 那一步应该已经落盘。
test("崩在写 items.json 之前，bindings.json 已经落盘——顺序是真的", async () => {
  const itemsAsDir = join(root, "items.json");
  await mkdir(itemsAsDir, { recursive: true });
  process.env.TMUX_NEXT_ITEMS_PATH = itemsAsDir;

  await writeOldBindings({ 甲: { key: "EXAMPLE-1", sessionId: "$1", boundAt: 1 } });

  let threw = false;
  try {
    await migrateJiraBindings();
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);

  const bindings = await readBindings();
  expect(bindings["甲"]?.sessionId).toBe("$1");
});

// 现有的内核绑定不能被迁移覆盖掉——第二步是合并写，不是整表覆盖。
test("迁移前 bindings.json 里已有的绑定，迁移之后还在", async () => {
  await writeFile(
    join(root, "bindings.json"),
    JSON.stringify({ 已有会话: { itemId: "it-preexisting", sessionId: "$99", boundAt: 5 } }),
  );
  await writeOldBindings({ 甲: { key: "EXAMPLE-1", sessionId: "$1", boundAt: 1 } });

  await migrateJiraBindings();

  const bindings = await readBindings();
  expect(bindings["已有会话"]).toEqual({ itemId: "it-preexisting", sessionId: "$99", boundAt: 5 });
  expect(bindings["甲"]?.itemId).toBeTruthy();
});

// 模拟一次"迁到一半"：先手工写出 bindings.json（相当于第二步已完成）但不写
// items.json（第三步没跑到），再正常跑一次迁移，必须收敛到完整结果——不多建单，
// 也不丢会话。
test("模拟迁到一半后重跑，收敛到完整结果", async () => {
  await writeOldBindings({
    甲: { key: "EXAMPLE-1", sessionId: "$1", boundAt: 1 },
    乙: { key: "EXAMPLE-1", sessionId: "$2", boundAt: 2 },
    丙: { key: "EXAMPLE-2", sessionId: "$3", boundAt: 3 },
  });

  // 手工重现"bindings.json 已写、items.json 还没写"这个中间状态，而不必真的
  // 中途杀掉进程。
  await writeFile(
    join(root, "bindings.json"),
    JSON.stringify({
      甲: { itemId: "it-partial", sessionId: "$1", boundAt: 1 },
      乙: { itemId: "it-partial", sessionId: "$2", boundAt: 2 },
    }),
  );
  expect(await Bun.file(join(root, "items.json")).exists()).toBe(false);

  const result = await migrateJiraBindings();
  expect(result.migrated).toBe(3);

  const items = await readItems();
  const bindings = await readBindings();
  // 两个单号各建一张单：EXAMPLE-1、EXAMPLE-2，一个都不多。
  expect(items.map((i) => i.source?.ref).sort()).toEqual(["EXAMPLE-1", "EXAMPLE-2"]);
  expect(Object.keys(bindings).sort()).toEqual(["丙", "乙", "甲"]);
  expect(bindings["甲"]?.itemId).toBe(bindings["乙"]?.itemId);
  expect(bindings["丙"]?.itemId).not.toBe(bindings["甲"]?.itemId);
});
