import { homedir } from "node:os";
import { join } from "node:path";
import { readJson, writeJsonAtomic, serialized } from "./json-store";

/**
 * 会话属于哪张单。
 *
 * 按**会话名**作键，因为一张单可以有多个会话——会话名唯一，单不唯一。反过来存
 * （单 → 会话数组）每次会话改名或消亡都要去数组里翻。
 *
 * 名字与 tmux 的 #{session_id} 都存：id 跨改名不变、跨 tmux server 重启会重排；
 * 名字反过来。解析时 id 优先、名字兜底，两者各覆盖一半——于是内核不必为此长出
 * 一个"会话改名事件"。
 */

export type Binding = { itemId: string; sessionId: string; boundAt: number };
export type ResolvedBinding = { session: string; itemId: string; live: boolean };

export function bindingsPath(): string {
  return process.env.TMUX_NEXT_BINDINGS_PATH || join(homedir(), ".tmux-next", "bindings.json");
}

export async function readBindings(): Promise<Record<string, Binding>> {
  return readJson<Record<string, Binding>>(bindingsPath(), {}, (raw) => {
    const data = raw as Record<string, unknown>;
    const out: Record<string, Binding> = {};
    for (const [session, value] of Object.entries(data ?? {})) {
      const v = value as Record<string, unknown>;
      if (typeof v?.itemId !== "string" || !v.itemId) continue;
      out[session] = {
        itemId: v.itemId,
        sessionId: typeof v.sessionId === "string" ? v.sessionId : "",
        boundAt: typeof v.boundAt === "number" ? v.boundAt : 0,
      };
    }
    return out;
  });
}

export async function bindSession(
  session: string,
  itemId: string,
  sessionId: string,
): Promise<void> {
  await serialized(async () => {
    const all = await readBindings();
    all[session] = { itemId, sessionId, boundAt: Math.floor(Date.now() / 1000) };
    await writeJsonAtomic(bindingsPath(), all);
  });
}

export async function unbindSession(session: string): Promise<void> {
  await serialized(async () => {
    const all = await readBindings();
    delete all[session];
    await writeJsonAtomic(bindingsPath(), all);
  });
}

/**
 * 绑定对上现在活着的会话。
 *
 * 认回顺序是 id 优先、名字兜底。按 id 认回来的会话若已改名，记录跟着迁到新名字
 * 下——否则每次都要重认一遍，而一次写就能让它安顿。
 *
 * 会话没了的绑定**不删**：这个仓库有会话恢复机制，一条指向已死会话的绑定恰好是
 * "这张单之前开过，要不要恢复"。自动删会把那个入口一起删掉。
 */
export async function resolveBindings(
  live: Array<{ name: string; sessionId: string }>,
): Promise<ResolvedBinding[]> {
  const all = await readBindings();
  const byId = new Map(live.filter((s) => s.sessionId).map((s) => [s.sessionId, s]));
  const names = new Set(live.map((s) => s.name));

  const out: ResolvedBinding[] = [];
  const renames: Array<[string, string]> = [];

  for (const [session, binding] of Object.entries(all)) {
    const byIdHit = binding.sessionId ? byId.get(binding.sessionId) : undefined;
    if (byIdHit) {
      if (byIdHit.name !== session) renames.push([session, byIdHit.name]);
      out.push({ session: byIdHit.name, itemId: binding.itemId, live: true });
      continue;
    }
    out.push({ session, itemId: binding.itemId, live: names.has(session) });
  }

  if (renames.length) {
    // 整个读-改-写必须在队列里面，不只是写——在队列外面读、进队列写，中间那道
    // 缝跟没排队一样，一次 bindSession 落在缝里就会被这里的旧快照覆盖掉。
    await serialized(async () => {
      const next = await readBindings();
      for (const [from, to] of renames) {
        const moved = next[from];
        if (!moved) continue;
        delete next[from];
        next[to] = moved;
      }
      await writeJsonAtomic(bindingsPath(), next);
    });
  }

  return out;
}
