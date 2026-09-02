import { PLUGINS } from "./registry.js";
import type { Facet, ItemRef, Plugin, PluginEnricher, PluginHandler } from "./types";
import { handle as gallery } from "./gallery/server";
import { handle as notifications } from "./notifications/server";
import { handle as jira, enrich as jiraEnrich } from "./jira/server";

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
  enrich?: PluginEnricher;
  /** 把这个插件认领的所有来源同步一遍（新建/更新单）。显式动作，会发网络请求。 */
  sync?: () => Promise<SyncResult>;
  /** 只刷新一个单，`ref` 是 `source.ref`（比如 Jira 的 issue key）。 */
  refreshItem?: (ref: string) => Promise<void>;
};

export const SERVERS: Record<string, PluginServer> = {
  gallery: { handle: gallery },
  notifications: { handle: notifications },
  jira: { handle: jira, enrich: jiraEnrich },
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

/** 声明了维度能力的插件。从上面那张表推导，不再单独维护一份。 */
export const ENRICHERS: Record<string, PluginEnricher> = Object.fromEntries(
  Object.entries(SERVERS)
    .filter(([, s]) => s.enrich)
    .map(([id, s]) => [id, s.enrich!]),
);

/** 一个插件最多能占用列表构建的多少时间。 */
export const ENRICH_TIMEOUT_MS = 300;

/** 一条 facet 文本的上限，够放一个状态或一个史诗名，不够撑破一张卡片。 */
const MAX_TEXT = 120;

/**
 * 合并后的**插件** facet，每张单最多留几条——只管这一份，不是一张卡片上全部
 * chips 的上限。内核自己的 facet（src/server.ts 拼进来的 item.* 系列、
 * src/item-facets.ts 按标签数逐条产出的那些）不经过这里，不受这个数封顶：
 * 标签是用户自己的数据，条数由用户决定，不是插件能刷爆的东西。这个上限只
 * 防插件——不管几个插件加起来往一张单上贴多少条，最后都会被这里砍到这个数。
 */
export const MAX_FACETS_PER_ITEM = 6;

function trim(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * 向每个声明了维度能力的插件要一次 facet，合并成 item id → facet 数组。
 *
 * 失败语义只有一种：**拿不到就当没有**。插件抛了、超时了、返回了不是对象的东西，
 * 都只是这个插件这一轮没有维度，首页照常渲染。内核的页面不能因为一个插件而出不
 * 来——这是开这个口子的唯一安全阀，也是它可以被接受的原因。
 *
 * 不按插件分层返回：首页要画的是一行 chips，谁贴的不重要。分层只会让调用方再拍平
 * 一次，还得决定插件之间的顺序。
 *
 * enrichers 是参数而不是直接用 ENRICHERS，好让内核侧的测试能塞进一个会抛、一个会
 * 卡住的假插件——注册表是编译期写死的，没有这个参数就没法测这条安全阀。
 */
export async function collectFacets(
  items: ItemRef[],
  enrichers: Record<string, PluginEnricher> = ENRICHERS,
): Promise<Record<string, Facet[]>> {
  const enabled = new Set(enabledPlugins().map((p) => p.id));
  // 真实插件按启用状态过滤；测试注进来的假插件不在注册表里，一律放行。
  const entries = Object.entries(enrichers).filter(
    ([id]) => !PLUGINS.some((p) => p.id === id) || enabled.has(id),
  );
  const asked = new Set(items.map((i) => i.id));

  const results = await Promise.all(
    entries.map(async ([, enrich]) => {
      try {
        const timeout = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), ENRICH_TIMEOUT_MS),
        );
        const got = await Promise.race([enrich(items), timeout]);
        if (!got || typeof got !== "object" || Array.isArray(got)) return null;
        const clean: Record<string, Facet[]> = {};
        for (const [id, raw] of Object.entries(got)) {
          if (!asked.has(id)) continue; // 插件只能标注被问到的单
          if (!Array.isArray(raw)) continue;
          const facets: Facet[] = [];
          for (const one of raw) {
            const f = one as Record<string, unknown>;
            const dim = trim(f?.dim, MAX_TEXT);
            const value = trim(f?.value, MAX_TEXT);
            if (!dim || !value) continue;
            // `item.*` 是内核自己的命名空间（item.agent 等）——一个坏插件冒充
            // item.agent 就能在页面上再画一个 Agent chip、把卡片重新分到别的
            // 组，让页面替内核的事实撒谎。插件的维度名是开放集合，唯独这个
            // 前缀不让它碰。
            if (dim.startsWith("item.")) continue;
            const tone =
              f?.tone === "ok" || f?.tone === "warn" || f?.tone === "dim" ? f.tone : undefined;
            facets.push({ dim, value, ...(tone ? { tone } : {}) });
          }
          if (facets.length) clean[id] = facets;
        }
        return clean;
      } catch {
        return null;
      }
    }),
  );

  // 合并各插件，再按单封顶——上限是"一张卡片上最多几个"，不是"每个插件最多几个"。
  const merged: Record<string, Facet[]> = {};
  for (const one of results) {
    if (!one) continue;
    for (const [id, facets] of Object.entries(one)) {
      (merged[id] ??= []).push(...facets);
    }
  }
  for (const id of Object.keys(merged)) merged[id] = merged[id]!.slice(0, MAX_FACETS_PER_ITEM);
  return merged;
}

/** 一次同步的结果。多个来源的结果相加，truncated 只要有一个为真就是真。 */
export type SyncResult = { created: number; updated: number; total: number; truncated: boolean };

/**
 * 来源操作的硬超时。
 *
 * 不能沿用 enrich 的 300ms——那条预算是为"每次页面加载都跑"设的。sync 和
 * refreshItem 是显式动作，会真的发网络请求，30 秒是"慢得可以接受"和"卡住了"之间
 * 的线。
 */
export const SOURCE_TIMEOUT_MS = 30_000;

async function withTimeout<T>(work: Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
  const timeout = new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs));
  try {
    return await Promise.race([work, timeout]);
  } catch {
    return fallback;
  }
}

/**
 * 让所有声明了 `sync` 的插件各同步一遍自己的来源，把结果相加。
 *
 * servers/plugins 作为参数、真表做默认值——理由跟 collectFacets 一样：注册表是
 * 编译期常量，没有这个参数就没法塞进"会抛的假插件"和"永远卡住的假插件"，那两条
 * 测试是这个安全阀真的会兜住的唯一证据。
 *
 * timeoutMs 单独开成可注入的尾参数（默认 SOURCE_TIMEOUT_MS）：真实预算是 30 秒，
 * 但测试"卡住的插件不会吊死调用方"这件事跟等多久无关，注入一个很小的值就能在
 * 毫秒级证明同一条性质，不用真的等 30 秒。
 */
export async function runSync(
  servers: Record<string, PluginServer> = SERVERS,
  plugins: Plugin[] = PLUGINS,
  timeoutMs: number = SOURCE_TIMEOUT_MS,
): Promise<SyncResult> {
  const enabled = new Set(enabledPlugins().map((p) => p.id));
  // 真实插件按启用状态过滤；测试注进来的假插件不在注册表里，一律放行——跟
  // collectFacets 同一条判断。
  const ids = plugins
    .filter((p) => !PLUGINS.some((real) => real.id === p.id) || enabled.has(p.id))
    .map((p) => p.id)
    .filter((id) => servers[id]?.sync);

  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        return await withTimeout(servers[id]!.sync!(), null, timeoutMs);
      } catch {
        return null;
      }
    }),
  );

  const total: SyncResult = { created: 0, updated: 0, total: 0, truncated: false };
  for (const r of results) {
    if (!r) continue;
    total.created += r.created;
    total.updated += r.updated;
    total.total += r.total;
    total.truncated = total.truncated || r.truncated;
  }
  return total;
}

/**
 * 按 `source.provider` 找到声明了 `provides` 里含它的插件，请它刷新这一个单。
 *
 * 内核只知道 provider 字符串，从不知道插件 id——这一步查表用的是插件自己声明的
 * `provides`，不是内核维护的 provider→插件 名单。没人认领、认领了但没实现
 * `refreshItem`、调用抛了、或者超时，都算失败，一律返回 false：调用方（首页的
 * 刷新按钮）不需要区分这几种情况，只需要知道"刷没刷成"。
 */
export async function refreshFromSource(
  provider: string,
  ref: string,
  servers: Record<string, PluginServer> = SERVERS,
  plugins: Plugin[] = PLUGINS,
  timeoutMs: number = SOURCE_TIMEOUT_MS,
): Promise<boolean> {
  const owner = plugins.find((p) => p.provides?.includes(provider));
  const refreshItem = owner ? servers[owner.id]?.refreshItem : undefined;
  if (!refreshItem) return false;

  try {
    return await withTimeout(
      refreshItem(ref).then(() => true),
      false,
      timeoutMs,
    );
  } catch {
    return false;
  }
}
