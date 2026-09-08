import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 游标的读写。全部用 TMUX_NEXT_JIRA_DIR 指到临时目录隔离——路径是函数里现读的
 * （见 plugins/state.ts 的规矩），所以在 import 之前还是之后设 env 都行，这里
 * 跟仓库里同类测试一样在 import 之前设，图个保险。
 */

const dir = mkdtempSync(join(tmpdir(), "jira-sync-state-test-"));
const prevJiraDir = process.env.TMUX_NEXT_JIRA_DIR;
process.env.TMUX_NEXT_JIRA_DIR = dir;

const { readSyncState, writeSyncState } = await import("./sync-state");

test("没有文件时读成 null，不是抛", async () => {
  expect(await readSyncState()).toBeNull();
});

test("写完再读，原样拿回来", async () => {
  await writeSyncState({ lastSyncAt: 12345, jql: "assignee = currentUser()" });
  expect(await readSyncState()).toEqual({ lastSyncAt: 12345, jql: "assignee = currentUser()" });
});

test("畸形 JSON 读成 null，不炸", async () => {
  await writeFile(join(dir, "sync-state.json"), "{ not json");
  expect(await readSyncState()).toBeNull();
});

test("字段形状不对（缺字段/类型不对）读成 null", async () => {
  await writeFile(join(dir, "sync-state.json"), JSON.stringify({ lastSyncAt: "not-a-number", jql: "x" }));
  expect(await readSyncState()).toBeNull();

  await writeFile(join(dir, "sync-state.json"), JSON.stringify({ jql: "x" }));
  expect(await readSyncState()).toBeNull();

  await writeFile(join(dir, "sync-state.json"), JSON.stringify({ lastSyncAt: 1 }));
  expect(await readSyncState()).toBeNull();
});

test("跑完还原 env、清理临时目录", () => {
  if (prevJiraDir === undefined) delete process.env.TMUX_NEXT_JIRA_DIR;
  else process.env.TMUX_NEXT_JIRA_DIR = prevJiraDir;
  rmSync(dir, { recursive: true, force: true });
});
