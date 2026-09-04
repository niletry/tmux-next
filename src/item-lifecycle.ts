import type { Facet } from "../plugins/types";
import type { WorkItem } from "./items";
import type { ResolvedBinding } from "./session-binding";

/**
 * 单的进度状态机。见 docs/superpowers/specs/2026-09-04-item-lifecycle-writeback-design.md。
 *
 * 五档，不是六档：「已归档」不是这个枚举的第六个值，归档继续是 `WorkItem.closedAt`
 * 管的事——那条轴从 items 第一个提交就在，状态机不重复它。
 *
 * 只前进,不回退——`in_review` 及之后不可逆：一张单曾经开出过 PR 是不该被抹掉的
 * 事实，即使那个 PR 后来被关掉了。唯一允许回退的是还没到 `in_review` 时,所有
 * 绑定都失效导致 `hasLiveBinding` 变假,状态退回 `unclaimed`。
 */
export type ItemStatus = "unclaimed" | "in_progress" | "in_review" | "in_merge" | "done";

export const DEFAULT_ITEM_STATUS: ItemStatus = "unclaimed";

const KNOWN_STATUSES: readonly ItemStatus[] = [
  "unclaimed",
  "in_progress",
  "in_review",
  "in_merge",
  "done",
];

/** 全函数：不认识的值一律读成默认状态,旧文件没有这个字段时也走这条路。 */
export function sanitiseStatus(raw: unknown): ItemStatus {
  return typeof raw === "string" && (KNOWN_STATUSES as string[]).includes(raw)
    ? (raw as ItemStatus)
    : DEFAULT_ITEM_STATUS;
}

/**
 * 状态机要看的四个信号，从已经算好的 facet + 绑定信息里挤出来，不碰 I/O。
 *
 * `checksAllOk` 在没查到检查、或查到了但有失败的时都是 false——「没查到」不该被
 * 当成「过了」。
 */
export type LifecycleSignal = {
  hasLiveBinding: boolean;
  hasOpenPr: boolean;
  prMerged: boolean;
  checksAllOk: boolean;
};

/**
 * 从一张单的 facet 里挤出状态机信号。
 *
 * 只认 `jira.prs`/`jira.checks` 两个维度，读的是 `plugins/jira/server.ts` 里
 * `facetsFor` 已经定好的 tone 语义（`prFacetTone`/`checkFacetTone`）：PR 的
 * tone 是 undefined=OPEN／"dim"=MERGED／"warn"=DECLINED，checks 的顶层 tone 是
 * "ok"=全过／"warn"=有失败，且这个维度只在"问到过检查、且至少有一条"时才会
 * 出现——缺席本身就是"没查到"，跟"过了"是两回事。这是目前唯一贴 PR/检查信息
 * 的插件形状，但读的是 `Facet`/`FacetDetail` 这个通用契约，不是 Jira 插件私有
 * 的数据结构，明天换一个来源贴同样的维度，这个函数不用改一行。
 */
export function deriveSignal(facets: Facet[], hasLiveBinding: boolean): LifecycleSignal {
  const prs = facets.find((f) => f.dim === "jira.prs");
  const checks = facets.find((f) => f.dim === "jira.checks");

  const prDetails = prs?.detail ?? [];
  const openPrs = prDetails.filter((d) => d.tone === undefined);
  const mergedPrs = prDetails.filter((d) => d.tone === "dim");
  const hasOpenPr = openPrs.length > 0;
  // 至少一个真的合并了、且没有还开着的：只有被拒绝（declined）的 PR 不算合并。
  const prMerged = openPrs.length === 0 && mergedPrs.length > 0;

  const checksAllOk = checks?.tone === "ok";

  return { hasLiveBinding, hasOpenPr, prMerged, checksAllOk };
}

/**
 * 状态机核心。纯函数：喂 (当前状态, 信号) 吐出下一个状态,不落盘、不发请求。
 *
 * 五档之间总共四条前进边,外加一条"还没认领就先不谈"的回退边——直接列 switch
 * 就够,不需要真状态机库。
 */
export function nextStatus(current: ItemStatus, signal: LifecycleSignal): ItemStatus {
  switch (current) {
    case "unclaimed":
      return signal.hasLiveBinding ? "in_progress" : "unclaimed";
    case "in_progress":
      if (!signal.hasLiveBinding && !signal.hasOpenPr && !signal.prMerged) return "unclaimed";
      return signal.hasOpenPr || signal.prMerged ? "in_review" : "in_progress";
    case "in_review":
      if (signal.prMerged) return "done";
      if (signal.hasOpenPr && signal.checksAllOk) return "in_merge";
      return "in_review";
    case "in_merge":
      return signal.prMerged ? "done" : "in_merge";
    case "done":
      return "done";
  }
}

export type LifecycleTransition = { item: WorkItem; from: ItemStatus; to: ItemStatus };

/**
 * 一批单跑一轮状态机，只返回真正发生了迁移的那些。
 *
 * 空数组是最常见的返回值——大多数单这一轮什么都没变。写回层和通知总线只对这个
 * 列表里的条目动作，不用重新判断"变没变"。
 */
export function advanceLifecycle(
  items: WorkItem[],
  facetsByItem: Record<string, Facet[]>,
  bindings: ResolvedBinding[],
): LifecycleTransition[] {
  const liveByItem = new Set(bindings.filter((b) => b.live).map((b) => b.itemId));

  const out: LifecycleTransition[] = [];
  for (const item of items) {
    const signal = deriveSignal(facetsByItem[item.id] ?? [], liveByItem.has(item.id));
    const to = nextStatus(item.status, signal);
    if (to !== item.status) out.push({ item, from: item.status, to });
  }
  return out;
}
