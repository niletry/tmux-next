// plugins/supervisor/create.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateSupervisorDeps } from "./create";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supervisor-create-"));
  process.env.TMUX_NEXT_SUPERVISOR_DIR = dir;
});
afterEach(() => {
  delete process.env.TMUX_NEXT_SUPERVISOR_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function fakeDeps(overrides: Partial<CreateSupervisorDeps> = {}): CreateSupervisorDeps {
  return {
    resolveDirectory: async (input) => ({ ok: true, path: input }),
    createSession: async (_dir, requested) => ({ ok: true, name: requested ?? "auto-name", created: true }),
    sessionNames: async () => [],
    hasSession: async () => true,
    primeSession: async () => {},
    nowMs: () => 12345,
    ...overrides,
  };
}

test("目录解析失败时返回 baddir，不建会话", async () => {
  const { createSupervisor } = await import("./create");
  let createCalled = false;
  const deps = fakeDeps({
    resolveDirectory: async () => ({ ok: false, reason: "missing" }),
    createSession: async () => {
      createCalled = true;
      return { ok: true, name: "x", created: true };
    },
  });

  const result = await createSupervisor({ cwd: "/nope", autoConfirmPermission: false, port: "7682" }, deps);

  expect(result).toEqual({ ok: false, reason: "baddir" });
  expect(createCalled).toBe(false);
});

test("该 cwd 已有存活监察者时返回 exists，不建会话", async () => {
  const { createSupervisor } = await import("./create");
  const { setSupervisor } = await import("./state");
  await setSupervisor("/proj", { session: "old-sup", startedAt: 1, autoConfirmPermission: false });
  let createCalled = false;
  const deps = fakeDeps({
    hasSession: async (session) => session === "old-sup",
    createSession: async () => {
      createCalled = true;
      return { ok: true, name: "x", created: true };
    },
  });

  const result = await createSupervisor({ cwd: "/proj", autoConfirmPermission: false, port: "7682" }, deps);

  expect(result).toEqual({ ok: false, reason: "exists" });
  expect(createCalled).toBe(false);
});

test("旧记录的会话已经不在了，视为空位可以新建", async () => {
  const { createSupervisor } = await import("./create");
  const { setSupervisor, readRegistry } = await import("./state");
  await setSupervisor("/proj", { session: "dead-sup", startedAt: 1, autoConfirmPermission: false });
  const deps = fakeDeps({
    hasSession: async () => false,
    createSession: async (_dir, requested) => ({ ok: true, name: requested ?? "auto", created: true }),
  });

  const result = await createSupervisor({ cwd: "/proj", autoConfirmPermission: true, port: "7682" }, deps);

  expect(result.ok).toBe(true);
  const registry = await readRegistry();
  expect(registry["/proj"].autoConfirmPermission).toBe(true);
});

test("createSession 失败时透传 failed，不写登记表", async () => {
  const { createSupervisor } = await import("./create");
  const { readRegistry } = await import("./state");
  const deps = fakeDeps({ createSession: async () => ({ ok: false, reason: "baddir" }) });

  const result = await createSupervisor({ cwd: "/proj", autoConfirmPermission: false, port: "7682" }, deps);

  expect(result).toEqual({ ok: false, reason: "failed" });
  expect(await readRegistry()).toEqual({});
});

test("createSession 返回 created:false（撞名而非同一个监察者）也算失败，不误认成功", async () => {
  const { createSupervisor } = await import("./create");
  const deps = fakeDeps({ createSession: async (_dir, requested) => ({ ok: true, name: requested ?? "x", created: false }) });

  const result = await createSupervisor({ cwd: "/proj", autoConfirmPermission: false, port: "7682" }, deps);

  expect(result).toEqual({ ok: false, reason: "failed" });
});

test("成功时把渲染好的提示词灌给新会话，并记入登记表", async () => {
  const { createSupervisor } = await import("./create");
  const { readRegistry } = await import("./state");
  let primed: { session: string; text: string } | null = null;
  const deps = fakeDeps({
    createSession: async (_dir, requested) => ({ ok: true, name: requested ?? "auto", created: true }),
    primeSession: async (session, text) => {
      primed = { session, text };
    },
    nowMs: () => 999,
  });

  const result = await createSupervisor({ cwd: "/proj", autoConfirmPermission: false, port: "7682" }, deps);

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(primed).not.toBeNull();
  expect(primed!.session).toBe(result.session);
  expect(primed!.text).toContain("/proj");
  expect(primed!.text).toContain(result.session);
  const registry = await readRegistry();
  expect(registry["/proj"]).toEqual({ session: result.session, startedAt: 999, autoConfirmPermission: false });
});
