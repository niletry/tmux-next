import { homedir } from "node:os";
import { join } from "node:path";
import { readJson, writeJsonAtomic, serialized } from "./json-store";

/**
 * 一张单：工作的单位。会话是它底下的手段。
 *
 * 内核概念，不是某个插件的：Jira 只是 source 的一种取值。source 为 null 的本地
 * 单跟挂了工单的单是同一种东西，首页上也是同一种行。
 *
 * id 由内核生成、永不变。不复用单号：单号可以改、可以在认领之后才补上，而 URL
 * 与绑定必须指得住。
 *
 * 状态、Epic 这些**一个都不存**——它们是每次现算的 facet。存下来就要同步，而
 * "内核存自己的单 + 外部引用"这个模型之所以成立，正是因为远端那部分是叠上去的。
 * 只有本地的 tags 是存的。
 */

export type ItemSource = { provider: string; ref: string; url?: string };

export type WorkItem = {
  id: string;
  title: string;
  cwd: string | null;
  source: ItemSource | null;
  tags: string[];
  createdAt: number;
  /** 归档，不是删除：单从默认视图消失，它的会话与绑定记录都还在。 */
  closedAt: number | null;
};

/** 路径在函数里现读，不在模块加载时捕获——测试要能先设 env 再调用。 */
export function itemsPath(): string {
  return process.env.TMUX_NEXT_ITEMS_PATH || join(homedir(), ".tmux-next", "items.json");
}

function sanitiseSource(raw: unknown): ItemSource | null {
  const s = raw as Record<string, unknown>;
  if (typeof s?.provider !== "string" || !s.provider) return null;
  if (typeof s?.ref !== "string" || !s.ref) return null;
  return {
    provider: s.provider,
    ref: s.ref,
    ...(typeof s.url === "string" && s.url ? { url: s.url } : {}),
  };
}

/** 全函数：坏文件、坏记录一律读成空/丢掉，绝不抛。 */
export async function readItems(): Promise<WorkItem[]> {
  return readJson<WorkItem[]>(itemsPath(), [], (raw) => {
    if (!Array.isArray(raw)) return [];
    const out: WorkItem[] = [];
    for (const value of raw) {
      const v = value as Record<string, unknown>;
      if (typeof v?.id !== "string" || !v.id) continue;
      if (typeof v?.title !== "string" || !v.title) continue;
      out.push({
        id: v.id,
        title: v.title,
        cwd: typeof v.cwd === "string" ? v.cwd : null,
        source: sanitiseSource(v.source),
        tags: Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === "string") : [],
        createdAt: typeof v.createdAt === "number" ? v.createdAt : 0,
        closedAt: typeof v.closedAt === "number" ? v.closedAt : null,
      });
    }
    return out;
  });
}

/** `it-` + 时间 + 随机：时间让它大致有序，随机让同一秒内建的两张不撞。 */
function newId(): string {
  return `it-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function createItem(input: {
  title: string;
  cwd?: string | null;
  source?: ItemSource | null;
  tags?: string[];
}): Promise<WorkItem> {
  const item: WorkItem = {
    id: newId(),
    title: input.title,
    cwd: input.cwd ?? null,
    source: input.source ?? null,
    tags: input.tags ?? [],
    createdAt: Math.floor(Date.now() / 1000),
    closedAt: null,
  };
  // 整段读-改-写都在队列里，不只是写：在队列外面读、进队列写，中间那道缝跟没
  // 排队一样。
  await serialized(async () => {
    const all = await readItems();
    all.push(item);
    await writeJsonAtomic(itemsPath(), all);
  });
  return item;
}

export async function updateItem(
  id: string,
  patch: Partial<Pick<WorkItem, "title" | "cwd" | "tags" | "closedAt" | "source">>,
): Promise<WorkItem | null> {
  return serialized(async () => {
    const all = await readItems();
    const found = all.find((i) => i.id === id);
    if (!found) return null;
    Object.assign(found, patch);
    await writeJsonAtomic(itemsPath(), all);
    return found;
  });
}

export async function findBySource(provider: string, ref: string): Promise<WorkItem | null> {
  const all = await readItems();
  return all.find((i) => i.source?.provider === provider && i.source.ref === ref) ?? null;
}

/**
 * 认领一个外部引用：已经有对应的单就返回它，没有就建一张。
 *
 * 整个查找-建立在队列里，否则两个并发的认领会给同一个单号建出两张单。
 */
export async function ensureItemForSource(
  provider: string,
  ref: string,
  title?: string,
): Promise<WorkItem> {
  return serialized(async () => {
    const all = await readItems();
    const found = all.find((i) => i.source?.provider === provider && i.source.ref === ref);
    if (found) return found;
    const item: WorkItem = {
      id: newId(),
      title: title || ref,
      cwd: null,
      source: { provider, ref },
      tags: [],
      createdAt: Math.floor(Date.now() / 1000),
      closedAt: null,
    };
    all.push(item);
    await writeJsonAtomic(itemsPath(), all);
    return item;
  });
}
