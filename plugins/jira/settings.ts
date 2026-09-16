import { readJiraConfig, writeJiraConfig, DEFAULT_JQL, type JiraConfig } from "./config";
import { sync } from "./source";

/**
 * 设置页里 JQL 旁边那颗「完整同步」按钮。
 *
 * 只认一个 key：`full-sync`，别的一律 false——这不是给内核挡的（runPluginAction
 * 已经在清单这一层挡过一次），是给这个函数自己留一条"我不认识的键不装懂"的路。
 *
 * 成功与否要说的是用户按下这颗按钮时真正关心的事："这次点击有没有真的去问了
 * Jira"，不是"每一步内部细节都顺利"——那件事 sync() 本身就不区分：它对"还没
 * 配置"和"配置了但连不上/认证失败"用的是同一个返回值（零结果），原因见 sync()
 * 顶上的注释——background 的 start() 不该有一条异常路径能把启动流程带崩，那条
 * 边界现在仍然成立，改 sync() 的返回形状会连累 runSync()/start() 每一个调用方。
 * 所以这里能诚实回答的只有"配置存不存在"：没配置，这次点击注定什么都问不到，
 * 答 false；配置存在，就真的发了一轮网络请求，答 true——至于这一轮里某个字段
 * 认证失败或者连不上，那是 sync() 已经在打的日志，跟"点没点着"是两件事。
 */
export async function runAction(key: string): Promise<boolean> {
  if (key !== "full-sync") return false;
  const config = await readJiraConfig();
  if (!config) return false;
  await sync({ full: true });
  return true;
}

// --- 配置 -------------------------------------------------------------------
//
// 到这个版本为止，配置这个连接器的唯一办法是手写 ~/.tmux-next/jira/config.json——
// writeJiraConfig 一直在，却没有任何路由调它。下面这两个钩子把它接上设置页，而
// 内核那边照着清单里的 settings 声明画表单，并不知道这些字段是什么意思。

/**
 * 当前配置。**两个密钥只报设没设过，值不出这个函数。**
 *
 * 内核在 pluginSettings() 里还会再压一次，那是第二道闸；这里是第一道，也是本该
 * 存在的那道——值就不该离开插件。这个服务没有认证，token 一旦进了浏览器，就等于
 * 摊在任何能打开这个页面的东西面前，而配置它并不需要看见它。
 */
export async function readSettings(): Promise<Record<string, string | boolean>> {
  const config = await readJiraConfig();
  return {
    url: config?.url ?? "",
    email: config?.email ?? "",
    token: Boolean(config?.token),
    jql: config?.jql ?? DEFAULT_JQL,
    onlyKeyedPrs: config?.onlyKeyedPrs ?? true,
    "bitbucket.email": config?.bitbucket?.email ?? "",
    "bitbucket.appPassword": Boolean(config?.bitbucket?.appPassword),
    "transition.inProgress": config?.transitions?.inProgress ?? "",
    "transition.inReview": config?.transitions?.inReview ?? "",
    "transition.inMerge": config?.transitions?.inMerge ?? "",
    "transition.done": config?.transitions?.done ?? "",
  };
}

/**
 * 写入配置。**空的密钥表示"不改"，不是"清空"。**
 *
 * 这是密钥只写不读带来的必然结果：页面拿不到旧值，就没法把它原样回填，于是"没动
 * 这一格"和"想清空这一格"在请求里长得一样。二者取其一的话，保留旧值远比清空安全
 * ——误清一次要重新去 Jira 生成 token，而想清空还有直接删配置文件这条路。
 *
 * 三项必填缺一即拒：readJiraConfig 本来就把半份配置读成"没配过"，那么存下一份注定
 * 读不出来的东西，只会让人以为存成了。
 */
export async function writeSettings(values: Record<string, string | boolean>): Promise<void> {
  const old = await readJiraConfig();
  const str = (key: string, fallback: string) => {
    const v = values[key];
    return typeof v === "string" ? v.trim() : fallback;
  };
  /** 密钥：给了非空就用新的，否则留着旧的。 */
  const secret = (key: string, fallback: string) => {
    const v = values[key];
    return typeof v === "string" && v.trim() ? v.trim() : fallback;
  };

  const url = str("url", old?.url ?? "").replace(/\/+$/, ""); // 末尾斜杠会拼出 //rest/api
  const email = str("email", old?.email ?? "");
  const token = secret("token", old?.token ?? "");
  if (!url || !email || !token) throw new Error("incomplete");

  const bbEmail = str("bitbucket.email", old?.bitbucket?.email ?? "");
  const bbPass = secret("bitbucket.appPassword", old?.bitbucket?.appPassword ?? "");

  const next: JiraConfig = {
    url,
    email,
    token,
    jql: str("jql", old?.jql ?? DEFAULT_JQL) || DEFAULT_JQL,
    onlyKeyedPrs:
      typeof values.onlyKeyedPrs === "boolean" ? values.onlyKeyedPrs : (old?.onlyKeyedPrs ?? true),
    // 不是密钥，空值就是空值——不套 secret()那套"留空表示不改"的规则,清空一个
    // 映射项就该真的清空。
    transitions: {
      inProgress: str("transition.inProgress", old?.transitions?.inProgress ?? ""),
      inReview: str("transition.inReview", old?.transitions?.inReview ?? ""),
      inMerge: str("transition.inMerge", old?.transitions?.inMerge ?? ""),
      done: str("transition.done", old?.transitions?.done ?? ""),
    },
    // Bitbucket 半份等于没有——只有邮箱没有密码，拿去打的每个请求都必然 401，
    // 而界面会把那说成"检查没问到"，比诚实地说"没配"更糟。
    ...(bbEmail && bbPass ? { bitbucket: { email: bbEmail, appPassword: bbPass } } : {}),
  };
  await writeJiraConfig(next);
}
