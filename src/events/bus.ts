import type { AppEvent, EventDraft } from "./types";

export type { AppEvent, EventDraft, EventType } from "./types";

/**
 * 进程内事件总线。
 *
 * 只有一个真相来源：所有投递方式（SSE 扇出、Web Push、第 3 期的 Webhook）都是这里
 * 的订阅者，所以它们不可能对同一件事给出不同说法。这是把推送直接写在 `/api/notify`
 * 里那个做法要改掉的原因。
 *
 * 缓冲按**时间**保留而不是按条数：客户端关心的是"我离开了多久"，不是"这期间发生了
 * 多少事"。条数上限只是一个防失控的保险丝，正常情况下够不着。
 */
const RETAIN_SECONDS = 300;
const MAX_BUFFERED = 2000;

/**
 * 每个进程一个启动标识，进了事件 id。
 *
 * 没有它，重启之后 seq 从 1 重新开始，而客户端手里那个 `Last-Event-ID` 会指向新进程
 * 里的另一条事件——补发出去的东西看着完全正常，客户端没有任何办法发现自己错过了
 * 什么。带上它，重启就变成一次明确的 resync。
 */
let boot = crypto.randomUUID().slice(0, 8);
let seq = 0;
let buffer: AppEvent[] = [];
const subscribers = new Set<(event: AppEvent) => void>();

export function bootId(): string {
  return boot;
}

export function subscriberCount(): number {
  return subscribers.size;
}

export function subscribe(fn: (event: AppEvent) => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** `at` 可注入，测试才能推动时钟去验证缓冲的挤出行为。 */
export function publish(
  draft: EventDraft,
  at: number = Math.floor(Date.now() / 1000),
): AppEvent {
  seq += 1;
  const event: AppEvent = { ...draft, id: `evt_${boot}_${seq}`, seq, at };

  buffer.push(event);
  const cutoff = at - RETAIN_SECONDS;
  buffer = buffer.filter((e) => e.at > cutoff);
  if (buffer.length > MAX_BUFFERED) buffer = buffer.slice(-MAX_BUFFERED);

  for (const fn of subscribers) {
    // 一个订阅者抛异常不能带走其余订阅者，也不能带走发布方。
    try {
      fn(event);
    } catch (e) {
      console.error("event subscriber failed", e);
    }
  }
  return event;
}

/**
 * 一个重连的客户端能拿到什么。
 *
 * `{ ok: false }` 是"我跟不上了，你自己去重新拉一次列表"，调用方把它翻译成一条
 * `resync`。三种情况都落在这一个答案上——没带过 id 以外的任何不认识的形状、
 * 别的进程发的 id、已经被挤出缓冲的 id——因为对客户端来说它们的处置完全一样，
 * 而假装区分它们只会让客户端多写三个分支去做同一件事。
 */
export function replayFrom(
  lastEventId: string | null,
): { ok: true; events: AppEvent[] } | { ok: false } {
  if (!lastEventId) return { ok: true, events: [] };

  const match = lastEventId.match(/^evt_([0-9a-f]+)_(\d+)$/);
  if (!match) return { ok: false };
  if (match[1] !== boot) return { ok: false };

  const from = Number(match[2]);
  // 缓冲里最旧的一条必须不晚于 from+1，否则中间有事件已经被挤掉了。
  const oldest = buffer[0];
  if (oldest && oldest.seq > from + 1) return { ok: false };
  return { ok: true, events: buffer.filter((e) => e.seq > from) };
}

/** 测试专用：把总线恢复成刚启动的样子。 */
export function resetBus(): void {
  boot = crypto.randomUUID().slice(0, 8);
  seq = 0;
  buffer = [];
  subscribers.clear();
}
