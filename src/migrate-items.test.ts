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
