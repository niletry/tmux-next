import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pluginStateDir } from "../state";

export type SupervisorRecord = {
  session: string;
  startedAt: number;
  autoConfirmPermission: boolean;
};

export type Registry = Record<string, SupervisorRecord>;

function registryPath(): string {
  return join(pluginStateDir("supervisor"), "registry.json");
}

export async function readRegistry(): Promise<Registry> {
  try {
    const data: unknown = await Bun.file(registryPath()).json();
    if (data === null || typeof data !== "object" || Array.isArray(data)) return {};
    return data as Registry;
  } catch {
    return {};
  }
}

async function writeRegistry(registry: Registry): Promise<void> {
  await mkdir(pluginStateDir("supervisor"), { recursive: true });
  await Bun.write(registryPath(), JSON.stringify(registry, null, 2));
}

export async function setSupervisor(cwd: string, record: SupervisorRecord): Promise<void> {
  const registry = await readRegistry();
  registry[cwd] = record;
  await writeRegistry(registry);
}

export async function removeSupervisor(cwd: string): Promise<void> {
  const registry = await readRegistry();
  delete registry[cwd];
  await writeRegistry(registry);
}

/**
 * Live supervisors, and a side effect: any registry entry whose tmux session
 * is gone is dropped, so a dead supervisor never blocks a fresh one for that
 * cwd. `hasSession` is injected so tests never need a real tmux server.
 * Deletion only occurs if the session at that cwd is still the same dead one,
 * because a fresh supervisor may have claimed the cwd between the two reads.
 */
export async function listLiveSupervisors(
  hasSession: (session: string) => Promise<boolean>,
): Promise<Array<{ cwd: string } & SupervisorRecord>> {
  const registry = await readRegistry();
  const live: Array<{ cwd: string } & SupervisorRecord> = [];
  const dead: Array<{ cwd: string; session: string }> = [];

  for (const [cwd, record] of Object.entries(registry)) {
    if (await hasSession(record.session)) live.push({ cwd, ...record });
    else dead.push({ cwd, session: record.session });
  }

  if (dead.length) {
    const fresh = await readRegistry();
    for (const { cwd, session } of dead) {
      if (fresh[cwd]?.session === session) delete fresh[cwd];
    }
    await writeRegistry(fresh);
  }

  return live;
}
