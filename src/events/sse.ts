import { replayFrom, subscribe, subscriberCount, type AppEvent } from "./bus";
import { startPolling, stopPolling } from "./poller";

/**
 * 心跳间隔。反代和移动网络会掐掉长时间没有字节的连接，而一台安静的机器可以几十分钟
 * 没有任何会话事件。
 */
const HEARTBEAT_MS = 15_000;

function frame(event: AppEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * 一条 SSE 连接。
 *
 * 订阅与轮询的启停绑在这里：第一个订阅者让轮询跑起来，最后一个走开就停掉。这是
 * "没人关心就不烧 CPU"的落点——`listSessions()` 为每个会话起一次 `capture-pane`
 * 子进程，永远跑着的代价按会话数线性增长。
 *
 * `cancel` 必须退订并可能停掉轮询。少写这一段不会有任何测试变红，但每一次断线重连
 * 都会留下一个死订阅者，几小时之后一条事件要扇出给几百个已经没人读的流。
 */
export function eventsResponse(lastEventId: string | null): Response {
  const replay = replayFrom(lastEventId);
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // 客户端已经走了，下一次 cancel 会来收尾。
        }
      };

      if (!replay.ok) {
        // 跟丢了。这是关于**这条连接**的事实，不是关于会话的，所以它不进事件总线，
        // 也不会投递给（第 3 期的）Webhook——一次性的 Webhook 投递没有"跟丢"这回事。
        send(`event: resync\ndata: {}\n\n`);
      } else {
        for (const event of replay.events) send(frame(event));
      }

      unsubscribe = subscribe((event) => send(frame(event)));
      startPolling();

      heartbeat = setInterval(() => send(`:ping\n\n`), HEARTBEAT_MS);
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = null;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      if (subscriberCount() === 0) stopPolling();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // 反代默认攒够一块再吐，事件流会变成"几十秒一批"，看起来像服务端不发事件。
      "X-Accel-Buffering": "no",
    },
  });
}
