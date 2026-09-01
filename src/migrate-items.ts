import { join } from "node:path";
import { readJson } from "./json-store";
import { itemsPath, ensureItemForSource } from "./items";
import { bindSession } from "./session-binding";
import { pluginStateDir } from "../plugins/state";

/**
 * 把 Jira 插件私有的那份绑定搬进内核。
 *
 * 一次性、幂等：`items.json` 一旦存在就整个跳过。判据用文件是否存在而不是"有没有
 * 内容"，因为一个空的 items.json 是用户把单全归档掉的正当结果，再迁一次会把已经
 * 删掉的单变回来。
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

  // 串行而不是 Promise.all：ensureItemForSource 与 bindSession 各自排队，但同一个
  // 单号的两个会话必须先后跑，否则两次 ensure 都在对方写盘之前读到空表。
  let migrated = 0;
  for (const [session, binding] of entries) {
    const item = await ensureItemForSource("jira", binding.key, binding.key);
    await bindSession(session, item.id, binding.sessionId);
    migrated += 1;
  }
  return { migrated };
}
