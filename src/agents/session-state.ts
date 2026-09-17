import type { SessionSummary } from "../tmux/session-list";

/**
 * 一个会话此刻是在等你还是在跑。
 *
 * `turn` 优先：它从 transcript 的 `stop_reason` 读出来，是记录格式的一部分。读不到
 * 才退回 `idle`——那是认 TUI 屏幕上的空闲标记，会随 agent 改版无声失效，所以只当
 * 兜底，不当依据。
 *
 * 这条规则有三个消费者：工单 facet（`src/items/facets.ts`）、会话列表页
 * （`public/session-state.js`，浏览器侧的同一条规则）、以及事件流的轮询比对
 * （`src/events/diff.ts`）。它住在这里而不是其中任何一个里面，是因为三份实现
 * 只要有一份说得不一样，页面和事件流就会对同一个会话给出两种状态，而不会有任何
 * 东西变红。
 *
 * 注意 `idle` 是本仓库对"在提示符等你"这个状态的既定叫法，不是"闲置"。
 */
export function sessionState(
  session: Pick<SessionSummary, "turn" | "idle">,
): "waiting" | "working" {
  if (session.turn) return session.turn;
  return session.idle ? "waiting" : "working";
}
