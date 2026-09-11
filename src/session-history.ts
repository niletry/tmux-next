import { homedir } from "node:os";
import { join } from "node:path";
import { readJson, writeJsonAtomic, serialized } from "./json-store";

/**
 * 一张单历史上绑定过哪些会话（含已死的）。
 *
 * 这不是 bindings.json 的第二份拷贝：bindings.json 是"当前指针"（一个会话名现
 * 在指向哪张单），这里是那根指针移动过的轨迹——每一段绑定关系一行，`endedAt`
 * 为 null 表示这段还没结束。`session`/`sessionId` 只是绑定那一刻抄下来的快照，
 * 不是指向哪张表的外键：sessionId 只在单次 tmux server 生命周期内唯一，重启后
 * 可能被别的会话复用，所以这里不承诺"跨时间认回同一个会话"。
 */

export type HistoryEntry = {
  itemId: string;
  session: string;
  sessionId: string;
  boundAt: number;
  endedAt: number | null;
};

export function historyPath(): string {
  return process.env.TMUX_NEXT_SESSION_HISTORY_PATH || join(homedir(), ".tmux-next", "session-history.json");
}

export async function readHistory(): Promise<HistoryEntry[]> {
  return readJson<HistoryEntry[]>(historyPath(), [], (raw) => {
    if (!Array.isArray(raw)) return [];
    const out: HistoryEntry[] = [];
    for (const value of raw) {
      const v = value as Record<string, unknown>;
      if (typeof v?.itemId !== "string" || !v.itemId) continue;
      if (typeof v?.session !== "string" || !v.session) continue;
      out.push({
        itemId: v.itemId,
        session: v.session,
        sessionId: typeof v.sessionId === "string" ? v.sessionId : "",
        boundAt: typeof v.boundAt === "number" ? v.boundAt : 0,
        endedAt: typeof v.endedAt === "number" ? v.endedAt : null,
      });
    }
    return out;
  });
}

/** 关掉这个 sessionId 还开着的那一段（不管挂在哪个 item 上），再开一段新的。 */
export async function recordBind(session: string, itemId: string, sessionId: string): Promise<void> {
  await serialized(async () => {
    const all = await readHistory();
    const now = Math.floor(Date.now() / 1000);
    for (const entry of all) {
      if (entry.sessionId === sessionId && entry.endedAt === null) entry.endedAt = now;
    }
    all.push({ itemId, session, sessionId, boundAt: now, endedAt: null });
    await writeJsonAtomic(historyPath(), all);
  });
}

/** 关掉这个会话名还开着的那一段——会话没死，只是跟单脱钩了。 */
export async function recordUnbind(session: string): Promise<void> {
  await serialized(async () => {
    const all = await readHistory();
    const now = Math.floor(Date.now() / 1000);
    let changed = false;
    for (const entry of all) {
      if (entry.session === session && entry.endedAt === null) {
        entry.endedAt = now;
        changed = true;
      }
    }
    if (changed) await writeJsonAtomic(historyPath(), all);
  });
}

/** 这些会话名这次被发现已经不在活着的列表里了——关掉它们还开着的那一段。 */
export async function recordDead(sessions: string[]): Promise<void> {
  if (sessions.length === 0) return;
  await serialized(async () => {
    const all = await readHistory();
    const dead = new Set(sessions);
    const now = Math.floor(Date.now() / 1000);
    let changed = false;
    for (const entry of all) {
      if (dead.has(entry.session) && entry.endedAt === null) {
        entry.endedAt = now;
        changed = true;
      }
    }
    if (changed) await writeJsonAtomic(historyPath(), all);
  });
}

/** 这张单已经结束的绑定段，最近结束的在前。仍在进行中的一段不在这里——已经在 `sessions` 里显示了。 */
export async function historyForItem(itemId: string): Promise<HistoryEntry[]> {
  const all = await readHistory();
  return all.filter((e) => e.itemId === itemId && e.endedAt !== null).reverse();
}
