import { sessionState } from "../agents/session-state";
import type { SessionSummary } from "../tmux/session-list";
import type { EventDraft } from "./types";

/**
 * 上一轮看到的、关于一个会话的全部内容。
 *
 * 刻意只存名字和状态：快照存在的唯一目的是回答"这一轮和上一轮比有什么不一样"，
 * 存进来的每个字段都是一个以后要维护的比对分支。路径和 agent 只在 created 里发一次，
 * 因为它们不会变——`session_path` 用的是会话打开时的目录，pane 里 `cd` 不会移动它。
 */
export type Snapshot = { name: string; state: "waiting" | "working" };

/**
 * 纯函数，事件流的全部判断都在这里。
 *
 * 按 `sessionId`（tmux 的 `$7`）索引而不是按名字：改名时 id 不变，所以一次改名是一条
 * `renamed` 而不是一死一生。反过来 id 会在 tmux server 重启时重排，但那种重启会带走
 * 所有会话，于是上一轮的快照整体作废、这一轮整体是新生，结论依然正确。
 *
 * 去重不需要任何额外机制：这里发的都是**状态变化**，状态没变就没有事件。这正是
 * "轮询和 hook 谁先发现谁发"能够成立的原因，不需要时间窗，也不需要记住是谁发过。
 */
export function diffSessions(
  previous: Map<string, Snapshot>,
  current: SessionSummary[],
): { drafts: EventDraft[]; next: Map<string, Snapshot> } {
  const drafts: EventDraft[] = [];
  const next = new Map<string, Snapshot>();

  for (const s of current) {
    const state = sessionState(s);
    next.set(s.sessionId, { name: s.name, state });
    const before = previous.get(s.sessionId);

    if (!before) {
      drafts.push({
        type: "session.created",
        session: s.name,
        data: { sessionId: s.sessionId, path: s.path, agent: s.agent, agentLabel: s.agentLabel },
      });
      continue;
    }

    if (before.name !== s.name) {
      drafts.push({
        type: "session.renamed",
        session: s.name,
        data: { sessionId: s.sessionId, previousName: before.name },
      });
    }

    if (before.state !== state) {
      drafts.push({
        type: "session.turn",
        session: s.name,
        data: { sessionId: s.sessionId, turn: state, previous: before.state },
      });
    }
  }

  // 死亡排在最后，一轮里既有新生又有死亡时顺序才是确定的，测试才钉得住。
  for (const [sessionId, before] of previous) {
    if (next.has(sessionId)) continue;
    drafts.push({
      type: "session.ended",
      session: before.name,
      data: { sessionId },
    });
  }

  return { drafts, next };
}
