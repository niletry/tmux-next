import { headEventId, replayFrom, subscribe, subscriberCount, type AppEvent } from "./bus";
import { pollingActive, startPolling, stopPolling } from "./poller";

/**
 * 心跳间隔。反代和移动网络会掐掉长时间没有字节的连接，而一台安静的机器可以几十分钟
 * 没有任何会话事件。
 *
 * **这个值和 `src/server.ts` 里 `Bun.serve` 的 `idleTimeout: 120` 是一对，改一个就要
 * 看另一个。** Bun 自己也会在连接静默超过 `idleTimeout` 秒后掐掉它，所以心跳间隔必须
 * 明显小于那个秒数，否则每条事件流都会在服务端自己手上断掉——而症状是"客户端每两分钟
 * 重连一次"，看起来像网络问题。默认的 `idleTimeout` 是 10 秒，比这里的 15 秒还短；
 * 那一行不是随手写的配置，是这个特性的前提。
 */
const HEARTBEAT_MS = 15_000;

/**
 * 开流第一帧。
 *
 * **SSE 必须立刻写出字节。** Bun 在流产出第一块数据之前不会把响应头刷给客户端，而
 * 常见路径（新连接、没有 `Last-Event-ID`、补发为空）本来一个字节都不写——于是响应头
 * 要等到 15 秒后的第一次心跳才到，`EventSource.onopen` 跟着晚 15 秒。实测过：这样的
 * 连接头部 15015ms 才到，先垫一块就是 2ms。任何连接超时短于心跳间隔的客户端（5 秒、
 * 10 秒都是常见默认值）会对着一台完全健康的服务器永远地超时重连。
 *
 * 所以这一帧看起来像个什么都没做的空操作，但它是这条流能用的前提，不要删。
 * 顺带把 `retry` 钉在这里：重连间隔由服务端说了算，而能说这句话的最早时机就是现在。
 */
const PRIMER = "retry: 3000\n\n:ok\n\n";

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
  // 必须在 `startPolling()` 之前读。轮询在最后一个订阅者走开之后是停着的，而
  // `startPolling` 起步那次静默填快照会把"停着的这段时间里发生的全部变化"直接写进
  // 快照、一条事件都不发。此时 `replayFrom` 会诚实地回答 `{ ok: true, events: [] }`,
  // 也就是服务端明确告诉客户端"你没错过任何东西"——而那是假的。
  //
  // 这不是边角情况：只有一个订阅者时，每一次移动网络抖动都会把轮询关掉，
  // `EventSource` 三秒后回来，中间这三秒没人看着。
  //
  // 裁决和另外三种 resync 的原因（不认识的 id 形状、别的进程的 boot、已经被挤出缓冲
  // 的 id）完全一样：服务端没有资格认一个它没在看的时间段，所以这也是 resync。
  // 把"没拿到"说成"没有"，是在看起来整洁的方向上说谎。
  const wasPolling = pollingActive();
  // `replayFrom` 与下面的 `subscribe` 之间没有任何 `await`，这是**承重**的：
  // `ReadableStream` 的 `start` 在构造期间同步跑完，所以补发和订阅之间不存在任何
  // 事件循环的缝，`publish()` 挤不进来。以后谁在这两者之间插一个 `await`，就会打开
  // 一个悄无声息的丢事件窗口——丢掉的恰好是重连那一瞬间发生的事。
  const replay: ReturnType<typeof replayFrom> =
    lastEventId && !wasPolling ? { ok: false } : replayFrom(lastEventId);
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

      // 见 PRIMER 的注释：第一句话必须是写字节，排在补发分支之前。
      send(PRIMER);

      if (!replay.ok) {
        // 跟丢了。这是关于**这条连接**的事实，不是关于会话的，所以它不进事件总线，
        // 也不会投递给（第 3 期的）Webhook——一次性的 Webhook 投递没有"跟丢"这回事。
        //
        // 带 `id:` 是必需的：客户端手里那个对不上的 id（多半来自上一个进程）必须被
        // 挪到本进程的编号上，否则浏览器的 `lastEventId` 原封不动，下一次重连还是
        // resync，在一台安静的机器上就是永远 resync。
        send(`id: ${headEventId()}\nevent: resync\ndata: {}\n\n`);
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
