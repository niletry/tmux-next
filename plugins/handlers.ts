import { PLUGINS } from "./registry.js";
import type { Plugin, PluginEnricher, PluginHandler, SettingValue } from "./types";
import { SOURCE_TIMEOUT_MS, type ItemSourceProvider } from "../src/items/sources";
import { handle as gallery } from "./gallery/server";
import { handle as notifications } from "./notifications/server";
import { handle as supervisor } from "./supervisor/server";
import {
  handle as jira,
  start as jiraStart,
  readSettings as jiraReadSettings,
  writeSettings as jiraWriteSettings,
  runAction as jiraRunAction,
  source as jiraSource,
} from "./jira/server";

/**
 * 插件的服务端那一半。
 *
 * 跟 registry.js 分开，是因为那张表要被浏览器 import：清单里只要引到一个 .ts，
 * 服务端代码就被打进浏览器包。plugins/registry.test.ts 有一条断言专守这个。
 */
/**
 * 一个插件的服务端能力，由它自己声明有哪些。
 *
 * 从前这里是两张平行的表（一张 handle、一张 annotate），加一种能力就要再加一张，
 * 而"某个插件在这张表里、不在那张表里"没有任何东西在检查。合成一张之后，插件能做
 * 什么写在一处，registry.test.ts 也能检查注册表与它同步。
 */
export type PluginServer = {
  handle?: PluginHandler;
  /**
   * 这个插件交出的数据源，零个或多个。一个来源认领一个 `WorkItem.source.provider`，
   * 同步/刷新/贴 chip/喂字段/状态写回五件事都挂在它身上——内核按 provider 字符串
   * 查这张表，从不知道插件 id。契约和全部分派在 src/items/sources.ts。
   */
  sources?: ItemSourceProvider[];
  /**
   * 插件级的 enrich：**收到全部单**，不管它们有没有来源、来源是谁。给那些想按
   * 自己的口径给每张单贴 chip 的插件用（比如按 git 分支）。绑定到某一个来源的
   * enrich 不写在这里，写在那个来源的 `ItemSourceProvider.enrich` 上——那一个
   * 只会收到 provider 匹配的单。两条路的预算和净化完全相同（ENRICH_TIMEOUT_MS）。
   */
  enrich?: PluginEnricher;
  /**
   * 进程启动时给这个插件一次机会。同步、不返回值——内核不等它。想做异步的事
   * （比如开机同步一次来源），插件自己在里面 fire-and-forget，不能指望内核帮它 await。
   */
  start?: () => void;
  /**
   * 这个插件当前的配置值。**密钥只报 set，不报值**——内核在 pluginSettings() 里
   * 再兜一层，但第一道闸在这里：值就不该离开插件。
   */
  readSettings?: () => Promise<Record<string, SettingValue>>;
  /**
   * 写入配置。收到的是清单声明过的键；空字符串的 secret 表示"不改"，由插件解释——
   * 内核不知道哪个键是密钥的旧值存在哪。抛出即失败，调用方只会知道"没存上"。
   */
  writeSettings?: (values: Record<string, string | boolean>) => Promise<void>;
  /**
   * 设置页那颗动作按钮按下去要做的事，`key` 是清单里 actions[].key 之一——
   * 内核在 runPluginAction() 里已经挡过一次"清单没声明的键不传进来"，这里
   * 只管认识自己声明过的那几个。返回值是"做没做成"，页面据此显示哪句回执。
   */
  runAction?: (key: string) => Promise<boolean>;
};

export const SERVERS: Record<string, PluginServer> = {
  gallery: { handle: gallery },
  notifications: { handle: notifications },
  supervisor: { handle: supervisor },
  jira: {
    handle: jira,
    start: jiraStart,
    readSettings: jiraReadSettings,
    writeSettings: jiraWriteSettings,
    runAction: jiraRunAction,
    sources: [jiraSource],
  },
};

/**
 * 启用的插件。env 在这里现读——读 env 是服务端的事，放进同构的 registry.js 等于
 * 埋一个只在浏览器炸的调用。前端要知道启用了什么，走 GET /api/plugins。
 */
export function enabledPlugins(): Plugin[] {
  const off = new Set(
    (process.env.TMUX_NEXT_DISABLE_PLUGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return PLUGINS.filter((p) => !off.has(p.id));
}

/**
 * 单个配置值的长度上限。JQL 可以很长，token 也不短，但没有哪一项该到 4KB——
 * 上限存在是为了让"往这个无认证服务里灌东西"这条路有个尽头，不是为了校验格式。
 */
export const MAX_SETTING_LEN = 4096;

async function withTimeout<T>(work: Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
  const timeout = new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs));
  try {
    return await Promise.race([work, timeout]);
  } catch {
    return fallback;
  }
}

/**
 * 一个插件是否该被这一轮考虑：不在真注册表里的（测试注进来的假插件）一律放行，
 * 在真注册表里的看 `enabledPlugins()`。
 *
 * `startPlugins` 和三个设置/动作函数都要这条判断：`TMUX_NEXT_DISABLE_PLUGINS`
 * 关掉一个插件本该让它的 tab、API、页面一起消失（CLAUDE.md 的原话）。
 *
 * src/items/sources.ts 里有一份同样的判断，故意不共用：那边守的是"来源"这条
 * 完全独立的路（它直接调 `refreshItem`，不经过 `/api/<id>` 的 404 闸门），而
 * 这两个文件互相 import 已经是一个 ESM 环，再从环的另一头取一个函数只会把
 * 环收得更紧——一个五行的谓词，两份比一个跨环依赖便宜。
 */
function isConsidered(id: string, enabled: Set<string>): boolean {
  return !PLUGINS.some((real) => real.id === id) || enabled.has(id);
}

/**
 * 给每个声明了 `start` 的插件一次进程启动时的机会，逐个调、互不影响。
 *
 * 同步函数，不返回 Promise——调用方（CLI 入口）不 await 它，端口该开还是照开。
 * 插件想做异步的事，自己在 `start()` 里 fire-and-forget。失败语义跟这个接缝
 * 别处一样：一个插件的 start 抛了，等于它这次没有启动动作，不连累别的插件、
 * 更不能挡住服务器起来，所以逐个包 try/catch 而不是包在外层一次。
 *
 * servers/plugins 作为参数、真表做默认值：注册表是编译期常量，不注入就没法
 * 证明"一个插件抛了不挡别的插件"这条安全阀真的会兜住。
 */
export function startPlugins(
  servers: Record<string, PluginServer> = SERVERS,
  plugins: Plugin[] = PLUGINS,
): void {
  const enabled = new Set(enabledPlugins().map((p) => p.id));
  const ids = plugins
    .filter((p) => isConsidered(p.id, enabled))
    .map((p) => p.id)
    .filter((id) => servers[id]?.start);

  for (const id of ids) {
    try {
      servers[id]!.start!();
    } catch {
      // 这个插件这次没有启动动作，别的插件照常来。
    }
  }
}

/**
 * 一个插件当前的配置值，读不到就是 null。
 *
 * 失败语义跟这个文件里其余几条一样只有一种：**拿不到就当没有**。插件没声明
 * readSettings、抛了、卡住了、被 TMUX_NEXT_DISABLE_PLUGINS 关掉了，对调用方都是
 * 同一个 null，页面据此不画这一节。分出更细的状态只会让页面替内核解释插件的毛病。
 *
 * 密钥在这里再兜一层：清单里声明为 secret 的键，无论插件回了什么，一律压成
 * `{ set: 布尔 }`。插件那边本来就该这么做，但"值绝不出门"这件事不能只靠一处自觉
 * ——这个服务没有认证，泄一次就是泄给任何能打开页面的东西。
 */
export async function pluginSettings(
  id: string,
  servers: Record<string, PluginServer> = SERVERS,
  plugins: Plugin[] = PLUGINS,
  timeoutMs = SOURCE_TIMEOUT_MS,
): Promise<Record<string, SettingValue> | null> {
  const enabled = new Set(enabledPlugins().map((p) => p.id));
  if (!isConsidered(id, enabled)) return null;
  const read = servers[id]?.readSettings;
  const fields = plugins.find((p) => p.id === id)?.settings;
  if (!read || !fields) return null;

  const got = await withTimeout(read().catch(() => null), null, timeoutMs);
  if (!got || typeof got !== "object") return null;

  const out: Record<string, SettingValue> = {};
  for (const field of fields) {
    const raw = (got as Record<string, unknown>)[field.key];
    if (field.type === "secret") {
      // 只留一个比特。插件回了字符串也当"设过了"，绝不把它带出去。
      out[field.key] = { set: typeof raw === "string" ? raw.length > 0 : Boolean(raw) };
    } else if (field.type === "boolean") {
      out[field.key] = Boolean(raw);
    } else {
      out[field.key] = typeof raw === "string" ? raw : "";
    }
  }
  return out;
}

/**
 * 写入一个插件的配置。写成了返回 true，其余一切都是 false。
 *
 * 只把**清单声明过**的键交给插件：请求体里多出来的字段一律丢掉。否则这个无认证的
 * 服务就成了一个任意 JSON 写入器，插件那边多一个没料到的键就可能变成一条新配置。
 * 类型也在这里对齐——boolean 字段收到字符串就按真假归一，不把 "false" 这种东西
 * 原样传下去。
 */
export async function savePluginSettings(
  id: string,
  values: unknown,
  servers: Record<string, PluginServer> = SERVERS,
  plugins: Plugin[] = PLUGINS,
  timeoutMs = SOURCE_TIMEOUT_MS,
): Promise<boolean> {
  const enabled = new Set(enabledPlugins().map((p) => p.id));
  if (!isConsidered(id, enabled)) return false;
  const write = servers[id]?.writeSettings;
  const fields = plugins.find((p) => p.id === id)?.settings;
  if (!write || !fields || !values || typeof values !== "object") return false;

  const incoming = values as Record<string, unknown>;
  const clean: Record<string, string | boolean> = {};
  for (const field of fields) {
    if (!(field.key in incoming)) continue;
    const raw = incoming[field.key];
    if (field.type === "boolean") clean[field.key] = raw === true || raw === "true";
    else if (typeof raw === "string") clean[field.key] = raw.slice(0, MAX_SETTING_LEN);
    // 别的类型（数字、对象、null）直接忽略：清单说了是字符串，来的不是，就是不认。
  }
  if (!Object.keys(clean).length) return false;

  return await withTimeout(
    write(clean).then(
      () => true,
      () => false,
    ),
    false,
    timeoutMs,
  );
}

/**
 * 设置页那颗动作按钮，比如 Jira 的「完整同步」。
 *
 * 跟 pluginSettings/savePluginSettings 一模一样的形状：`isConsidered` 挡关掉的
 * 插件，`timeoutMs` 默认 SOURCE_TIMEOUT_MS——这是显式的一次按钮点击，允许真的
 * 发网络请求，30 秒是这类动作已经在用的预算，没道理另开一个。
 *
 * 只把**清单声明过**的 key 交给插件：请求里的 key 是任意字符串，不挡的话这个
 * 无认证的服务就是一个任意字符串执行器——跟 savePluginSettings 只认声明过的
 * 配置键同一个理由。servers/plugins 作为参数、真表做默认值，理由也一样：
 * 注册表是编译期常量，没有这个参数就没法塞进"会抛"和"会卡住"的假插件去证明
 * 安全阀真的会兜住。
 */
export async function runPluginAction(
  id: string,
  key: string,
  servers: Record<string, PluginServer> = SERVERS,
  plugins: Plugin[] = PLUGINS,
  timeoutMs = SOURCE_TIMEOUT_MS,
): Promise<boolean> {
  const enabled = new Set(enabledPlugins().map((p) => p.id));
  if (!isConsidered(id, enabled)) return false;
  const declared = plugins.find((p) => p.id === id)?.actions?.some((a) => a.key === key);
  if (!declared) return false;
  const run = servers[id]?.runAction;
  if (!run) return false;

  try {
    return await withTimeout(run(key), false, timeoutMs);
  } catch {
    return false;
  }
}
