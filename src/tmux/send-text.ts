import { tmux } from "./run";
import { WEB_SESSION_PREFIX } from "./session-manager";

/**
 * 往一个会话里敲一行字，然后回车。
 *
 * 走 `tmux send-keys`，不经 WebSocket：从页面开一条 WS 会顺带建出一个
 * `web-<pid>-…` 挂载会话、附上控制客户端、并把窗口尺寸调成这个浏览器的大小——
 * 为发一行字付这些代价不划算，而且改尺寸这件事本身就是这个项目踩过的坑。
 *
 * **权限上没有新增任何东西**：任何能碰到这个服务的人本来就能通过 `/ws` 附上去随便
 * 打字，这条路只是更省事的同一件事。SECURITY.md 里那句"能碰到就等于有 shell"仍然
 * 是这里唯一要紧的判断。
 */

export type SendResult = { ok: true } | { ok: false; reason: "empty" | "toolong" | "internal" };

/**
 * 一次能敲多少。
 *
 * 不是安全边界（对面本来就能任意输入），是防手滑：把一整个文件粘进快捷回复框，
 * 在 TUI 里是一场灾难，而这个上限让它变成一条明确的拒绝。
 */
export const MAX_TEXT = 2000;

export async function sendText(session: string, text: string): Promise<SendResult> {
  const line = text.trim();
  if (!line) return { ok: false, reason: "empty" };
  if (line.length > MAX_TEXT) return { ok: false, reason: "toolong" };

  // 这个应用自己的挂载会话不该被当成收件人：它们是浏览器的接入点，不是人在用的
  // 会话，往里面敲字只会落到别人的窗口上。跟 killSession 同一条判断。
  if (session.startsWith(WEB_SESSION_PREFIX)) return { ok: false, reason: "internal" };

  // 目标写成 `=<name>:`，不是 `=<name>`。
  //
  // send-keys 的 -t 收的是 **target-pane**，跟 kill-session 的 target-session 不是
  // 同一套语法：`=web-1` 这种形式它直接报 "can't find pane"。末尾那个冒号才让它读成
  // 「这个会话的当前窗格」，而 `=` 仍然管住会话名的精确匹配——裸 `name` 也能通，但
  // 那就退回了前缀匹配，正是 `web` 会命中 `webmux` 的那个坑。
  const target = `=${session}:`;

  // 两步，而且第一步必须带 `-l`：不带的话 send-keys 会把参数当**键名**查表，
  // 于是一句以 "Enter" 或 "C-c" 开头的回复会变成一次按键而不是一行字。
  const typed = await tmux(["send-keys", "-t", target, "-l", line]);
  if (!typed.ok) return { ok: false, reason: "internal" };

  const submitted = await tmux(["send-keys", "-t", target, "Enter"]);
  return submitted.ok ? { ok: true } : { ok: false, reason: "internal" };
}
