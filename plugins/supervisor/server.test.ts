import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "supervisor-server-"));
  process.env.TMUX_NEXT_SUPERVISOR_DIR = stateDir;
});
afterEach(() => {
  delete process.env.TMUX_NEXT_SUPERVISOR_DIR;
  rmSync(stateDir, { recursive: true, force: true });
});

test("GET /api/supervisor 在没有监察者时返回空数组", async () => {
  const { handle } = await import("./server");
  const res = await handle(
    new Request("http://x/api/supervisor"),
    new URL("http://x/api/supervisor"),
  );
  expect(res).not.toBeNull();
  expect(await res!.json()).toEqual({ supervisors: [] });
});

test("GET /api/supervisor/log 缺 cwd 参数时 400", async () => {
  const { handle } = await import("./server");
  const res = await handle(
    new Request("http://x/api/supervisor/log"),
    new URL("http://x/api/supervisor/log"),
  );
  expect(res!.status).toBe(400);
});

test("GET /api/supervisor/log 带 cwd 时返回该目录的巡检记录（这里是空数组）", async () => {
  const { handle } = await import("./server");
  const res = await handle(
    new Request("http://x/api/supervisor/log?cwd=%2Ftmp%2Fproj"),
    new URL("http://x/api/supervisor/log?cwd=%2Ftmp%2Fproj"),
  );
  expect(await res!.json()).toEqual({ entries: [] });
});

test("不认识的子路径返回 null，交回给内核 404", async () => {
  const { handle } = await import("./server");
  const res = await handle(
    new Request("http://x/api/supervisor/nonesuch"),
    new URL("http://x/api/supervisor/nonesuch"),
  );
  expect(res).toBeNull();
});

test("插件注册表与服务端表保持同步（既有断言，验证接线正确）", async () => {
  const { PLUGINS } = await import("../registry.js");
  const { SERVERS } = await import("../handlers");
  expect(PLUGINS.map((p: { id: string }) => p.id)).toContain("supervisor");
  expect(Object.keys(SERVERS)).toContain("supervisor");
});
