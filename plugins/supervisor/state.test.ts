// plugins/supervisor/state.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supervisor-state-"));
  process.env.TMUX_NEXT_SUPERVISOR_DIR = dir;
});
afterEach(() => {
  delete process.env.TMUX_NEXT_SUPERVISOR_DIR;
  rmSync(dir, { recursive: true, force: true });
});

test("空目录读出空登记表", async () => {
  const { readRegistry } = await import("./state");
  expect(await readRegistry()).toEqual({});
});

test("写入后能读回同一条记录", async () => {
  const { setSupervisor, readRegistry } = await import("./state");
  await setSupervisor("/tmp/proj", { session: "supervisor-proj", startedAt: 1000, autoConfirmPermission: false });
  expect(await readRegistry()).toEqual({
    "/tmp/proj": { session: "supervisor-proj", startedAt: 1000, autoConfirmPermission: false },
  });
});

test("removeSupervisor 只删指定的 cwd", async () => {
  const { setSupervisor, removeSupervisor, readRegistry } = await import("./state");
  await setSupervisor("/tmp/a", { session: "s-a", startedAt: 1, autoConfirmPermission: false });
  await setSupervisor("/tmp/b", { session: "s-b", startedAt: 2, autoConfirmPermission: true });
  await removeSupervisor("/tmp/a");
  expect(await readRegistry()).toEqual({
    "/tmp/b": { session: "s-b", startedAt: 2, autoConfirmPermission: true },
  });
});

test("损坏的登记表文件当成空表，不抛异常", async () => {
  const { readRegistry } = await import("./state");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "registry.json"), "not json");
  expect(await readRegistry()).toEqual({});
});

test("listLiveSupervisors 只保留存活会话，并清掉登记表里的死记录", async () => {
  const { setSupervisor, listLiveSupervisors, readRegistry } = await import("./state");
  await setSupervisor("/tmp/alive", { session: "s-alive", startedAt: 1, autoConfirmPermission: false });
  await setSupervisor("/tmp/dead", { session: "s-dead", startedAt: 2, autoConfirmPermission: false });
  const hasSession = async (session: string) => session === "s-alive";

  const live = await listLiveSupervisors(hasSession);

  expect(live).toEqual([{ cwd: "/tmp/alive", session: "s-alive", startedAt: 1, autoConfirmPermission: false }]);
  expect(await readRegistry()).toEqual({
    "/tmp/alive": { session: "s-alive", startedAt: 1, autoConfirmPermission: false },
  });
});
