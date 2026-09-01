import { readTailOf } from "./tail";
import { transcriptPath } from "../claude-activity";

/**
 * 一个会话此刻是在跑，还是在等你。
 *
 * 从 transcript 的结构里读出来，而不是认屏幕。会话列表现在用的是屏幕启发式——认
 * TUI 上的空闲标记——那种判断会随着 agent 改版无声失效，而 `stop_reason` 是记录
 * 格式的一部分：
 *
 *     assistant  stop_reason=end_turn   一轮说完了，球在你这边
 *     assistant  stop_reason=tool_use   还在调工具，球在它那边
 *
 * 同一份 transcript 尾部 `readTask` 已经在读了，所以这里不额外增加一次文件 IO。
 *
 * ---
 *
 * **这是过渡状态，不该长期存在。** 目前 `SessionSummary` 上同时有屏幕推出来的
 * `idle` 和这里读出来的 `turn`，两者可能对同一个会话给出不同说法。这么排是为了
 * 让新读法先在工单页上跑一段而不动会话列表。它必须收敛：要么列表页改用 `turn`
 * （那时 `idle` 只作为没有 transcript 时的兜底），要么这个字段连同本文件一起删掉。
 * 两种判断长期并存会变成"同一个会话在两个页面上说法不一致"，那比没有状态更糟。
 */

export type TurnState = "waiting" | "working";

/** 一条 transcript 记录里我们关心的部分。其余字段一律不看。 */
type Entry = { type?: unknown; message?: { stop_reason?: unknown } };

/**
 * 一段 transcript 尾部里，最后一次轮次交接的结果。
 *
 * 由构造决定的宽容：尾部读必然从半行开始，任何一行也可能因为写入被打断而残缺，
 * 两种都跳过而不是当成失败。除了 `user` 和带 stop_reason 的 `assistant`，别的记录
 * 类型（`system`、`attachment`、以及这个实例里出现的 `atis-latch`、`bridge-session`
 * 之类）全部忽略——它们不表示轮次归属。
 */
export function turnStateFrom(chunk: string): TurnState | null {
  let state: TurnState | null = null;

  for (const line of chunk.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;

    let entry: Entry;
    try {
      entry = JSON.parse(text) as Entry;
    } catch {
      continue;
    }

    if (entry.type === "user") {
      // 你刚说完话，那么无论上一条是什么，现在球都在它那边。
      state = "working";
      continue;
    }

    if (entry.type !== "assistant") continue;
    const stop = entry.message?.stop_reason;
    if (typeof stop !== "string") continue;

    // end_turn / stop_sequence 都表示"这一轮到此为止"；tool_use 表示还要继续。
    state = stop === "tool_use" ? "working" : "waiting";
  }

  return state;
}

/**
 * 一个 Claude 会话的轮次状态，读不出来就是 null。
 *
 * 全函数：没有 transcript（会话早于绑定记录、或者根本不是 Claude）、文件读不了、
 * 尾部里一条轮次记录都没有，都返回 null，由调用方退回原来的屏幕判断。
 */
export async function readTurnState(cwd: string, id: string): Promise<TurnState | null> {
  const chunk = await readTailOf(transcriptPath(cwd, id));
  return chunk === null ? null : turnStateFrom(chunk);
}
