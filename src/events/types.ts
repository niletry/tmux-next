/** 对外承诺的事件类型。新增要同步改 `/api/capabilities` 的 events 清单。 */
export type EventType =
  | "session.created"
  | "session.ended"
  | "session.renamed"
  | "session.turn"
  | "session.attention";

/** 生产者交给总线的东西：只说发生了什么，id / seq / 时间由总线盖。 */
export type EventDraft = {
  type: EventType;
  session: string;
  data: Record<string, unknown>;
};

/**
 * 投递给订阅者的信封。SSE 和（第 3 期的）Webhook 发的是同一个对象——一份定义、
 * 两种投递，两边就不可能对同一件事给出不同说法。
 *
 * `id` 用来去重，`seq` 用来发现缺口。两者不是冗余的：`id` 能让接收方认出重复投递，
 * 但认不出"有一条根本没送到"，而 Webhook 在重试耗尽时就是真的没送到。`seq` 跳号
 * 就是缺口。`id` 由 `seq` 加进程启动标识派生，所以没有第二个计数器要维护。
 */
export type AppEvent = EventDraft & {
  id: string;
  seq: number;
  /** epoch 秒，与会话资源的 `lastActivityEpoch` 同一单位。 */
  at: number;
};
