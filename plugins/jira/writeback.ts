import type { JiraConfig } from "./config";

/**
 * ItemLifecycle 写回 Jira 的动作。见
 * docs/superpowers/specs/2026-09-04-item-lifecycle-writeback-design.md。
 *
 * 只写 Jira 状态，不写 PR——评论区是给人看的地方，不该由工具自动灌水。
 *
 * `fetcher` 是参数而不是直接用全局 fetch，跟 client.ts/dev.ts 同一个理由：这个
 * 仓库的测试跑得很勤，对着别人的 Jira 打是不可接受的。
 *
 * 不吞异常——调用方（`plugins/jira/server.ts` 的 `onLifecycleChange`，经
 * `plugins/handlers.ts` 的 `notifyLifecycleChange`）已经在外层 try/catch，
 * "失败只是这一步没写成"这条语义在那一层实现一次就够，这里如实抛出。
 */

const TIMEOUT_MS = 8000;

function basic(user: string, secret: string): string {
  return "Basic " + btoa(`${user}:${secret}`);
}

/**
 * 把一张 Jira 工单转到 `targetStatus` 命名的状态。
 *
 * Jira 的 transitions 不是"改一个字段"，是"执行一个从当前状态出发的动作"，每个
 * 动作有自己的 id、且只在当前状态下可用——所以要先问一遍"从这里能去哪"，找到
 * 目的地是 `targetStatus` 的那个动作 id，再执行它。目的地名字大小写不敏感，因为
 * 工单的显示名和 API 返回的名字大小写不一定完全一致。
 *
 * 找不到匹配的目的地就什么也不做——工单可能已经在那个状态、也可能这个 workflow
 * 压根没有这条路，两者都不是"失败"，是"这一步不适用"。
 */
export async function transitionIssue(
  config: JiraConfig,
  issueKey: string,
  targetStatus: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!targetStatus.trim()) return;

  const auth = basic(config.email, config.token);
  const base = `${config.url}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`;

  const listRes = await fetcher(base, {
    headers: { authorization: auth, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!listRes.ok) throw new Error(`transitions 查询失败：${listRes.status}`);
  const data = (await listRes.json()) as { transitions?: Array<{ id: string; to?: { name?: string } }> };
  const wanted = targetStatus.trim().toLowerCase();
  const match = (data.transitions ?? []).find((t) => t.to?.name?.trim().toLowerCase() === wanted);
  if (!match) return; // 已经在目标状态，或者这个 workflow 没有这条路——都不是错误。

  const doRes = await fetcher(base, {
    method: "POST",
    headers: {
      authorization: auth,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ transition: { id: match.id } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!doRes.ok) throw new Error(`transitions 执行失败：${doRes.status}`);
}
