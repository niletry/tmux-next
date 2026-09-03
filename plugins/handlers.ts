import { PLUGINS } from "./registry.js";
import type { Facet, FacetDetail, ItemRef, Plugin, PluginEnricher, PluginFieldSource, PluginHandler, SettingValue } from "./types";
import { handle as gallery } from "./gallery/server";
import { handle as notifications } from "./notifications/server";
import {
  handle as jira,
  enrich as jiraEnrich,
  start as jiraStart,
  sync as jiraSync,
  refreshItem as jiraRefreshItem,
  readSettings as jiraReadSettings,
  writeSettings as jiraWriteSettings,
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
  enrich?: PluginEnricher;
  /**
   * 一张单喂给模板的字段。用户按下按钮才走，允许一次真实的网络往返（见 FIELD_TIMEOUT_MS）。
   */
  fields?: PluginFieldSource;
  /** 把这个插件认领的所有来源同步一遍（新建/更新单）。显式动作，会发网络请求。 */
  sync?: () => Promise<SyncResult>;
  /** 只刷新一个单，`ref` 是 `source.ref`（比如 Jira 的 issue key）。 */
  refreshItem?: (ref: string) => Promise<void>;
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
};

export const SERVERS: Record<string, PluginServer> = {
  gallery: { handle: gallery },
  notifications: { handle: notifications },
  jira: {
    handle: jira,
    enrich: jiraEnrich,
    start: jiraStart,
    sync: jiraSync,
    refreshItem: jiraRefreshItem,
    readSettings: jiraReadSettings,
    writeSettings: jiraWriteSettings,
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

/** 一个维度底下最多能展开几行明细。一个坏插件不能靠 detail 撑爆浮层。 */
export const MAX_DETAIL_ROWS = 20;

/** 一个 chip 图标的路径长度上限。够画一个图元组合，不够塞进一整幅图。 */
const MAX_ICON = 2000;

/**
 * chip 图标只放行几何图元。
 *
 * 这段字符串最终会进 innerHTML。本仓库的插件是编译期常量（没有运行时加载，见
 * CLAUDE.md），所以这不是在防一个能往里塞代码的攻击者——顶栏的 `plugin.icon`
 * 一直就是这么渲染的，威胁模型没变。它防的是另一件事：collectFacets 这个函数
 * 对插件给的**每一个**字段都做了净化（文本限长、tone 白名单、url 只认 http），
 * 唯独放一个字段直通 innerHTML，会让下一个读这段代码的人搞不清这里到底管不管。
 * 一条正则把边界说死，比一句"插件是可信的"注释可靠。
 *
 * 整串必须由自闭合的图元标签组成，**元素名和属性名都是白名单**，属性值里不许出现
 * 尖括号或引号。第一版只白名单了元素名、属性名放任意 `[a-zA-Z-]+`，结果
 * `<path d="M0 0" onload="alert(1)"/>` 语法完全合法地通过了——是 src/plugin-enrich
 * .test.ts 那条用例把它逼出来的。所以属性也得逐个列，列的都是几何和描边属性，
 * 没有任何一个能执行代码。
 */
const ICON_SHAPES = new RegExp(
  "^(?:<(?:path|circle|rect|line|polyline|polygon|ellipse)" +
    '(?:\\s+(?:d|cx|cy|r|rx|ry|x|y|x1|y1|x2|y2|width|height|points|transform|' +
    'fill|fill-rule|clip-rule|stroke|stroke-width|stroke-linecap|stroke-linejoin|opacity)' +
    '="[^"<>]*")*\\s*/>)+$',
);

/** 通过就原样返回，否则当作没给图标。 */
function safeIconPaths(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.trim();
  if (!compact || compact.length > MAX_ICON) return undefined;
  return ICON_SHAPES.test(compact) ? compact : undefined;
}

function trim(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * 明细行的链接只认 http/https，别的一律当没给。
 *
 * 插件给的字符串会变成页面上的 href，`javascript:` 就是一条注入路径；相对地址则会
 * 按当前页解析，插件根本不知道自己被挂在哪个路径下。两种都不是"链接坏了"那么轻，
 * 所以这里要的是绝对地址加协议白名单，而不是清洗。拿不准就丢掉——那一行还在，
 * 只是不可点，跟 facet 那条"拿不到就当没有"是同一种降级。
 */
function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
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
  const entries = Object.entries(enrichers).filter(([id]) => isConsidered(id, enabled));
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
            // 明细跟 facet 本身同一套不信任姿态：截断、封顶、tone 只认三个值。
            // 内核不看这些行是什么意思，只保证它们不会撑破页面。
            const detail: FacetDetail[] = [];
            if (Array.isArray(f?.detail)) {
              for (const rawRow of f.detail.slice(0, MAX_DETAIL_ROWS)) {
                const r = rawRow as Record<string, unknown>;
                const label = trim(r?.label, MAX_TEXT);
                const rowValue = trim(r?.value, MAX_TEXT);
                if (!label) continue;
                const rowTone =
                  r?.tone === "ok" || r?.tone === "warn" || r?.tone === "dim" ? r.tone : undefined;
                const rowUrl = safeHttpUrl(r?.url);
                detail.push({
                  label,
                  value: rowValue,
                  ...(rowTone ? { tone: rowTone } : {}),
                  ...(rowUrl ? { url: rowUrl } : {}),
                });
              }
            }
            const iconPaths = safeIconPaths(f?.icon);
            facets.push({
              dim,
              value,
              ...(tone ? { tone } : {}),
              ...(detail.length ? { detail } : {}),
              ...(iconPaths ? { icon: iconPaths } : {}),
            });
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

/** 声明了字段能力的插件。跟 ENRICHERS 一样从 SERVERS 推导，不另立一张表。 */
export const FIELD_SOURCES: Record<string, PluginFieldSource> = Object.fromEntries(
  Object.entries(SERVERS)
    .filter(([, s]) => s.fields)
    .map(([id, s]) => [id, s.fields!]),
);

/**
 * 一个插件回答"这张单有哪些字段"能占多少时间。
 *
 * 既不复用 ENRICH_TIMEOUT_MS（300ms）也不复用 SOURCE_TIMEOUT_MS（30s）。300ms 是为
 * "每次页面加载都跑"设的，短到逼插件读缓存；而 fields 是用户按下按钮才走的一次显式
 * 动作，本来就该允许一次真实的往返。30s 是整批同步的预算，而这里有个人正盯着一个还
 * 没填上的输入框。
 */
export const FIELD_TIMEOUT_MS = 5_000;

/** 一个字段的长度上限。描述正文可以很长，但没有哪一段该到 4KB。 */
export const MAX_FIELD_LEN = 4000;

/** 合并**所有**插件之后，一张单最多留几个字段。不是每个插件的配额。 */
export const MAX_FIELDS_PER_ITEM = 12;

/** 占位符语法认得的键名形状，跟 src/template.ts 的 PLACEHOLDER 一致。 */
const FIELD_KEY = /^[A-Za-z0-9._-]+$/;

/**
 * 向每个声明了字段能力的插件要一次字段，合并成一张平表。
 *
 * 失败语义只有一种：**拿不到就当没有**。插件抛了、超时了、返回了不是对象的东西，都只是
 * 这一轮没有字段，模板照常渲染，那几个占位符变成空——跟 collectFacets 完全同一条安全阀。
 *
 * sources 是参数而不是直接用 FIELD_SOURCES，理由跟 collectFacets 一模一样：注册表是
 * 编译期常量，不注入假插件就没有任何办法证明超时和 try/catch 真的会兜住。
 */
export async function collectFields(
  item: ItemRef,
  sources: Record<string, PluginFieldSource> = FIELD_SOURCES,
): Promise<Record<string, string>> {
  const enabled = new Set(enabledPlugins().map((p) => p.id));
  const entries = Object.entries(sources).filter(([id]) => isConsidered(id, enabled));

  const results = await Promise.all(
    entries.map(async ([, fields]) => {
      try {
        const timeout = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), FIELD_TIMEOUT_MS),
        );
        const got = await Promise.race([fields(item), timeout]);
        if (!got || typeof got !== "object" || Array.isArray(got)) return null;
        const clean: Record<string, string> = {};
        for (const [key, value] of Object.entries(got)) {
          if (typeof value !== "string" || !value) continue;
          // 占位符写不出来的键，收下也没人能引用它。
          if (!FIELD_KEY.test(key)) continue;
          // item.* 是内核自己的命名空间——让插件写进来等于让它伪造这张单的标题和
          // 单号，而模板渲染分不出是谁写的。
          if (key.startsWith("item.")) continue;
          clean[key] = value.slice(0, MAX_FIELD_LEN);
        }
        return clean;
      } catch {
        return null;
      }
    }),
  );

  const merged: Record<string, string> = {};
  for (const one of results) {
    if (one) Object.assign(merged, one);
  }
  // 合并之后才封顶：上限是"一张单上最多几个"，不是"每个插件最多几个"。
  return Object.fromEntries(Object.entries(merged).slice(0, MAX_FIELDS_PER_ITEM));
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
 * `collectFacets`、`runSync`、`refreshFromSource` 三处都要这条判断，抽出来是因为
 * 三份各写一次迟早会飘——尤其是 `TMUX_NEXT_DISABLE_PLUGINS` 关掉一个插件本该让它
 * 的 tab、API、页面一起消失（CLAUDE.md 的原话），`refreshFromSource` 直接调
 * `refreshItem`、不经过 `/api/<id>` 的 404 闸门，这条过滤就是它唯一的闸门。
 */
function isConsidered(id: string, enabled: Set<string>): boolean {
  return !PLUGINS.some((real) => real.id === id) || enabled.has(id);
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
  const ids = plugins
    .filter((p) => isConsidered(p.id, enabled))
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
  const enabled = new Set(enabledPlugins().map((p) => p.id));
  const owner = plugins.find(
    (p) => p.provides?.includes(provider) && isConsidered(p.id, enabled),
  );
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

/**
 * 给每个声明了 `start` 的插件一次进程启动时的机会，逐个调、互不影响。
 *
 * 同步函数，不返回 Promise——调用方（CLI 入口）不 await 它，端口该开还是照开。
 * 插件想做异步的事，自己在 `start()` 里 fire-and-forget。失败语义跟这个接缝
 * 别处一样：一个插件的 start 抛了，等于它这次没有启动动作，不连累别的插件、
 * 更不能挡住服务器起来，所以逐个包 try/catch 而不是包在外层一次。
 *
 * servers/plugins 作为参数、真表做默认值：理由跟 runSync 一样，注册表是编译期
 * 常量，不注入就没法证明"一个插件抛了不挡别的插件"这条安全阀真的会兜住。
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
