// plugins/supervisor/create.ts
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveDirectory } from "../../src/paths";
import { createSession } from "../../src/tmux/session-create";
import { sessionNames } from "../../src/tmux/session-list";
import { primeSession } from "../../src/tmux/prime";
import { tmux } from "../../src/tmux/run";
import { readRegistry, setSupervisor } from "./state";
import { logPathFor } from "./log";
import { renderSupervisorPrompt } from "./prompt";

export type CreateSupervisorParams = {
  cwd: string;
  autoConfirmPermission: boolean;
  port: string;
};

export type CreateSupervisorResult =
  | { ok: true; session: string }
  | { ok: false; reason: "baddir" | "exists" | "failed" };

export type CreateSupervisorDeps = {
  resolveDirectory: typeof resolveDirectory;
  createSession: typeof createSession;
  sessionNames: typeof sessionNames;
  hasSession: (session: string) => Promise<boolean>;
  primeSession: typeof primeSession;
  nowMs: () => number;
};

export const defaultCreateSupervisorDeps: CreateSupervisorDeps = {
  resolveDirectory,
  createSession,
  sessionNames,
  hasSession: async (session) => (await tmux(["has-session", "-t", `=${session}`])).ok,
  primeSession,
  nowMs: () => Date.now(),
};

/** `supervisor-<最后一段目录名>`，字符集跟 pickName 对 UNTARGETABLE 的要求看齐。 */
function requestedNameFor(cwd: string): string {
  const base = cwd.replace(/\/+$/, "").split("/").pop() || "session";
  return `supervisor-${base.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

export async function createSupervisor(
  params: CreateSupervisorParams,
  deps: CreateSupervisorDeps = defaultCreateSupervisorDeps,
): Promise<CreateSupervisorResult> {
  const dir = await deps.resolveDirectory(params.cwd);
  if (!dir.ok) return { ok: false, reason: "baddir" };

  const registry = await readRegistry();
  const existing = registry[dir.path];
  if (existing && (await deps.hasSession(existing.session))) {
    return { ok: false, reason: "exists" };
  }

  const names = await deps.sessionNames();
  const created = await deps.createSession(dir.path, requestedNameFor(dir.path), names);
  // `created.created === false` means the requested name collided with an
  // unrelated existing session (the registry check above already ruled out
  // "this cwd already has a live supervisor", so this is the rarer case of a
  // same-named session that isn't ours) — never treat a reused session as a
  // fresh supervisor, and never prime text into a session we didn't just start.
  if (!created.ok || !created.created) return { ok: false, reason: "failed" };

  const logPath = logPathFor(dir.path);
  // The prompt tells the agent to append with a plain `>>` redirect, which
  // has no mkdir of its own — on a fresh install `logs/` doesn't exist yet,
  // so the very first append fails with ENOENT, silently and permanently
  // (the agent has no reason to notice or retry a shell redirect failing).
  // Creating it here, before the prime is fired, means the directory always
  // exists before the agent's first attempt to write to it.
  await mkdir(dirname(logPath), { recursive: true });

  const prompt = renderSupervisorPrompt({
    cwd: dir.path,
    selfSession: created.name,
    autoConfirmPermission: params.autoConfirmPermission,
    logPath,
    port: params.port,
  });
  // `primeSession` waits up to PRIME_TIMEOUT_MS (20s) for the agent's ready
  // marker, and this function is called straight from an HTTP route handler
  // (POST /api/supervisor/create) — awaiting it would stall the response for
  // up to twenty seconds on a slow-starting agent. Priming already fails
  // silently by design (a timeout means "don't send", and the caller has
  // nothing to do about that outcome anyway), so awaiting buys nothing and
  // costs the whole timeout budget. Fire-and-forget, matching the kernel's
  // own create-then-prime path (src/server.ts).
  void deps.primeSession(created.name, prompt).catch(() => {});

  await setSupervisor(dir.path, {
    session: created.name,
    startedAt: deps.nowMs(),
    autoConfirmPermission: params.autoConfirmPermission,
  });

  return { ok: true, session: created.name };
}
