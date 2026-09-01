import { basename } from "node:path";
import type { Facet } from "../plugins/types";
import type { WorkItem } from "./items";
import type { SessionSummary } from "./tmux/session-list";
import type { ResolvedBinding } from "./session-binding";

/**
 * 内核自己的维度。
 *
 * 跟插件贴上来的走同一条路、同一种形状，于是视图层的 group-by 不需要知道一个维度
 * 是内核的还是插件的——这正是"视图后边可以慢慢优化"能成立的前提。
 *
 * 纯函数：不碰磁盘、不碰 tmux。要什么由调用方查好了传进来，于是这里能无头地测。
 */

/** 一张单的 agent 状态：等你 › 在跑 › 闲着 › 没有会话。 */
type AgentState = "waiting" | "working" | "idle" | "none";

const AGENT_TONE: Record<AgentState, Facet["tone"]> = {
  waiting: "warn",
  working: "ok",
  idle: "dim",
  none: "dim",
};

/**
 * 一条会话此刻算在跑还是在等。
 *
 * `turn` 优先：它从 transcript 的 stop_reason 读出来，是记录格式的一部分。读不到
 * 才退回 `idle`——那是认 TUI 屏幕上的空闲标记，会随 agent 改版无声失效，所以只当
 * 兜底，不当依据。
 */
function stateOf(session: SessionSummary): "waiting" | "working" | "idle" {
  if (session.turn) return session.turn;
  return session.idle ? "idle" : "working";
}

/**
 * 一张单的 agent 状态。
 *
 * 只要有**一个**会话在等你，整张单就算等你——手机上第一眼要回答的是"该我动了吗"，
 * 而一个在等的会话不该被同一张单下另一个正在跑的会话盖过去。
 */
function agentState(sessions: SessionSummary[]): AgentState {
  if (!sessions.length) return "none";
  const states = sessions.map(stateOf);
  if (states.includes("waiting")) return "waiting";
  if (states.includes("working")) return "working";
  return "idle";
}

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
      { dim: "item.sessions", value: String(mine.length) },
    ];
    if (item.cwd) facets.push({ dim: "item.cwd", value: basename(item.cwd) });
    if (item.source) facets.push({ dim: "item.source", value: item.source.provider });
    for (const tag of item.tags) facets.push({ dim: "item.tag", value: tag });
    out[item.id] = facets;
  }
  return out;
}
