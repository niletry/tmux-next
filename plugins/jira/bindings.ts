import { join } from "node:path";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { pluginStateDir } from "../state";
import type { LiveSession } from "./sessions";

/**
 * 工单与会话的绑定。
 *
 * 按会话作键，因为一个单可以有多个会话——会话名唯一，工单不唯一。反过来存每次
 * 会话改名或消亡都要去数组里翻。
 *
 * 名字与 id 都存：#{session_id} 跨改名不变、跨 tmux server 重启会重排；名字反
 * 过来。先按 id 认、认不上按名字认，两者各覆盖一半，于是插件接缝不必长出一个
 * "会话改名事件"。
 */

export type Binding = { key: string; sessionId: string; boundAt: number };
export type ResolvedBinding = { session: string; key: string; live: boolean };

function bindingsPath(): string {
  return join(pluginStateDir("jira"), "bindings.json");
}

/** 全函数：没有文件、坏 JSON、形状不对，都读成空表。 */
export async function readBindings(): Promise<Record<string, Binding>> {
  try {
    const data = (await Bun.file(bindingsPath()).json()) as Record<string, unknown>;
    const out: Record<string, Binding> = {};
    for (const [session, value] of Object.entries(data ?? {})) {
      const v = value as Record<string, unknown>;
      if (typeof v?.key !== "string" || !v.key) continue;
      out[session] = {
        key: v.key,
        sessionId: typeof v.sessionId === "string" ? v.sessionId : "",
        boundAt: typeof v.boundAt === "number" ? v.boundAt : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 写整张表：先写临时文件再 rename。
 *
 * rename 在同一文件系统内是原子的，所以并发的两次写不会把文件截成半截；后写的
 * 赢，而每次写的都是刚读回来的全表，所以丢的最多是一次并发里的一条，不是整张表。
 */
async function writeBindings(all: Record<string, Binding>): Promise<void> {
  const dir = pluginStateDir("jira");
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.bindings.${process.pid}.${Math.random().toString(36).slice(2)}`);
  await writeFile(tmp, JSON.stringify(all, null, 2));
  await rename(tmp, bindingsPath());
}

/**
 * 进程内串行化读-改-写。
 *
 * 原子 rename 只保证不会读到半截文件，不保证两次并发的读-改-写不互相覆盖——
 * 三个 bindSession 并发跑，各自先 readBindings() 再各自 writeBindings()，后写的
 * 会拿着自己那份"旧"全表覆盖前面写入的记录。这里用一条链把同一进程内的读-改-写
 * 串起来，跨进程的并发仍然只有 rename 的原子性兜底。
 */
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

export async function bindSession(session: string, key: string, sessionId: string): Promise<void> {
  await serialized(async () => {
    const all = await readBindings();
    all[session] = { key, sessionId, boundAt: Math.floor(Date.now() / 1000) };
    await writeBindings(all);
  });
}

export async function unbindSession(session: string): Promise<void> {
  await serialized(async () => {
    const all = await readBindings();
    delete all[session];
    await writeBindings(all);
  });
}

/**
 * 绑定对上现在活着的会话。
 *
 * 认回顺序是 id 优先、名字兜底。按 id 认回来的会话若已改名，记录跟着迁到新名字
 * 下——否则每次都要重认一遍，而一次写就能让它安顿。
 *
 * 会话没了的绑定**不删**：这个仓库有会话恢复机制，一条指向已死会话的绑定恰好是
 * "这个单之前开过，要不要恢复"。自动删会把那个入口一起删掉。
 */
export async function resolveBindings(live: LiveSession[]): Promise<ResolvedBinding[]> {
  const all = await readBindings();
  const byId = new Map(live.filter((s) => s.id).map((s) => [s.id, s]));
  const names = new Set(live.map((s) => s.name));

  const out: ResolvedBinding[] = [];
  const renames: Array<[string, string]> = [];

  for (const [session, binding] of Object.entries(all)) {
    const byIdHit = binding.sessionId ? byId.get(binding.sessionId) : undefined;
    if (byIdHit) {
      if (byIdHit.name !== session) renames.push([session, byIdHit.name]);
      out.push({ session: byIdHit.name, key: binding.key, live: true });
      continue;
    }
    out.push({ session, key: binding.key, live: names.has(session) });
  }

  if (renames.length) {
    const next = await readBindings();
    for (const [from, to] of renames) {
      const moved = next[from];
      if (!moved) continue;
      delete next[from];
      next[to] = moved;
    }
    await writeBindings(next);
  }

  return out;
}
