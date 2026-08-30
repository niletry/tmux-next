import { join } from "node:path";
import { mkdir, chmod, writeFile } from "node:fs/promises";
import { pluginStateDir } from "../state";

/**
 * Jira 凭据，以及只有它。
 *
 * 刻意不读 ~/.claude/credentials.md：那是 Claude Code 的约定文件，解析自由格式
 * Markdown 取凭据格式一飘就坏；更要紧的是它是一份**总账**，让这个无认证的服务
 * 去读它，等于把暴露面从 Jira 一家扩大到里面所有服务。首次配置把三项搬过来即可，
 * 之后两者互不相干。
 *
 * 模式跟 src/asr.ts 一样：没有文件就是"没配过"，不是错误。
 */

export type JiraConfig = { url: string; email: string; token: string; jql: string };

/** 分给我的、还没做完的，最近更新的在前。 */
export const DEFAULT_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

export function jiraConfigPath(): string {
  return join(pluginStateDir("jira"), "config.json");
}

/**
 * 存着的凭据，或者 null。
 *
 * 全函数：文件不在（最常见）、JSON 坏了、少了必填项，都读成"没配过"。没有一种
 * 值得让页面加载失败。
 */
export async function readJiraConfig(): Promise<JiraConfig | null> {
  try {
    const data = (await Bun.file(jiraConfigPath()).json()) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const url = str(data?.url).replace(/\/+$/, ""); // 末尾斜杠会拼出 //rest/api
    const email = str(data?.email);
    const token = str(data?.token);
    if (!url || !email || !token) return null;
    return { url, email, token, jql: str(data?.jql) || DEFAULT_JQL };
  } catch {
    return null;
  }
}

/** 写入并收紧权限。0600 在写内容之前设，中间没有一刻是宽的。 */
export async function writeJiraConfig(config: JiraConfig): Promise<void> {
  const path = jiraConfigPath();
  await mkdir(pluginStateDir("jira"), { recursive: true });
  await writeFile(path, JSON.stringify({ ...config, jql: config.jql || DEFAULT_JQL }, null, 2), {
    mode: 0o600,
  });
  // writeFile 的 mode 只在新建时生效；已存在的文件要显式收。
  await chmod(path, 0o600);
}
