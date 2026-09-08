// plugins/supervisor/log.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { encodeCwd, logPathFor, patrolEntriesFrom, readPatrolLog } from "./log";

test("encodeCwd 把斜杠和点换成短横线", () => {
  expect(encodeCwd("/Users/you/projects/tmux-next")).toBe("-Users-you-projects-tmux-next");
  expect(encodeCwd("/Users/you/proj.name/")).toBe("-Users-you-proj-name");
});

test("logPathFor 落在 supervisor 状态目录的 logs 子目录下", () => {
  process.env.TMUX_NEXT_SUPERVISOR_DIR = "/tmp/sup-state";
  expect(logPathFor("/a/b")).toBe("/tmp/sup-state/logs/-a-b.jsonl");
  delete process.env.TMUX_NEXT_SUPERVISOR_DIR;
});

test("patrolEntriesFrom 跳过残缺的第一行和坏 JSON", () => {
  const chunk = [
    '{"partial line from a previous',
    '{"ts":"2026-01-01T00:00:00Z","checked":[{"session":"a","turn":"waiting","note":"n"}],"actions":[{"session":"a","type":"noop","detail":"d"}]}',
    "not json at all",
    '{"ts":"2026-01-01T00:01:00Z","checked":[],"actions":[]}',
  ].join("\n");

  expect(patrolEntriesFrom(chunk)).toEqual([
    {
      ts: "2026-01-01T00:00:00Z",
      checked: [{ session: "a", turn: "waiting", note: "n" }],
      actions: [{ session: "a", type: "noop", detail: "d" }],
    },
    { ts: "2026-01-01T00:01:00Z", checked: [], actions: [] },
  ]);
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supervisor-log-"));
  process.env.TMUX_NEXT_SUPERVISOR_DIR = dir;
});
afterEach(() => {
  delete process.env.TMUX_NEXT_SUPERVISOR_DIR;
  rmSync(dir, { recursive: true, force: true });
});

test("readPatrolLog 读不到文件时返回空数组", async () => {
  expect(await readPatrolLog("/nope", 10)).toEqual([]);
});

test("readPatrolLog 按 limit 只留最新的几条", async () => {
  const path = logPathFor("/proj");
  mkdirSync(dirname(path), { recursive: true });
  const lines = [1, 2, 3].map(
    (n) => `{"ts":"t${n}","checked":[],"actions":[]}`,
  );
  writeFileSync(path, lines.join("\n") + "\n");

  const entries = await readPatrolLog("/proj", 2);
  expect(entries.map((e) => e.ts)).toEqual(["t2", "t3"]);
});
