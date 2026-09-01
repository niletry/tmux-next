import { PLUGINS } from "./registry.js";
import type { Annotation, Plugin, PluginAnnotator, PluginHandler } from "./types";
import { handle as gallery } from "./gallery/server";
import { handle as notifications } from "./notifications/server";
import { handle as jira } from "./jira/server";

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
export type PluginServer = { handle?: PluginHandler; annotate?: PluginAnnotator };

export const SERVERS: Record<string, PluginServer> = {
  gallery: { handle: gallery },
  notifications: { handle: notifications },
  jira: { handle: jira },
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

/** 声明了标注能力的插件。从上面那张表推导，不再单独维护一份。 */
export const ANNOTATORS: Record<string, PluginAnnotator> = Object.fromEntries(
  Object.entries(SERVERS)
    .filter(([, s]) => s.annotate)
    .map(([id, s]) => [id, s.annotate!]),
);

/** 一个插件最多能占用列表构建的多少时间。 */
export const ANNOTATE_TIMEOUT_MS = 300;

/** 一条标注文本的上限，够放一个单号加一句标题，不够撑破一行。 */
const MAX_TEXT = 120;

function trim(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * 向每个有标注函数的插件要一次标注。
 *
 * 失败语义只有一种：**拿不到就当没有**。插件抛了、超时了、返回了不是对象的东西，
 * 都只是这个插件这一轮没有标注，会话列表照常渲染。内核的页面不能因为一个插件而
 * 出不来——这是开这个口子的唯一安全阀，也是它可以被接受的原因。
 *
 * annotators 是参数而不是直接用 ANNOTATORS，好让内核侧的测试能塞进一个会抛、一个
 * 会卡住的假插件——注册表是编译期写死的，没有这个参数就没法测这条安全阀。
 */
export async function collectAnnotations(
  sessions: string[],
  annotators: Record<string, PluginAnnotator> = ANNOTATORS,
): Promise<Record<string, Record<string, Annotation>>> {
  const enabled = new Set(enabledPlugins().map((p) => p.id));
  // 真实插件按启用状态过滤；测试注进来的假插件不在注册表里，一律放行。
  const entries = Object.entries(annotators).filter(
    ([id]) => !PLUGINS.some((p) => p.id === id) || enabled.has(id),
  );

  const results = await Promise.all(
    entries.map(async ([id, annotate]) => {
      try {
        const timeout = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), ANNOTATE_TIMEOUT_MS),
        );
        const got = await Promise.race([annotate(sessions), timeout]);
        if (!got || typeof got !== "object" || Array.isArray(got)) return null;
        const clean: Record<string, Annotation> = {};
        for (const [session, raw] of Object.entries(got)) {
          if (!sessions.includes(session)) continue; // 插件只能标注被问到的会话，不能塞进没要求的键
          const a = raw as Record<string, unknown>;
          const text = trim(a?.text, MAX_TEXT);
          if (!text) continue;
          const detail = trim(a?.detail, MAX_TEXT);
          const tone = a?.tone === "ok" || a?.tone === "warn" || a?.tone === "dim" ? a.tone : undefined;
          clean[session] = { text, ...(detail ? { detail } : {}), ...(tone ? { tone } : {}) };
        }
        return [id, clean] as const;
      } catch {
        return null;
      }
    }),
  );

  return Object.fromEntries(results.filter(Boolean) as Array<readonly [string, Record<string, Annotation>]>);
}
