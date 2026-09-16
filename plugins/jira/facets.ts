import type { Issue } from "./client";
import type { DevResult, PullRequest } from "./dev";
import type { Facet, ItemRef } from "../types";
import { classifyStatusStage, stageRank, STAGE_COUNT } from "./status-stage";

/**
 * 一张单能从两个缓存里读出哪些维度。纯函数，缓存当参数喂进来，于是能无头地测。
 *
 * 只认 source 是 jira 的单——传进来的是**全部**单（内核不按 provider 预筛，那会在
 * 内核里写死"provider 名就是插件 id"），挑是这边的事。
 */
/**
 * 一个检查状态对应的色调。
 *
 * 首页卡片是唯一渲染它的地方了（工单页已经退役）——只认 Bitbucket 的原始状态词。
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
export function prGroupLabel(pr: PullRequest): string {
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
 * 首页卡片是唯一渲染它的地方了（工单页已经退役，那份 typeIcon() 跟着一起没了）。
 * 这里一律走描边，因为内核的外壳是统一的 fill="none"——把填充也做成可配置，等于
 * 让每个插件都能改内核的图标语言，那正是这个外壳存在的理由的反面。
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
export function typeKey(issue: Issue): string {
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
export function epicSummaryOf(issue: Issue): string | null {
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
  browseBase = "",
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
  // 史诗和子任务的父任务，`hierarchy >= 1` 才是史诗——跟本文件 epicSummaryOf 是
  // 同一条规则，首页卡片是唯一渲染它的地方了。
  const epic = epicSummaryOf(issue);
  if (epic) {
    facets.push({
      dim: "jira.epic",
      value: epic,
      // 史诗有自己的工单页，chip 直接链过去——从前只有工单页上那颗父级 chip
      // 能点，首页的这颗只是文字。
      ...(browseBase && issue.parent ? { url: `${browseBase}/browse/${encodeURIComponent(issue.parent.key)}` } : {}),
    });
  }
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
      detail: [
        ...got.prs.map((pr) => ({
          label: pr.title || pr.branch,
          value: pr.status,
          tone: prFacetTone(pr.status),
          url: pr.url,
        })),
        // 过滤掉的说出来，不是悄悄少几条：onlyKeyedPrs 的意义就是 dev-status 会
        // 把别的单的 PR 挂过来，一个不声不响的过滤只是把一种不准换成另一种。
        // 文案是服务端中文：enrich 没有语言上下文，来源侧文案的 i18n 通路本轮不开。
        ...(got.hidden ? [{ label: `另有 ${got.hidden} 条 PR 未带本单号，已隐藏`, value: "", tone: "dim" as const }] : []),
      ],
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
