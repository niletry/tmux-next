import type { Facet } from "../../plugins/types";
import type { WorkItem } from "./model";
import type { SessionSummary } from "../tmux/session-list";
import type { ResolvedBinding } from "./binding";
import { sessionState } from "../agents/session-state";

/**
 * 内核自己的维度。
 *
 * 跟插件贴上来的走同一条路、同一种形状，于是视图层的 group-by 不需要知道一个维度
 * 是内核的还是插件的——这正是"视图后边可以慢慢优化"能成立的前提。
 *
 * 纯函数：不碰磁盘、不碰 tmux。要什么由调用方查好了传进来，于是这里能无头地测。
 */

/** 一张单的 agent 状态：等你 › 在跑 › 没有会话。 */
type AgentState = "waiting" | "working" | "none";

const AGENT_TONE: Record<AgentState, Facet["tone"]> = {
  waiting: "warn",
  working: "ok",
  none: "dim",
};

/**
 * 一张单的 agent 状态。
 *
 * 只要有**一个**会话在等你，整张单就算等你——手机上第一眼要回答的是"该我动了吗"，
 * 而一个在等的会话不该被同一张单下另一个正在跑的会话盖过去。
 *
 * 状态集只有三个：等你 › 在跑 › 没有会话。没有"闲着"这个状态，因为每一条活着的
 * 会话要么在等（turn 或屏幕标记），要么在跑，二者必其一。
 */
function agentState(sessions: SessionSummary[]): AgentState {
  if (!sessions.length) return "none";
  const states = sessions.map(sessionState);
  if (states.includes("waiting")) return "waiting";
  return "working";
}

/** 一个终端窗口：这一格数的是会话。跟顶栏「会话」标签同一族形状。 */
const SESSION_ICON =
  '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/>';

export function kernelFacets(
  items: WorkItem[],
  sessions: SessionSummary[],
  bindings: ResolvedBinding[],
): Record<string, Facet[]> {
  const byName = new Map(sessions.map((s) => [s.name, s]));
  // 只认还活着的绑定：一条指向已死会话的记录是"这张单之前开过"，不是它现在的状态。
  const liveByItem = new Map<string, SessionSummary[]>();
  for (const b of bindings) {
    if (!b.live) continue;
    const found = byName.get(b.session);
    if (!found) continue;
    const list = liveByItem.get(b.itemId);
    if (list) list.push(found);
    else liveByItem.set(b.itemId, [found]);
  }

  const out: Record<string, Facet[]> = {};
  for (const item of items) {
    const mine = liveByItem.get(item.id) ?? [];
    const state = agentState(mine);
    const facets: Facet[] = [
      { dim: "item.agent", value: state, tone: AGENT_TONE[state] },
      // 图标而不是"会话"两个字：值是个光秃秃的数字，卡片上只画值时需要有东西
      // 说明它数的是什么，而图标只占一个字宽。为 0 时这颗 chip 根本不画（见
      // items.js 的 chipVisible），但维度本身照留——按会话数分组和筛选还得靠它。
      { dim: "item.sessions", value: String(mine.length), icon: SESSION_ICON },
    ];
    // badge：来源跟类型一起收进单号前面那枚徽标。这颗 chip 从来只写着 "jira"，
    // 而它旁边就是 JIRA-123 这个单号本身——同一件事说两遍，占的却是卡片上最贵的
    // 那一行。维度照留：按来源分组、筛选走的是数据，不是 chip。
    if (item.source) facets.push({ dim: "item.source", value: item.source.provider, badge: true });
    for (const tag of item.tags) facets.push({ dim: "item.tag", value: tag });
    out[item.id] = facets;
  }
  return out;
}
