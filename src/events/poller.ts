import { listSessions, type SessionSummary } from "../tmux/session-list";
import { publish } from "./bus";
import { diffSessions, type Snapshot } from "./diff";

/**
 * 服务端的会话轮询循环。
 *
 * 这是新造的东西，不是把既有机制接起来：在此之前服务端**没有**任何会话轮询——
 * 浏览器每五秒自己调一次 `/api/sessions`（`public/list.js`、`public/items.js`），
 * 服务端唯一的定时器是 60 秒的孤儿回收。所以一台没有浏览器连着的 tmux-next 几乎
 * 什么都不做，而那恰恰是事件流最该工作的时刻。
 *
 * 代价是实打实的：`listSessions()` 为每个会话起一次 `capture-pane` 子进程，负载按
 * 会话数线性增长。所以这个循环由需求驱动启停（见 `src/events/sse.ts` 的订阅/退订），
 * 没人订阅时它不跑，服务回到原本的静息状态。让"没人关心就不烧 CPU"成为结构性的
 * 事实，比调一个间隔值去平衡要可靠。
 */
const DEFAULT_INTERVAL_MS = 5000;

let timer: ReturnType<typeof setInterval> | null = null;
let snapshot = new Map<string, Snapshot>();
let busy = false;
let injected: (() => Promise<SessionSummary[]>) | null = null;

export function pollingActive(): boolean {
  return timer !== null;
}

/**
 * 换掉列举器。测试用——`eventsResponse` 无参调 `startPolling()`，没有这个缝，
 * SSE 的单元测试就会去打真的 tmux。这和 `collectFacets` 把来源列表留成可选参数
 * 是同一个理由：注册表是编译期常量，不给一条注入的缝就没办法证明这里的行为。
 */
export function setPollLister(lister: (() => Promise<SessionSummary[]>) | null): void {
  injected = lister;
}

/**
 * 跑一轮，返回发出去的事件条数。
 *
 * 列举失败时这一轮什么也不做，**并且保留快照**。清空快照会让下一轮把每个会话都重报
 * 一次 created；把异常放出去会让定时器永久停摆，而症状只是事件流安静下来，不会有
 * 任何东西报错。tmux 短暂不可用（正在重启）是正常情况，不是需要惊动调用方的事。
 */
export async function pollOnce(
  lister: () => Promise<SessionSummary[]> = injected ?? listSessions,
  publishChanges = true,
): Promise<number> {
  let current: SessionSummary[];
  try {
    current = await lister();
  } catch (e) {
    console.error("session poll failed", e);
    return 0;
  }

  const { drafts, next } = diffSessions(snapshot, current);
  snapshot = next;
  if (!publishChanges) return 0;
  for (const draft of drafts) publish(draft);
  return drafts.length;
}

export function startPolling(opts?: {
  lister?: () => Promise<SessionSummary[]>;
  intervalMs?: number;
}): void {
  if (timer) return;
  const lister = opts?.lister ?? injected ?? listSessions;

  // 起步先静默填一次快照。不填的话，第一轮会把机器上已经存在的每个会话都报成
  // `session.created`——说的是一件没发生过的事，而刚连上的客户端没有任何办法
  // 分辨"刚创建"和"这个进程第一次看见"。
  //
  // 它也要占住 busy：一台会话很多的机器上这一次列举可能慢过间隔，不占住的话第一个
  // 定时器滴答会和它并行跑，两份比对写同一张快照。
  busy = true;
  void pollOnce(lister, false).finally(() => { busy = false; });

  timer = setInterval(() => {
    // 一轮还没跑完就不开下一轮：一台会话很多的机器上 `capture-pane` 可能慢过间隔，
    // 叠加起来只会让它更慢。
    if (busy) return;
    busy = true;
    void pollOnce(lister).finally(() => { busy = false; });
  }, opts?.intervalMs ?? DEFAULT_INTERVAL_MS);
}

export function stopPolling(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * 测试专用：把快照也清掉。
 *
 * `stopPolling` 刻意不清快照——真实运行里最后一个订阅者走开又回来，不该收到一份
 * 把所有会话重报一遍的 created。
 */
export function resetPoller(): void {
  stopPolling();
  snapshot = new Map();
  busy = false;
  injected = null;
}
