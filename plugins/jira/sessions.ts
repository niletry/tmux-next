import { tmux } from "../../src/tmux/run";

/**
 * 活着的会话，连同它们的 tmux 内部 id。
 *
 * 内核的会话列表不查 #{session_id}（src/tmux/session-list.ts 的格式串里没有），
 * 所以这里自己问一次。走内核的 tmux(argv) 是插件依赖内核，方向正确——**不要**
 * 为此往内核的列表里加字段，那是内核为一个插件的需要长出概念。
 *
 * 分隔符用 | 与内核一致；session_id 形如 $7，不含分隔符，所以放在前面，把可能
 * 含 | 的名字留给贪婪的尾部。
 */

export type LiveSession = { id: string; name: string };

export async function liveSessions(): Promise<LiveSession[]> {
  const listed = await tmux(["list-sessions", "-F", "#{session_id}|#{session_name}"]);
  if (!listed.ok) return [];
  return listed.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((row) => {
      const cut = row.indexOf("|");
      return { id: row.slice(0, cut), name: row.slice(cut + 1) };
    })
    .filter((s) => s.id && s.name);
}
