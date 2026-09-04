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

/** CI 那一跳的凭据。缺了就只列 PR、不问构建状态，不是错误。 */
export type BitbucketConfig = { email: string; appPassword: string };

export type JiraConfig = {
  url: string;
  email: string;
  token: string;
  jql: string;
  bitbucket?: BitbucketConfig;
  /**
   * 只保留分支或标题里带着本单单号的 PR。默认开。
   *
   * Jira 的 dev-status 关联很松：提交信息里提到过别的单号，那个 PR 就会挂到这个单
   * 下面。实测样本里三个单有两个挂着别人的 PR，所以默认是过滤——一条挂错的 PR 会
   * 骗人，而被过滤掉的那些有计数摆在界面上，看得见也能一键关掉。
   */
  onlyKeyedPrs: boolean;
  /**
   * ItemLifecycle 的状态 → 这个 Jira 实例 workflow 里对应的状态名。
   *
   * 每一项都可留空，留空表示"这一步不写回"——不是每个 workflow 都刚好有四个
   * 对应的状态，这份自由必须给使用者，内核/插件都不该替它猜一个大概对的名字。
   * "unclaimed" 没有对应项：那是初始状态，不是一次迁移。
   */
  transitions: { inProgress: string; inReview: string; inMerge: string; done: string };
};

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

    // Bitbucket 是可选的：没有它，PR 照列，只是 CI 一栏是"没问到"。半份配置
    // （只有邮箱没有密码）当作没配，比拿它去打一串必然 401 的请求好。
    const bb = (data?.bitbucket ?? {}) as Record<string, unknown>;
    const bbEmail = str(bb.email);
    const bbPass = str(bb.appPassword);
    const bitbucket = bbEmail && bbPass ? { email: bbEmail, appPassword: bbPass } : undefined;

    const tr = (data?.transitions ?? {}) as Record<string, unknown>;

    return {
      url,
      email,
      token,
      jql: str(data?.jql) || DEFAULT_JQL,
      // 缺省即开：显式写 false 才关掉。
      onlyKeyedPrs: data?.onlyKeyedPrs !== false,
      transitions: {
        inProgress: str(tr.inProgress),
        inReview: str(tr.inReview),
        inMerge: str(tr.inMerge),
        done: str(tr.done),
      },
      ...(bitbucket ? { bitbucket } : {}),
    };
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
