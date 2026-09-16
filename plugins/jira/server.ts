import { readJiraConfig, writeJiraConfig, DEFAULT_JQL, type JiraConfig } from "./config";
import { fetchIssue, fetchIssues, fetchIssueDescription, type Issue, type IssuesResult } from "./client";
import { fetchDev, type DevResult, type PullRequest } from "./dev";
import { transitionIssue } from "./writeback";
import { syncIssues } from "./sync";
import { incrementalJql } from "./jql";
import { readSyncState, writeSyncState } from "./sync-state";
import { readItems, ensureItemForSource } from "../../src/items/model";
import type { ItemStatus } from "../../src/items/lifecycle";
import { bindSession, unbindSession, resolveBindings, type ResolvedBinding } from "../../src/items/binding";
import { sessionIdentities } from "../../src/tmux/session-list";
import type { Facet, ItemRef } from "../types";
import type { ItemSourceProvider, SyncResult } from "../../src/items/sources";
import { classifyStatusStage, stageRank, STAGE_COUNT } from "./status-stage";

/**
 * 工单插件的服务端。
 *
 * 浏览器永不直连 Jira：token 会漏，CORS 也不通。所有对外请求都从这里出去，而
 * **JQL 只来自 config.json**——接受浏览器传来的 JQL，就等于把这个无认证的服务
 * 变成一个任人查询的 Jira 代理。
 */

/** 拉一次要几秒，而列表页会被反复打开；60 秒足够挡住连点，又不至于让人觉得刷不动。 */
const CACHE_MS = 60_000;

let cache: { at: number; result: IssuesResult } | null = null;

/**
 * 单个 issue 的缓存,按 key,跟 JQL 结果缓存分开存。
 *
 * JQL 结果缓存装的是"当前这条查询命中了什么",而这条查询通常长着
 * `status not IN (Done, Closed, Abandoned)` 这样的尾巴——工单一旦转到 Done
 * 就不再匹配,下一次 `issues()` 的结果里直接没有它了。`enrich()` 曾经只从这份
 * 缓存里找 issue,于是一个刚做完的单立刻从卡片上掉光所有 facet(状态、PR、
 * 检查全没了),而点「刷新」也救不回来:`refreshIssue` 单独去问了这一个 key,
 * 但只在它还在 `cache` 的列表里时才写得进去——不在,查到的结果就被扔掉。
 *
 * 单独一份缓存是解法:一次针对某个 key 的 fetch,结果该不该留下来,不该取决于
 * 这个 key 眼下在不在查询范围里。
 */
export const ISSUE_CACHE_MS = 5 * 60_000;
const issueCache = new Map<string, { at: number; issue: Issue }>();

export async function issues(refresh: boolean): Promise<IssuesResult> {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache.result;
  const config = await readJiraConfig();
  if (!config) return { ok: false, reason: "unconfigured" };
  const result = await fetchIssues(config);
  // 只缓存成功：一次网络抖动不该让人盯着错误看满一分钟。
  if (result.ok) {
    cache = { at: Date.now(), result };
    // 顺手预热单号缓存,让它在正常流程(定时/手动全量同步)里就有内容,不是只有
    // 点过一次单条刷新的单才留得下东西。
    const at = Date.now();
    for (const issue of result.issues) issueCache.set(issue.key, { at, issue });
  }
  return result;
}

/**
 * PR 与 CI 的缓存，按 issue id。
 *
 * 比工单列表的缓存活得久，因为它贵得多：一个单一次 dev-status，每个 PR 再一次
 * Bitbucket。五十个单全量刷一遍是上百次请求，做成开页即拉会把速率限制撞穿。
 *
 * 所以默认吃缓存，刷新是显式的——而且可以只刷一个单。盯着一个 PR 等 CI 跑完的
 * 时候，你要的是这一个单的最新状态，不是把另外四十九个也重问一遍。
 */
const DEV_CACHE_MS = 5 * 60_000;

const devCache = new Map<string, { at: number; result: DevResult }>();

/**
 * 仓库的人读名字，跨 issue 长期缓存——不像 devCache 那样五分钟过期，因为名字
 * 本身几乎不会变。这个进程活多久就缓多久，issue 之间共享同一份，是 fetchDev
 * 特意留出的那个可注入参数存在的理由：dev.ts 自己不持有这份状态。
 */
const repoNameCache = new Map<string, string>();

/** 同时在跑的 dev-status 请求数。批量刷新时不至于一次打出去五十个连接。 */
const DEV_CONCURRENCY = 4;

async function dev(issueId: string, issueKey: string, refresh: boolean): Promise<DevResult> {
  const hit = devCache.get(issueId);
  if (!refresh && hit && Date.now() - hit.at < DEV_CACHE_MS) return hit.result;

  const config = await readJiraConfig();
  if (!config) return { ok: false, reason: "auth" };

  const result = await fetchDev(config, issueId, issueKey, fetch, repoNameCache);
  // 只缓存成功。一次抖动不该让这个单的 PR 消失五分钟。
  if (result.ok) devCache.set(issueId, { at: Date.now(), result });
  return result;
}

/** 有并发上限的 map，跟 dev.ts 里那个同源，此处不共享是为了不把内部函数导出去。 */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 重取一条工单，并把它写回列表缓存。
 *
 * 写回是要紧的一步：不写回的话，这次拿到的新状态只活在这一个响应里，页面下一次
 * 重画（或者别处触发的一次渲染）就会用回缓存里的旧值，看起来像是刷新没生效。
 */
export async function refreshIssue(key: string): Promise<Issue | null> {
  const config = await readJiraConfig();
  if (!config) return null;
  const got = await fetchIssue(config, key);
  if (!got.ok) return null;

  // 无条件写进单号缓存——这一步不看这个 key 在不在 JQL 结果里,理由见 issueCache
  // 上面的注释:一次刷新问到的答案,不该因为工单已经不在查询范围里就被扔掉。
  issueCache.set(key, { at: Date.now(), issue: got.issue });

  if (cache?.result.ok) {
    const list = cache.result.issues;
    const at = list.findIndex((i) => i.key === key);
    if (at >= 0) list[at] = got.issue;
    // 不在列表里的单不追加进去:`cache` 是"这条 JQL 眼下命中了什么"的真相来源,
    // /api/jira 拿它原样渲染成"当前查询结果"——塞一个查询本该排除的单进去,
    // 会让工单页显示出一条它自己的查询条件说不该出现的行。
  }
  return got.issue;
}

/**
 * 内核的绑定，翻译成 Jira 页认得的形状。
 *
 * 只挑 source 是 jira 的单——本地单与将来别家来源的单不属于这个视图。翻译放在
 * 插件这边而不是内核那边，是因为"itemId ↔ 单号"是 Jira 的语言，内核不认识它。
 */
export async function jiraBindingsView(
  live: Array<{ name: string; sessionId: string }>,
): Promise<Array<{ session: string; key: string; live: boolean }>> {
  const [items, bindings] = await Promise.all([readItems(), resolveBindings(live)]);
  const keyOf = new Map(
    items.filter((i) => i.source?.provider === "jira").map((i) => [i.id, i.source!.ref]),
  );
  const out: Array<{ session: string; key: string; live: boolean }> = [];
  for (const b of bindings) {
    const key = keyOf.get(b.itemId);
    if (!key) continue;
    out.push({ session: b.session, key, live: b.live });
  }
  return out;
}

/** 认领：这个单号还没有单就建一张，然后把会话绑上去。 */
export async function claimIssue(session: string, key: string, sessionId: string): Promise<void> {
  const item = await ensureItemForSource("jira", key, key);
  await bindSession(session, item.id, sessionId);
}

/** 内核的会话列表，映射成绑定解析要的最小形状。 */
async function liveFromKernel(): Promise<Array<{ name: string; sessionId: string }>> {
  // sessionIdentities() 而非 listSessions()：这里只要 name/sessionId 对，
  // listSessions() 会为每个会话多起一次 capture-pane 子进程——这台机器上曾经
  // 是 37 个会话、37 次子进程起停，只为了取一对字段。
  return sessionIdentities();
}

/**
 * 一张单能从两个缓存里读出哪些维度。纯函数，缓存当参数喂进来，于是能无头地测。
 *
 * 只认 source 是 jira 的单——传进来的是**全部**单（内核不按 provider 预筛，那会在
 * 内核里写死"provider 名就是插件 id"），挑是这边的事。
 */
/**
 * 一个检查状态对应的色调。
 *
 * 跟工单页 jira.js 的 checkTone 是同一套判断，只是那边产 CSS 类名、这边产 facet
 * 的 tone——两处都只认 Bitbucket 的原始状态词，改判断要一起改。
 */
/**
 * PR 状态的色调。MERGED 是"这条已经不用管了"所以压暗，DECLINED 才是要看一眼的。
 * OPEN 不给色——列表里绝大多数都是 OPEN，全部染色等于没染。
 */
function prFacetTone(status: string): "ok" | "warn" | "dim" | undefined {
  if (status === "MERGED") return "dim";
  if (status === "DECLINED") return "warn";
  return undefined;
}

/**
 * jira.prs 这一整颗 facet 的聚合色——单条 PR 已经有 prFacetTone 各自的说法，这里
 * 要的是"这一堆 PR 加起来该亮什么灯"：有一个被拒就是要看一眼的事，压过"其余的
 * 都合并了"；全部合并才算真的可以不管；还有 OPEN 没定论的，谁都说不好，不染色。
 */
function prsFacetTone(prs: { status: string }[]): "ok" | "warn" | "dim" | undefined {
  if (prs.some((pr) => pr.status === "DECLINED")) return "warn";
  if (prs.every((pr) => pr.status === "MERGED")) return "dim";
  return undefined;
}

function checkFacetTone(state: string): "ok" | "warn" | "dim" {
  if (state === "FAILED" || state === "STOPPED") return "warn";
  if (state === "INPROGRESS") return "dim";
  return "ok";
}

/**
 * 一条失败检查该往会话里发的话。只给 FAILED/STOPPED（跟 checkFacetTone 判
 * warn 是同一条件）配这句提示——通过或进行中的检查没什么好让人去修的,不该
 * 在明细行上多出一个点了也没用的按钮。
 */
function checkFixPrompt(pr: PullRequest, c: { name: string; state: string }): string {
  return `PR ${pr.url} 的检查「${c.name}」失败（状态：${c.state}），请检查并修复。`;
}

/**
 * 一个 PR 的分组标题："仓库 #编号 · 源分支 → 目标分支 · 状态"。缺的字段就跳过
 * 那一段而不是画一个空括号——`repo`/`destinationBranch` 依赖 dev-status 的字段
 * 是否到位，老版本或字段缺失时留空是诚实的降级，不是错误。`id` 不会缺：
 * `fetchDev` 已经把没有编号的 PR 过滤掉了（见 dev.ts）。
 */
function prGroupLabel(pr: PullRequest): string {
  const repoAndId = pr.repo ? `${pr.repo} #${pr.id}` : `#${pr.id}`;
  const branches = pr.destinationBranch ? `${pr.branch} → ${pr.destinationBranch}` : pr.branch;
  return [repoAndId, branches, pr.status].filter(Boolean).join(" · ");
}

/**
 * 工单类型 → 一组 SVG 路径。
 *
 * 内核不认识 epic，也不该认识：类型是 Jira 的概念，而且是开放集合（每个实例都能
 * 自己造类型）。所以形状由插件给，内核只套外壳——跟顶栏标签的 `plugin.icon` 同源。
 *
 * 形状跟工单页 public/jira.js 的 typeIcon() 一致：同一个东西在两个页面上不该长得
 * 不一样。那边额外用了填充实心的画法（史诗的闪电、缺陷的圆点），这里一律走描边，
 * 因为内核的外壳是统一的 fill="none"——把填充也做成可配置，等于让每个插件都能改
 * 内核的图标语言，那正是这个外壳存在的理由的反面。
 */
/** 两条分支加一个合流点：到处都是这个形状，看见就知道是 PR。 */
const PR_ICON =
  '<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/>' +
  '<circle cx="18" cy="18" r="2.2"/><path d="M6 8.2v7.6"/><path d="M18 15.8V11a3 3 0 0 0-3-3h-4"/>';

/** 对勾：这一格说的是"过了几个"。 */
const CHECK_ICON = '<path d="m4 12.5 5 5L20 6.5"/>';

const TYPE_ICONS: Record<string, string> = {
  // 闪电，Jira 已经把所有人训练成看到它就想到史诗。
  epic: '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>',
  // 箭头拐进一个方块：这东西挂在别的东西下面。
  sub: '<path d="M4 5v6a2 2 0 0 0 2 2h5"/><path d="m9 10 3 3-3 3"/><rect x="13" y="9" width="7" height="8" rx="1.5"/>',
  bug: '<circle cx="12" cy="12" r="7"/>',
  story: '<path d="M6 3h12v18l-6-4.5L6 21z"/>',
  task: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
};

/**
 * 归一化到 TYPE_ICONS 的键。
 *
 * 层级优先：`hierarchy` 是 Jira 自己给的结构，改不掉；而类型**名字**是每个实例
 * 自己定的，可以被改成任何东西（这个实例上就有中文的"任务"）。名字只在层级说
 * 不出话时才用来猜，而且猜不中就返回空——少画一个图标，好过画错一个。
 */
function typeKey(issue: Issue): string {
  if (issue.hierarchy >= 1) return "epic";
  if (issue.hierarchy <= -1) return "sub";
  const name = issue.type.trim().toLowerCase();
  if (/^bugs?$|^缺陷$/.test(name)) return "bug";
  if (/^(story|stories|用户故事|故事)$/.test(name)) return "story";
  if (/^(task|tasks|任务)$/.test(name)) return "task";
  return "";
}

/**
 * 一张单的史诗名，不是史诗就是 null。
 *
 * `facetsFor`（卡片上的 chip）和 `fields()`（模板占位符）都要这条判断，抽出来是
 * 因为两处各写一份迟早会飘——只有父级层级确实是史诗（`hierarchy >= 1`）才算，把
 * 子任务的父任务标成史诗是错的；summary 拿不到就退到 key，好过一个空字符串。
 */
function epicSummaryOf(issue: Issue): string | null {
  if (!issue.parent || issue.parent.hierarchy < 1) return null;
  return issue.parent.summary || issue.parent.key;
}

/**
 * epoch 毫秒 → `YYYY-MM-DD`，UTC 固定，不看服务器时区。
 *
 * 工单创建时间是个静态事实，不该跟着服务运行的机器换答案——UTC 日期在哪台机器上
 * 跑出来都一样，本地时区拼出来的日期反而会因为跨了午夜线而在两台机器上不一致。
 */
function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function facetsFor(
  item: ItemRef,
  issues: Map<string, Issue>,
  dev: Map<string, DevResult>,
): Facet[] {
  if (item.source?.provider !== "jira") return [];
  const issue = issues.get(item.source.ref);
  if (!issue) return []; // 缓存没命中：少给几个维度，不阻塞、不给陈旧值

  const facets: Facet[] = [
    {
      // 类型放在第一位：先说"这是什么"，再说"它到什么程度了"。
      //
      // 首页的单列表在此之前完全看不出一张单是史诗、缺陷还是子任务——只有工单号
      // 和一排状态 chip，而工单号本身不带类型。工单页早就按类型画了不同形状，
      // 首页没有，于是同一个东西在两个页面上长得不一样。
      dim: "jira.type",
      value: issue.type,
      icon: TYPE_ICONS[typeKey(issue)],
      // 画成单号前的徽标，不占 chip 行：类型是"这是什么"，一张单从生到死都不变，
      // 而 chip 那一行要留给会变的东西（状态、检查、PR）。图标本身就是这里唯一
      // 被画出来的形状——内核挑徽标图标时挑的就是它。
      badge: true,
    },
    {
      dim: "jira.status",
      value: issue.status,
      tone:
        issue.statusCategory === "done" ? "dim" : issue.statusCategory === "indeterminate" ? "ok" : undefined,
      // 阶段灯挂在同一个 facet 上——状态名到阶段的归类是纯关键词匹配，跟
      // statusCategory 那三档粗粒度分类是两件独立的事，互不影响。灯带只要
      // "第几步/一共几步"两个数字，颜色是内核决定的，这里不再传色相。
      stage: { rank: stageRank(classifyStatusStage(issue.status)), total: STAGE_COUNT },
      // 排序下拉的「状态」选项要的就是这个数字——跟灯带用的是同一份归类，
      // 不是另算一遍。
      sortKey: { key: "stage", rank: stageRank(classifyStatusStage(issue.status)) },
    },
  ];
  // created 是 0 表示解析不出来（老实例、字段缺失），给一个空维度不如不给。
  if (issue.created) facets.splice(1, 0, { dim: "jira.created", value: isoDate(issue.created) });
  // 史诗名走 `parent`，不是一个独立的 epicName 字段：`parent` 同时装着普通工单的
  // 史诗和子任务的父任务，`hierarchy >= 1` 才是史诗——跟 public/filter.js 的
  // epicKeyOf 和 public/jira.js 里卡片上的判断保持一致。
  const epic = epicSummaryOf(issue);
  if (epic) facets.push({ dim: "jira.epic", value: epic });
  // 未分配是 null，不产出维度——"没有负责人"和"负责人是某个空值"是两回事，
  // 混成一个维度会让卡片上出现一个读不出意思的 chip。
  if (issue.assignee) {
    // 没有天然顺序，不给 rank——内核退回按 value 本身的字符串排序。
    facets.push({ dim: "jira.assignee", value: issue.assignee, sortKey: { key: "assignee" } });
  }

  const got = dev.get(issue.id);
  if (got?.ok) {
    facets.push({
      dim: "jira.prs",
      role: "pr",
      value: String(got.prs.length),
      // 值是个光秃秃的数字，卡片上不带维度名就读不出意思。给个图标比给"PR"两个字
      // 省地方，也跟这一行别的 chip 一样只占一个字的宽度。
      icon: PR_ICON,
      // 聚合色跟灯带用同一个信号：一堆 PR 里只要有一个被拒就要看一眼，全部合并
      // 才算真的不用管，还有 OPEN 没定论的不染色。
      tone: prsFacetTone(got.prs),
      // 灯带里除了状态阶段灯，PR 健康度也想要一眼看到，不用点开 chip。
      light: true,
      // 数字说不出是哪个分支、开着还是并了。明细一行一个 PR：标题、状态、链接。
      // 这里给 url 而 checks 不给，是因为一个 PR 有自己的地址而一次检查在这份数据
      // 里没有——不是两处标准不一样。
      detail: got.prs.map((pr) => ({
        label: pr.title || pr.branch,
        value: pr.status,
        tone: prFacetTone(pr.status),
        url: pr.url,
      })),
    });
    // 只统计问到过检查的 PR：checksKnown 为 false 是"我们没问到"，跟"没有检查"是
    // 两回事，收成一个数字会让页面往好看的方向撒谎。
    const known = got.prs.filter((pr) => pr.checksKnown);
    const all = known.flatMap((pr) => pr.checks);
    if (known.length && all.length) {
      const failed = all.filter((c) => c.state === "FAILED").length;
      facets.push({
        dim: "jira.checks",
        role: "check",
        value: `${failed}/${all.length}`,
        tone: failed ? "warn" : "ok",
        icon: CHECK_ICON,
        // 同上：灯带里也要一颗检查健康度的点，不用点开 chip 才看得到。
        light: true,
        // 汇总数字只说"几个挂了"，说不出**是哪个**挂了——而那才是看到红色之后
        // 唯一想知道的事。明细把每个检查的名字（形如 ci/circleci: test）和状态
        // 带上去，首页因此不必再跳一趟工单页。
        // 不带 url：内核不渲染插件给的链接（那就得管协议白名单），要点进某次构建
        // 仍然去工单页。
        //
        // 检查本来按 PR 分开，这里拉平成一条列表时把归属丢了——一个单常常挂着
        // 好几个 PR（多仓库改动、或者重开过一次），拉平之后分不清哪几条检查
        // 属于哪个 PR。group 把归属贴回每一行：同一个 PR 的检查连续排、共享同
        // 一个组标题，内核只管"group 变了就另起一组"，不需要认识 PR 是什么。
        detail: known.flatMap((pr) =>
          pr.checks.map((c) => {
            const tone = checkFacetTone(c.state);
            return {
              label: c.name,
              value: c.state,
              tone,
              group: prGroupLabel(pr),
              // 组标题旁边那个链接图标指回这个 PR 本身——不是某一次检查的地址，
              // 是"这一组说的是哪个 PR"，所以每一行都贴同一个 pr.url。
              groupUrl: pr.url,
              // 只给失败/停止的检查配这句提示——内核只认"有 send 就画按钮"，
              // 这一步"该不该给这行按钮"的判断留在插件这边。
              ...(tone === "warn" ? { send: checkFixPrompt(pr, c) } : {}),
            };
          }),
        ),
      });
    }
  }
  return facets;
}

/**
 * 内核每次画首页都会调这里，预算 300ms——**绝不发请求**，只读已有缓存。
 *
 * 一次网络往返进不了这个预算，而且按页加载去打 Jira 会把速率限制撞穿。缓存没命中
 * 就少给几个维度，那是正确的降级。
 */
export async function enrich(items: ItemRef[]): Promise<Record<string, Facet[]>> {
  const issueMap = new Map<string, Issue>(
    cache?.result.ok ? cache.result.issues.map((i) => [i.key, i]) : [],
  );
  // 补第二份来源:眼下不在 JQL 结果里的单(比如刚转 Done、掉出了查询条件),
  // 但被单条刷新过的那些——issueCache 独立于 JQL 结果存在,理由见它的定义处。
  // 只补 issueMap 里没有的键:JQL 结果仍然是主来源,它命中的单不该被这份
  // 更久之前的缓存盖过去。
  //
  // 不看 ISSUE_CACHE_MS 做新鲜度过滤,故意的:一个几分钟前刷新过的状态,
  // 也好过完全没有状态——这条路上的单往往正是那些不会再被任何一次 JQL
  // 结果自动刷新到的单(已经掉出查询范围),过滤掉陈旧条目等于让这个修复
  // 对它本该修的那种单重新失效。跟 devMap 下面这一行是同一个先例:
  // devCache 的读取端也从不按 DEV_CACHE_MS 过滤,只在写入端(`dev()`)用它
  // 判断"要不要重新去问"。
  for (const item of items) {
    const key = item.source?.provider === "jira" ? item.source.ref : undefined;
    if (!key || issueMap.has(key)) continue;
    const hit = issueCache.get(key);
    if (hit) issueMap.set(key, hit.issue);
  }
  const devMap = new Map([...devCache].map(([id, hit]) => [id, hit.result]));

  const out: Record<string, Facet[]> = {};
  for (const item of items) {
    const facets = facetsFor(item, issueMap, devMap);
    if (facets.length) out[item.id] = facets;
  }
  return out;
}

/**
 * 描述正文的缓存。跟 dev 那份同样的道理：它要一次真实的请求，而模板选择器在同一张单上
 * 很可能被点好几下（换个模板看看）。
 *
 * `text` 存的是 `string | null`，跟"这个键在不在 Map 里"是两件不同的事：一个单
 * 真的没有描述，缓存值就是 `null`，跟"还没问过"（`descCache` 里根本没有这个键）
 * 分得清清楚楚——混起来会让"没有描述的单"每次 fields() 都当成没问过，重新发一次
 * 请求，而这在页面上完全看不出来，只有 Jira 那边的调用量会悄悄涨。
 */
export const DESC_CACHE_MS = 5 * 60_000;
const descCache = new Map<string, { at: number; text: string | null }>();

/**
 * 取一个单的描述正文：读配置、发一次请求。`fields()` 默认用它，测试注入一个假的
 * 进去——理由跟这个仓库别处的默认参数一样（`collectFields(item, sources =
 * FIELD_SOURCES)`、`fetchIssues(config, fetcher = fetch)`）：不注入就没法在不出网
 * 的前提下证明缓存那几条边界（命中不重问、过期才重问、null 也走缓存）真的成立。
 */
async function fetchDescription(key: string): Promise<string | null> {
  const config = await readJiraConfig();
  return config ? await fetchIssueDescription(config, key) : null;
}

/**
 * 一张单喂给模板的字段。
 *
 * 便宜的那几格直接从工单列表的缓存里取——它们本来就在内存里。只有描述正文要发一次请求，
 * 这也正是 fields 的预算是 5 秒而不是 enrich 的 300 毫秒的原因。
 *
 * `getDescription` 和 `now` 都是可选的注入点，真实现（发请求、`Date.now`）做默认值：
 * 前者让测试不用出网就能断言请求发没发；后者让测试不用真的等 5 分钟就能断言缓存过期。
 */
export async function fields(
  item: ItemRef,
  getDescription: (key: string) => Promise<string | null> = fetchDescription,
  now: () => number = Date.now,
): Promise<Record<string, string>> {
  if (item.source?.provider !== "jira") return {};
  const key = item.source.ref;

  const out: Record<string, string> = {};
  const issue = cache?.result.ok ? cache.result.issues.find((i) => i.key === key) : undefined;
  if (issue) {
    out["jira.summary"] = issue.summary;
    out["jira.status"] = issue.status;
    out["jira.type"] = issue.type;
    if (issue.assignee) out["jira.assignee"] = issue.assignee;
    const epic = epicSummaryOf(issue);
    if (epic) out["jira.epic"] = epic;
  }

  const hit = descCache.get(key);
  let description = hit && now() - hit.at < DESC_CACHE_MS ? hit.text : undefined;
  if (description === undefined) {
    description = await getDescription(key);
    descCache.set(key, { at: now(), text: description });
  }
  if (description) out["jira.description"] = description;

  return out;
}

/**
 * 挑出该去拉 PR/检查的单号：source 是 jira、且有一条**活跃**绑定的那些。
 *
 * 纯函数——items 和 bindings 都当参数喂进来，唯一有判断的地方能无头测；带网络
 * 的那部分（真的去问 dev-status）测不了，也不需要测，devTargets 选对了目标，
 * 网络那层照抄现成的 dev()/mapLimited 就行。
 */
export function devTargets(items: ItemRef[], bindings: ResolvedBinding[]): string[] {
  const liveItemIds = new Set(bindings.filter((b) => b.live).map((b) => b.itemId));
  const out: string[] = [];
  for (const item of items) {
    if (item.source?.provider !== "jira") continue;
    if (!liveItemIds.has(item.id)) continue;
    out.push(item.source.ref);
  }
  return out;
}

/**
 * 给一批单号（key）解析出 dev-status 要用的 id：先查当次拿到的结果，查不到
 * 再退回上一次缓存的全量列表，两边都没有就跳过。
 *
 * 增量同步下"这次的结果"只有变过的那几条——一个活跃绑定的单如果本身没变，就
 * 不在这次结果里，但它挂的 PR 完全可能刚跑完一次构建，仍然值得重刷一次。只
 * 看当次结果会让这种单悄悄停止收到 CI 刷新，这跟"只给有活跃会话的单拉"是完全
 * 不同的两件事：那条限制是故意少问，这里是因为问漏了，不该混在一起。
 *
 * 纯函数：两份 issue 列表和目标 key 都是参数，能无头测；真的去打 dev-status
 * 的那半不需要也不能测，devTargets 已经把"该拉谁"的判断从网络里摘出来过一次，
 * 这是同一个理由的延伸。
 */
export function resolveDevIds(
  current: Issue[],
  cached: Issue[],
  keys: Iterable<string>,
): Array<{ id: string; key: string }> {
  const byKey = new Map<string, Issue>();
  for (const i of cached) byKey.set(i.key, i);
  // 当次结果后写，同一个 key 两边都有时以当次为准——它更可能是最新的。
  for (const i of current) byKey.set(i.key, i);

  const out: Array<{ id: string; key: string }> = [];
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const issue = byKey.get(key);
    if (issue?.id) out.push({ id: issue.id, key: issue.key });
  }
  return out;
}

/**
 * 增量同步问多久的窗口：从上次成功同步"发起"的那一刻到现在，再加 2 分钟的
 * 余量。
 *
 * +2 分钟是给 Jira 的分钟级时间戳精度和两边的时钟偏差留的安全边际——把边缘
 * 上一两条已经见过的单再问一遍是无害的（ensureItemForSource 是幂等的，重复
 * 写一次跟没写没区别），漏掉一条真正变了的单才是问题，所以窗口宁可宽一点。
 */
function incrementalWindowMinutes(lastSyncAt: number): number {
  return Math.ceil((Date.now() - lastSyncAt) / 60_000) + 2;
}

/**
 * 把 config.json 里的 JQL 结果同步进内核的单列表，再给正开着会话的那些拉一次
 * PR/检查。
 *
 * 未配置、拉取失败都返回零结果而不是抛——同步是后台动作，不该有一条异常路径
 * 能把调用方（runSync，进而是启动流程）带崩。PR 那一步单独 try/catch：拿不到
 * PR 不该抹掉刚刚同步成功的工单。
 *
 * "返回零结果而不是抛"曾经意味着失败会彻底安静：start() 里 `void sync().catch()`
 * 的那个 handler 永远等不到会抛的 sync()，一个被吊销的 token 就会让列表悄悄停
 * 在旧数据上、什么都不说。日志因此打在这里——`!result.ok` 分支自己才是真正
 * 知道"问不到、以及为什么"的地方，把 log 塞进 start() 的 catch 只是一段看着
 * 像在处理这件事、实际永远不会跑的死代码。
 *
 * `opts.full` 之外，还有四种情况必须退回全量，而不是这个调用方自己选：从没
 * 同步成功过（没有游标可用）、游标记的 JQL 跟现在的 config.jql 不一样（用户
 * 改过查询——旧游标描述的是另一条查询，拿它当"这之后有什么变了"没有意义，见
 * sync-state.ts）、系统时钟往回跳导致 `lastSyncAt` 比现在还晚，以及进程内的
 * `cache` 还是冷的。时钟那条不是 `incrementalWindowMinutes` 自己去钳：钳出来
 * 的窗口是"至少 1 分钟"，而时钟不可信的时候"至少 1 分钟"恰恰是最危险的答
 * 案——它看起来像一次正常的增量、实际上把过去这一整段时间的改动全部漏掉了。
 * 时钟不可信就该整段不信，退回全量，而不是拿一个算出来的负数窗口硬凑一个正数。
 *
 * `cache` 冷这一条是增量同步自己造出来的缺口：下面能看到,增量分支故意绕开
 * `issues()`、直接调 `fetchIssues`,理由是增量结果只有"这次变了的几条",写进
 * `cache` 会把工单页的"全部列表"污染成"最近改过的几条"。但游标是存盘的,能
 * 活过一次进程重启;`cache` 不能——重启后哪怕磁盘上的游标依然有效,内存里的
 * `cache` 也是 null。增量分支既然从不写它,就永远轮不到别人把它焐热,于是
 * `enrich()` 只能从 `issueCache` 的边角料(单独刷新过的那几个 key)里找,首页
 * 绝大多数单子一个 facet 都拿不到——这正是重启后在生产上实测到的样子:353 个
 * 单里只有 5 个还挂着 facet。所以 `cache` 是 null 时必须强制走一次全量,不管
 * 游标看起来多有效:这一次全量,才是唯一会把 `cache` 填上的机会。
 */
export async function sync(opts?: { full?: boolean }): Promise<SyncResult> {
  const config = await readJiraConfig();
  if (!config) return { created: 0, updated: 0, total: 0, truncated: false };

  const state = await readSyncState();
  const clockWentBackward = !!state && Date.now() < state.lastSyncAt;
  const full = !!opts?.full || !state || state.jql !== config.jql || clockWentBackward || !cache;

  // 用请求**发起**的时间，不是拿到结果之后的时间——不然请求这段时间里发生的
  // 改动会被下一次的窗口漏掉。
  const startedAt = Date.now();

  let result: IssuesResult;
  if (full) {
    // 显式同步动作，绕开 60 秒的页面缓存——用户点了同步，或者游标不可用，就该
    // 真的问一次全量。issues() 会把结果写进模块级缓存，工单页的列表跟着更新。
    result = await issues(true);
  } else {
    // 增量必须绕开 issues() 的模块级缓存，不能顺手调用它：那份缓存同时也是
    // /api/jira 给工单页展示"全部工单列表"用的数据源。增量结果天然只有"这次
    // 变了的那几条"，如果把它写进那份缓存，页面就会把"最近改过的几条"渲染成
    // "这就是全部工单"，凭空丢掉一大片没变的单。所以这里直接调 fetchIssues，
    // 结果只喂给下面的 syncIssues/dev 刷新，从不碰 cache。
    result = await fetchIssues(config, fetch, incrementalJql(config.jql, incrementalWindowMinutes(state.lastSyncAt)));
  }

  if (!result.ok) {
    // 这里才是真正知道"问不到"这件事的地方——不是 start() 那个永远等不到异常
    // 的 .catch()。unconfigured 不算失败：还没配置的人不该每次启动都吃一行
    // 错误日志，那是"正常"的初始状态，不是故障。auth/query/unreachable 才是
    // 值得写进日志的——只打分类过的原因，不打原始响应体：那里面带账号信息，
    // 跟 /api/jira/config 从不回显 token 是同一条线。
    if (result.reason !== "unconfigured") {
      console.error(`[jira] ${full ? "全量" : "增量"}同步失败：${result.reason}`);
    }
    return { created: 0, updated: 0, total: 0, truncated: false };
  }

  // 增量分支不写 `cache`（见上面的注释），但取回的每一条 issue 本身仍然带着
  // 完整字段，包括 assignee——`enrich()` 读的是 `issueCache`，不是 `cache`，
  // 所以把它焐热在这里跟"不污染全量列表"完全不冲突。不这么做的后果是：增量
  // 同步进来或更新的单子，assignee 明明问到了却被直接扔掉，页面上的「负责
  // 人」一直空着，只有点过一次单条「刷新」（走 refreshIssue，见上面 issueCache
  // 的注释）才会补上。全量分支已经在 issues() 里做了同样的事，这里不用重复。
  if (!full) {
    const at = Date.now();
    for (const issue of result.issues) issueCache.set(issue.key, { at, issue });
  }

  // 游标只在拉取成功之后才前移，失败绝不推进——推进了就等于承认"这段时间的
  // 改动我们已经看过了"，而实际上一条都没看到。
  await writeSyncState({ lastSyncAt: startedAt, jql: config.jql });

  // 同步之前先记下已经存在的 (provider, ref)：ensureItemForSource 返回的是
  // WorkItem 本身，不带"是不是新建的"这个标志——加这个标志要为了这一个调用方
  // 去改内核签名，划不来。改成调用方自己在同步前拍一张快照，之后用它判断。
  const before = await readItems();
  const existingRefs = new Set(
    before.filter((i) => i.source?.provider === "jira").map((i) => i.source!.ref),
  );

  // 工单页地址。只有产生这个来源的一方知道怎么拼——内核不该替它猜，所以由这里
  // 一并写进 source.url，首页那颗单号徽标据此变成可点的链接。
  const browse = await browseUrl();
  const syncResult = await syncIssues(result, async (ref, title, createdAt) => {
    const created = !existingRefs.has(ref);
    await ensureItemForSource("jira", ref, title, { refreshTitle: true, createdAt, ...browse(ref) });
    return { created };
  });

  // PR/检查是独立的一步：这一步失败不该把已经写好的工单同步结果变成失败。
  try {
    const [afterItems, bindings] = await Promise.all([readItems(), resolveBindings(await liveFromKernel())]);
    const targets = devTargets(afterItems, bindings);
    if (targets.length) {
      // 增量结果里查不到的活跃绑定单（本身没变，但仍想刷一次 PR/CI），退回
      // 上一次缓存的全量列表去找——见 resolveDevIds 的注释。
      const cachedIssues = cache?.result.ok ? cache.result.issues : [];
      const resolved = resolveDevIds(result.issues, cachedIssues, targets);
      await mapLimited(resolved, DEV_CONCURRENCY, ({ id, key }) => dev(id, key, true));
    }
  } catch {
    // 拉 PR/检查失败不影响已经同步好的工单结果。
  }

  return syncResult;
}

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

/**
 * 只刷新一个单：先重取工单本身，再重取它的 PR/检查，再把标题写回内核。
 *
 * 不经过 devTargets 的"只给有活跃会话的单拉"这条限制——那条限制是为了不在批量
 * 同步时打出上百个请求，单条刷新是用户明确点了这一个,该刷就刷。
 *
 * refreshIssue 返回 null 时（未配置、Jira 不通）不能悄悄 return——那样调用方
 * （refreshFromSource，再往上是首页的刷新按钮）会看到一个 resolve 掉的
 * Promise，把"没问到"读成"问到了、也刷了"。抛出去，让 refreshFromSource 已有的
 * try/catch 把它收成 false，页面才会照实说"刷新失败"而不是假装刷新成功地
 * 重新渲染一遍原样的卡片。这条判断是 CLAUDE.md 里 checksKnown 那条的同一个理由：
 * "我们没问到"不能被表现成"我们问到了"。
 *
 * ensureItemForSource(..., { refreshTitle: true }) 补的是同步（sync()）已经在
 * 做、但单条刷新一直没做的事：远端改了标题，全量同步会跟着改，点这一个单的
 * 刷新按钮却不会——同一个按钮，越具体的动作反而做得比笼统的那个少，用户会当
 * 成没生效。
 */
export async function refreshItem(ref: string): Promise<void> {
  const issue = await refreshIssue(ref);
  if (!issue) throw new Error(`refreshIssue(${ref}) 没问到——未配置或 Jira 不通`);
  await dev(issue.id, issue.key, true);
  const browse = await browseUrl();
  const createdAt = issue.created ? Math.floor(issue.created / 1000) : undefined;
  await ensureItemForSource("jira", ref, issue.summary, { refreshTitle: true, createdAt, ...browse(ref) });
}

/** `ItemStatus` → 这个实例配的 Jira 状态名。`unclaimed` 不是一次迁移，没有对应项。 */
function jiraStatusFor(config: JiraConfig, to: ItemStatus): string {
  switch (to) {
    case "in_progress":
      return config.transitions.inProgress;
    case "in_review":
      return config.transitions.inReview;
    case "in_merge":
      return config.transitions.inMerge;
    case "done":
      return config.transitions.done;
    case "unclaimed":
      return "";
  }
}

/**
 * ItemLifecycle 迁移之后的写回：只转 Jira 状态。
 *
 * 不写 PR：评论区是给人看的地方，不该由工具自动灌水。
 *
 * 不吞异常：调用方（`plugins/handlers.ts` 的 `notifyLifecycleChange`）已经在
 * 外层 try/catch+超时，这里如实抛出。
 */
export async function onLifecycleChange(ref: string, from: ItemStatus, to: ItemStatus): Promise<void> {
  const config = await readJiraConfig();
  if (!config) return;

  const targetStatus = jiraStatusFor(config, to);
  await transitionIssue(config, ref, targetStatus).catch(() => {});
}

/**
 * 拼工单页地址的函数，配置读一次。
 *
 * 没配 URL 就返回空对象——`ensureItemForSource` 收到没有 url 的 opts 会原样保留
 * 已有的那个，而不是清掉。这是对的：读不到配置是**我们**这边的临时状态，不该
 * 表现成"这张单没有地址了"。
 */
async function browseUrl(): Promise<(ref: string) => { url?: string }> {
  const config = await readJiraConfig();
  const base = config?.url;
  if (!base) return () => ({});
  return (ref) => ({ url: `${base}/browse/${encodeURIComponent(ref)}` });
}

/**
 * 进程启动时的一次机会。发出去就不管——手机打开这个页面不该等 Jira 的网络往返。
 *
 * 这里的 .catch() **不是失败报告的地方**——真正知道"问不到、以及为什么"的是
 * sync() 内部 `!result.ok` 那个分支，日志已经打在那儿了（见 sync() 的注释）。
 * 这条 .catch() 现在纯粹是防呆：sync() 目前每一步都在自己的 try/catch 里
 * （issues()/readJiraConfig() 从不抛，PR/dev 那一步有自己的 try/catch），
 * 按今天的写法它不会拒绝，但"今天不会"不是语言保证——以后有人往 sync() 里加
 * 一步没包 try/catch 的代码，这条 .catch() 是唯一挡在"一个插件的 start() 抛出
 * 未捕获异常"和"整个启动流程"之间的东西（同 plugins/handlers.ts 的
 * startPlugins() 那条"一个插件的 start 抛了不能挡住服务器起来"）。故意不在这
 * 里第二次打日志：那会让人以为这里也是覆盖失败原因的地方，而它现在真的不是。
 */
export function start(): void {
  void sync().catch(() => {});
}

export async function handle(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/jira/config" && req.method === "GET") {
    const config = await readJiraConfig();
    // token 从不出门。url 和 email 出门是为了页面能显示"连的是哪个实例"。
    return Response.json(
      config ? { configured: true, url: config.url, email: config.email } : { configured: false },
    );
  }

  if (url.pathname === "/api/jira/issues" && req.method === "GET") {
    return Response.json(await issues(url.searchParams.get("refresh") === "1"));
  }

  // PR 与 CI。带 id 就是一个单——这是"只刷这一个"的入口；不带就是当前列表里的全部，
  // 走缓存加并发上限，而不是让浏览器自己发五十个请求。
  if (url.pathname === "/api/jira/dev" && req.method === "GET") {
    const refresh = url.searchParams.get("refresh") === "1";
    const one = url.searchParams.get("id");

    // 单号从缓存的工单列表里查，不从请求里收：它决定哪些 PR 被留下，让浏览器指定
    // 等于把过滤规则交给调用方。
    const listed = await issues(false);
    const keyById = new Map(listed.ok ? listed.issues.map((i) => [i.id, i.key]) : []);

    if (one !== null) {
      // id 只可能是 Jira 的内部数字 id，它会被拼进一个对外的 URL。
      if (!/^\d{1,19}$/.test(one)) return new Response("bad id", { status: 400 });
      const key = keyById.get(one) ?? "";

      // 单条刷新连工单本身一起刷。
      //
      // 从前它只刷 PR 与构建，于是一个长在卡片上的刷新按钮只刷了卡片的一半：状态
      // 还是几分钟前的样子。那不是 bug，但会被读成 bug——按钮在哪张卡上，就该把那
      // 张卡刷新。
      const fresh = refresh && key ? await refreshIssue(key) : null;

      return Response.json({
        dev: { [one]: await dev(one, key, refresh) },
        ...(fresh ? { issue: fresh } : {}),
      });
    }

    if (!listed.ok) return Response.json({ dev: {} });
    const ids = listed.issues.map((i) => i.id).filter(Boolean);
    const results = await mapLimited(ids, DEV_CONCURRENCY, (id) =>
      dev(id, keyById.get(id) ?? "", refresh),
    );
    return Response.json({ dev: Object.fromEntries(ids.map((id, i) => [id, results[i]!])) });
  }

  if (url.pathname === "/api/jira/bindings" && req.method === "GET") {
    return Response.json({ bindings: await jiraBindingsView(await liveFromKernel()) });
  }

  if (url.pathname === "/api/jira/bindings" && req.method === "POST") {
    let body: { session?: unknown; key?: unknown };
    try {
      body = await req.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }
    if (typeof body.session !== "string" || !body.session) {
      return new Response("bad session", { status: 400 });
    }
    if (typeof body.key !== "string" || !/^[A-Z][A-Z0-9]*-\d+$/.test(body.key)) {
      // 单号形状收窄：它会进文件名以外的地方展示，也会拼进 Jira 的 URL。
      return new Response("bad key", { status: 400 });
    }
    const live = await liveFromKernel();
    const found = live.find((s) => s.name === body.session);
    await claimIssue(body.session, body.key, found?.sessionId ?? "");
    return Response.json({ ok: true });
  }

  if (url.pathname === "/api/jira/bindings" && req.method === "DELETE") {
    const session = url.searchParams.get("session") ?? "";
    if (!session) return new Response("bad session", { status: 400 });
    await unbindSession(session);
    return Response.json({ ok: true });
  }

  return null;
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

/**
 * 交给内核的来源：五个方法都是这个文件里已有的函数。
 *
 * 内核只按 `provider` 这个字符串找到它，从不知道这是哪个插件——`plugins/handlers.ts`
 * 的 `SERVERS.jira.sources` 里放的就是这一个对象。
 */
export const source: ItemSourceProvider = {
  provider: "jira",
  sync,
  refreshItem,
  enrich,
  fields,
  onLifecycleChange,
};
