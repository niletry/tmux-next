import { join } from "node:path";
import { readJson, writeJsonAtomic, serialized } from "./json-store";
import { itemsPath, readItems, type WorkItem } from "./items";
import { bindingsPath, readBindings, type Binding } from "./session-binding";
import { pluginStateDir } from "../plugins/state";

/**
 * 把 Jira 插件私有的那份绑定搬进内核。
 *
 * 一次性、幂等：`items.json` 一旦存在就整个跳过。判据用文件是否存在而不是"有没有
 * 内容"，因为一个空的 items.json 是用户把单全归档掉的正当结果，再迁一次会把已经
 * 删掉的单变回来。
 *
 * **写盘顺序是关键，不是随手为之。** 先前的实现在第一次 `ensureItemForSource`
 * 时就把 items.json 写出来了——那正是幂等判据依赖的文件，于是进程在迁移中途死掉
 * （Ctrl-C、launchd 重启、磁盘满）就会把"迁了一半"锁成永久状态：下次启动看见
 * items.json 存在，直接判"已迁完"返回，剩下的绑定再也不会补上，页面上也不报错。
 *
 * 现在整个迁移先在内存里把两张表都建完，一次性写 bindings.json（合并进已有内容，
 * 不覆盖内核原生的绑定），最后才写 items.json——因为它是判据本身。这样任何一步
 * 崩溃，items.json 都还不存在，下次启动会把旧文件（从不删除）整个重新迁一遍，
 * 而 ensureItemForSource 式的去重逻辑保证收敛到同一组结果。真正让这个操作看起来
 * "原子"的，是最后才写守卫文件这件事，而不是某种事务机制。
 *
 * **不删旧文件。** 留一版回退证据：迁移出了问题时，那份文件是唯一能对照的东西。
 */

type OldBinding = { key: string; sessionId: string; boundAt: number };

export async function migrateJiraBindings(): Promise<{ migrated: number }> {
  if (await Bun.file(itemsPath()).exists()) return { migrated: 0 };

  const oldPath = join(pluginStateDir("jira"), "bindings.json");
  const old = await readJson<Record<string, OldBinding>>(oldPath, {}, (raw) => {
    const data = raw as Record<string, unknown>;
    const out: Record<string, OldBinding> = {};
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
  });

  const entries = Object.entries(old);
  if (!entries.length) return { migrated: 0 };

  // 第一步：全在内存里建表，不碰任何文件。同一个单号的多个会话共用一张单——
  // 用 provider+ref 去重，跟 ensureItemForSource 的语义保持一致。
  const existingItems = await readItems();
  const itemByRef = new Map<string, WorkItem>(
    existingItems
      .filter((i) => i.source?.provider === "jira")
      .map((i) => [i.source!.ref, i]),
  );
  const newItems: WorkItem[] = [];
  const newBindings: Record<string, Binding> = {};

  let migrated = 0;
  for (const [session, binding] of entries) {
    let item = itemByRef.get(binding.key);
    if (!item) {
      item = {
        id: newId(),
        title: binding.key,
        source: { provider: "jira", ref: binding.key },
        tags: [],
        createdAt: Math.floor(Date.now() / 1000),
        closedAt: null,
      };
      itemByRef.set(binding.key, item);
      newItems.push(item);
    }
    newBindings[session] = {
      itemId: item.id,
      sessionId: binding.sessionId,
      boundAt: binding.boundAt,
    };
    migrated += 1;
  }

  // 第二步：先写 bindings.json，合并进已有内容——绝不覆盖内核原生的绑定。
  await serialized(async () => {
    const current = await readBindings();
    await writeJsonAtomic(bindingsPath(), { ...current, ...newBindings });
  });

  // 第三步：最后写 items.json。它是幂等判据，写完这一步之后崩溃才算真正"迁完"。
  await serialized(async () => {
    const current = await readItems();
    const currentIds = new Set(current.map((i) => i.id));
    const toAppend = newItems.filter((i) => !currentIds.has(i.id));
    await writeJsonAtomic(itemsPath(), [...current, ...toAppend]);
  });

  return { migrated };
}

/** `it-` + 时间 + 随机：时间让它大致有序，随机让同一秒内建的两张不撞。 */
function newId(): string {
  return `it-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
