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
let lastListingEmpty = false;

/**
 * 启停代数。每次 `startPolling` / `stopPolling` 加一。
 *
 * 在途的那一轮不会因为 `stopPolling` 而消失，它只是变得**过期**。没有这个计数器的话：
 * 起步的静默轮询把 `busy` 占上 → 最后一个订阅者走开 → `stopPolling`（旧代码不清
 * `busy`，清了也一样错）→ 新订阅者来 → `startPolling` 起第二次静默轮询 → 这时第一轮
 * 的 `.finally` 落地，把 `busy` 清成 false，而第二轮还在飞 → 下一个滴答又起第三轮，
 * 两轮并行写同一张快照，重复的 created 就是这么来的。而"订阅者走光又回来"对这个特性
 * 恰恰是常态路径，不是边角。
 */
let generation = 0;

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
 *
 * **但失败几乎从不走 try/catch。** `listSessions()`（`src/tmux/session-list.ts`）在
 * tmux 调用失败时返回 `[]`，不抛。于是一次短暂的 tmux 抖动会被当成"机器上一个会话
 * 都没有了"，这一轮为每个会话发一条 `session.ended`，下一轮成功之后再为每个会话发一条
 * `session.created`——每个订阅者都被告知整台机器清空又重建了一遍。
 *
 * 修在这里而不是修 `listSessions` 的返回契约：那个函数被单列表路由和 Jira 来源共用，
 * 为轮询一个人的问题去改它，要动这条分支之外的调用方。所以规则落在轮询侧：
 * **快照非空而这一轮列举为空时跳过这一轮，第二次连续的空才信。** 代价是一次真正的
 * 群体退出会晚一个间隔才报出来——比每次 tmux 打嗝都报一次假的便宜得多。
 *
 * `stillCurrent` 是启停代数的守卫，见 `generation`。默认永远为真，所以直接调
 * `pollOnce` 的测试不受影响。
 */
export async function pollOnce(
  lister: () => Promise<SessionSummary[]> = injected ?? listSessions,
  publishChanges = true,
  stillCurrent: () => boolean = () => true,
): Promise<number> {
  let current: SessionSummary[];
  try {
    current = await lister();
  } catch (e) {
    console.error("session poll failed", e);
    return 0;
  }

  // 这一轮已经过期了（中途 stopPolling 过）：结果不许落进快照，也不许发布。
  if (!stillCurrent()) return 0;

  if (current.length === 0 && snapshot.size > 0 && !lastListingEmpty) {
    lastListingEmpty = true;
    return 0;
  }
  lastListingEmpty = current.length === 0;

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
  generation += 1;
  const gen = generation;
  // 这一轮的结果只有在代数没变的时候才算数，`busy` 也只有它自己那一代能清——一轮
  // 过期的轮询落地时清掉 `busy`，正好会放行一轮和现役轮询并行的比对。
  const current = () => gen === generation;
  const run = (publishChanges: boolean) => {
    busy = true;
    void pollOnce(lister, publishChanges, current).finally(() => {
      if (current()) busy = false;
    });
  };

  // 起步先静默填一次快照。不填的话，第一轮会把机器上已经存在的每个会话都报成
  // `session.created`——说的是一件没发生过的事，而刚连上的客户端没有任何办法
  // 分辨"刚创建"和"这个进程第一次看见"。
  //
  // 它也要占住 busy：一台会话很多的机器上这一次列举可能慢过间隔，不占住的话第一个
  // 定时器滴答会和它并行跑，两份比对写同一张快照。
  run(false);

  timer = setInterval(() => {
    // 一轮还没跑完就不开下一轮：一台会话很多的机器上 `capture-pane` 可能慢过间隔，
    // 叠加起来只会让它更慢。
    if (busy) return;
    run(true);
  }, opts?.intervalMs ?? DEFAULT_INTERVAL_MS);
}

export function stopPolling(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  // 代数一加，还在飞的那一轮就作废了：它的结果不会落进快照，也不会把 `busy` 清掉给
  // 下一次 `startPolling` 起的轮询添乱。`busy` 本身留给下一次 `startPolling` 去置位。
  generation += 1;
  // 停着的这段时间快照会变陈旧，"连续两次空列举才信"的计数不该跨越这个缺口。
  lastListingEmpty = false;
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
  lastListingEmpty = false;
}
