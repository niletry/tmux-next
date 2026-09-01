import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmux } from "./tmux/run";
import { listSessions } from "./tmux/session-list";
import { bindSession, resolveBindings, readBindings } from "./session-binding";
import { createItem } from "./items";

// 只清理这里面的名字。绝不 kill-server，绝不按前缀杀。
const created: string[] = [];
let root: string;
const saved: Record<string, string | undefined> = {};
const VARS = ["TMUX_NEXT_ITEMS_PATH", "TMUX_NEXT_BINDINGS_PATH"];

function name(suffix: string) {
  return `itest-${process.pid}-${suffix}`;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bind-itest-"));
  for (const v of VARS) saved[v] = process.env[v];
  process.env.TMUX_NEXT_ITEMS_PATH = join(root, "items.json");
  process.env.TMUX_NEXT_BINDINGS_PATH = join(root, "bindings.json");
});

afterEach(async () => {
  for (const n of created.splice(0)) {
    // 先确认它确实存在、确实是我们建的那个名字，读到结果之后才杀。
    const has = await tmux(["has-session", "-t", `=${n}`]);
    if (has.ok) await tmux(["kill-session", "-t", `=${n}`]);
  }
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v]!;
  }
  await rm(root, { recursive: true, force: true });
});

test("建会话、绑定、改名之后仍然认得回来", async () => {
  const first = name("a");
  await tmux(["new-session", "-d", "-s", first]);
  created.push(first);

  const live = await listSessions();
  const mine = live.find((s) => s.name === first);
  expect(mine).toBeDefined();
  expect(mine!.sessionId).toMatch(/^\$\d+$/);

  const item = await createItem({ title: "集成测试的单" });
  await bindSession(first, item.id, mine!.sessionId);

  const renamed = name("b");
  await tmux(["rename-session", "-t", `=${first}`, renamed]);
  created.splice(created.indexOf(first), 1);
  created.push(renamed);

  const after = await listSessions();
  const resolved = await resolveBindings(
    after.map((s) => ({ name: s.name, sessionId: s.sessionId })),
  );
  const hit = resolved.find((b) => b.itemId === item.id);
  expect(hit).toEqual({ session: renamed, itemId: item.id, live: true });

  // 记录迁到了新名字下，不是每次都靠 id 重认。
  expect((await readBindings())[renamed]).toBeDefined();
  expect((await readBindings())[first]).toBeUndefined();
});

test("会话被杀之后绑定还在，只是 live 为 false", async () => {
  const n = name("c");
  await tmux(["new-session", "-d", "-s", n]);
  created.push(n);
  const live = await listSessions();
  const mine = live.find((s) => s.name === n)!;
  const item = await createItem({ title: "会被杀掉的" });
  await bindSession(n, item.id, mine.sessionId);

  const has = await tmux(["has-session", "-t", `=${n}`]);
  expect(has.ok).toBe(true); // 读到结果之后才杀
  await tmux(["kill-session", "-t", `=${n}`]);
  created.splice(created.indexOf(n), 1);

  const after = await listSessions();
  const resolved = await resolveBindings(
    after.map((s) => ({ name: s.name, sessionId: s.sessionId })),
  );
  expect(resolved.find((b) => b.itemId === item.id)).toEqual({
    session: n,
    itemId: item.id,
    live: false,
  });
});
