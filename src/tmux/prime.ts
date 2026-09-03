import { agentOf } from "../agents";
import { tmux } from "./run";
import { sendText } from "./send-text";

/**
 * 会话建完之后，把首条输入敲进去。
 *
 * 难的不是敲，是**什么时候敲**：`new-session` 返回的时候里面那个 agent 还在启动，可能
 * 在装依赖、可能在问"信任这个目录吗"。所以先等它的 readyMarker（输入框空着）命中。
 *
 * 等不到就**放弃，不发**——这是这个模块唯一需要辩护的决定。超时的含义是 agent 还没到
 * 能收输入的状态，往那里敲一行字不是无害的：它会变成对一个确认框的回答。而不发的代价
 * 很小，那段文字刚刚还在创建页的框里，用户看得见它没进去，手动补一次远比误答一个 y/n
 * 便宜。
 */

/** 等一个会话就绪最多等多久。慢得可以接受，和卡住了，之间的那条线。 */
export const PRIME_TIMEOUT_MS = 20_000;

/** 两次 capture-pane 之间隔多久。 */
export const PRIME_POLL_MS = 250;

/**
 * 反复问屏幕，直到 marker 命中或预算用完。
 *
 * capture 和 sleep 都是注入的，所以这一层完全无头可测——真实的等待有二十秒，而要证的
 * 那条性质（命中就返回、耗尽就放弃）跟等多久无关。
 */
export async function waitForReady(
  capture: () => Promise<string | null>,
  marker: RegExp,
  opts: { budgetMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const budgetMs = opts.budgetMs ?? PRIME_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? PRIME_POLL_MS;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));

  for (let waited = 0; waited < budgetMs; waited += pollMs) {
    const screen = await capture();
    // 逐行判断，不是整屏 test()：marker 用 ^ 和 $ 锚定的是一行，而屏幕是多行的。
    if (screen && screen.split("\n").some((line) => marker.test(line))) return true;
    await sleep(pollMs);
  }
  return false;
}

/** 等这个会话就绪，然后敲一行字。等不到就什么也不做。 */
export async function primeSession(
  session: string,
  text: string,
  agentId?: unknown,
): Promise<void> {
  const marker = agentOf(agentId).screen.readyMarker;
  const ready = await waitForReady(async () => {
    // `=<name>:` —— capture-pane 的 -t 收的是 target-pane，末尾那个冒号才让它读成
    // 「这个会话的当前窗格」，而 = 管住会话名的精确匹配。跟 send-text.ts 同一条。
    const got = await tmux(["capture-pane", "-p", "-t", `=${session}:`]);
    return got.ok ? got.stdout : null;
  }, marker);
  if (!ready) return;
  await sendText(session, text);
}
