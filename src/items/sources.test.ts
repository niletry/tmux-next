import { test, expect, afterEach } from "bun:test";
import {
  sourceProviders,
  claimedProviders,
  pluginEnrichers,
  collectFacets,
  collectFields,
  runSync,
  refreshFromSource,
  notifyLifecycleChange,
  ENRICH_TIMEOUT_MS,
  FIELD_TIMEOUT_MS,
  SOURCE_TIMEOUT_MS,
  MAX_FACETS_PER_ITEM,
  MAX_DETAIL_ROWS,
  MAX_FIELD_LEN,
  MAX_FIELDS_PER_ITEM,
  type ItemSourceProvider,
  type SyncResult,
} from "./sources";
import type { PluginServer } from "../../plugins/handlers";
import type { Facet, ItemRef, PluginEnricher, PluginFieldSource } from "../../plugins/types";

/**
 * 内核只认识「来源」：一张单只有 source.provider，据此在插件交出的
 * ItemSourceProvider[] 里查一次。内核里没有任何 provider→插件 的名单。
 *
 * 来源表作为参数注入，理由跟从前的 collectFacets 一样：注册表是编译期常量，
 * 不注入假来源就没法证明超时和 try/catch 真的会兜住。
 */

const TEST_TIMEOUT_MS = 50;
const ok = (n: number): SyncResult => ({ created: n, updated: 0, total: n, truncated: false });

const items: ItemRef[] = [
  { id: "it-1", source: { provider: "alpha", ref: "A-1" } },
  { id: "it-2", source: null },
  { id: "it-3", source: { provider: "beta", ref: "B-9" } },
];

afterEach(() => {
  delete process.env.TMUX_NEXT_DISABLE_PLUGINS;
});

test("sourceProviders 收集每个启用插件交出的来源", () => {
  const servers: Record<string, PluginServer> = {
    p: { sources: [{ provider: "alpha" }, { provider: "beta" }] },
    q: { sources: [{ provider: "gamma" }] },
    r: {},
  };
  expect(sourceProviders(servers).map((s) => s.provider)).toEqual(["alpha", "beta", "gamma"]);
  expect(claimedProviders(servers)).toEqual(["alpha", "beta", "gamma"]);
});

test("两个来源声明同一个 provider，后者被丢弃", () => {
  const first: ItemSourceProvider = { provider: "alpha", sync: async () => ok(1) };
  const second: ItemSourceProvider = { provider: "alpha", sync: async () => ok(2) };
  const servers: Record<string, PluginServer> = { p: { sources: [first] }, q: { sources: [second] } };
  const got = sourceProviders(servers);
  expect(got).toHaveLength(1);
  expect(got[0]).toBe(first);
});

test("TMUX_NEXT_DISABLE_PLUGINS 关掉的插件，它的来源一并消失", () => {
  // 只有真注册表里的 id 才受 env 影响；这里用真的 jira id 来验证过滤。
  const servers: Record<string, PluginServer> = {
    jira: { sources: [{ provider: "jira" }] },
    other: { sources: [{ provider: "other" }] },
  };
  expect(claimedProviders(servers)).toEqual(["jira", "other"]);
  process.env.TMUX_NEXT_DISABLE_PLUGINS = "jira";
  expect(claimedProviders(servers)).toEqual(["other"]);
});

test("pluginEnrichers 只收启用插件的插件级 enrich", () => {
  const mine: PluginEnricher = async () => ({});
  const servers: Record<string, PluginServer> = {
    jira: { enrich: mine },
    other: { enrich: mine },
    none: {},
  };
  expect(pluginEnrichers(servers)).toHaveLength(2);
  process.env.TMUX_NEXT_DISABLE_PLUGINS = "jira";
  expect(pluginEnrichers(servers)).toHaveLength(1);
});

test("来源级 enrich 只收到自己 provider 的单", async () => {
  let seen: ItemRef[] = [];
  const alpha: ItemSourceProvider = {
    provider: "alpha",
    enrich: async (got) => {
      seen = got;
      return { "it-1": [{ dim: "alpha.status", value: "open" }] };
    },
  };
  const out = await collectFacets(items, [alpha], []);
  expect(seen.map((i) => i.id)).toEqual(["it-1"]);
  expect(out).toEqual({ "it-1": [{ dim: "alpha.status", value: "open" }] });
});

test("插件级 enrich 收到全部单", async () => {
  let seen: ItemRef[] = [];
  const extra: PluginEnricher = async (got) => {
    seen = got;
    return { "it-2": [{ dim: "git.branch", value: "main" }] };
  };
  const out = await collectFacets(items, [], [extra]);
  expect(seen.map((i) => i.id)).toEqual(["it-1", "it-2", "it-3"]);
  expect(out).toEqual({ "it-2": [{ dim: "git.branch", value: "main" }] });
});

test("collectFields 只问认领了这张单来源的那一个来源", async () => {
  const asked: string[] = [];
  const alpha: ItemSourceProvider = {
    provider: "alpha",
    fields: async () => {
      asked.push("alpha");
      return { "alpha.summary": "修登录页" };
    },
  };
  const beta: ItemSourceProvider = {
    provider: "beta",
    fields: async () => {
      asked.push("beta");
      return { "beta.summary": "不该问到" };
    },
  };
  expect(await collectFields(items[0]!, [alpha, beta])).toEqual({ "alpha.summary": "修登录页" });
  expect(asked).toEqual(["alpha"]);
  expect(await collectFields(items[1]!, [alpha, beta])).toEqual({});
});

test("runSync 把每个来源的结果相加", async () => {
  const sources: ItemSourceProvider[] = [
    { provider: "a", sync: async () => ({ created: 2, updated: 1, total: 3, truncated: false }) },
    { provider: "b", sync: async () => ({ created: 0, updated: 4, total: 4, truncated: true }) },
    { provider: "c" },
  ];
  expect(await runSync(sources)).toEqual({ created: 2, updated: 5, total: 7, truncated: true });
});

test("runSync：一个来源抛了或卡住了，别的照常汇总", async () => {
  const sources: ItemSourceProvider[] = [
    { provider: "a", sync: async () => ok(3) },
    { provider: "bad", sync: async () => { throw new Error("boom"); } },
    { provider: "hang", sync: () => new Promise(() => {}) },
  ];
  expect(await runSync(sources, TEST_TIMEOUT_MS)).toEqual(ok(3));
});

test("refreshFromSource 按 provider 找来源，找不到/没实现/抛/卡住都是 false", async () => {
  const calls: string[] = [];
  const sources: ItemSourceProvider[] = [
    { provider: "a", refreshItem: async (ref) => { calls.push(ref); } },
    { provider: "noimpl" },
    { provider: "bad", refreshItem: async () => { throw new Error("boom"); } },
    { provider: "hang", refreshItem: () => new Promise(() => {}) },
  ];
  expect(await refreshFromSource("a", "A-1", sources)).toBe(true);
  expect(calls).toEqual(["A-1"]);
  expect(await refreshFromSource("nobody", "X", sources)).toBe(false);
  expect(await refreshFromSource("noimpl", "X", sources)).toBe(false);
  expect(await refreshFromSource("bad", "X", sources)).toBe(false);
  expect(await refreshFromSource("hang", "X", sources, TEST_TIMEOUT_MS)).toBe(false);
});

test("notifyLifecycleChange 把迁移送给认领的来源，失败静默", async () => {
  const seen: string[] = [];
  const sources: ItemSourceProvider[] = [
    { provider: "a", onLifecycleChange: async (ref, from, to) => { seen.push(`${ref}:${from}>${to}`); } },
    { provider: "bad", onLifecycleChange: async () => { throw new Error("boom"); } },
    { provider: "hang", onLifecycleChange: () => new Promise(() => {}) },
  ];
  await notifyLifecycleChange("a", "A-1", "in_progress", "in_review", sources);
  await notifyLifecycleChange("nobody", "X", "in_progress", "in_review", sources);
  await notifyLifecycleChange("bad", "X", "in_progress", "in_review", sources);
  await notifyLifecycleChange("hang", "X", "in_progress", "in_review", sources, TEST_TIMEOUT_MS);
  expect(seen).toEqual(["A-1:in_progress>in_review"]);
});

test("预算常量的值不变", () => {
  expect(ENRICH_TIMEOUT_MS).toBe(300);
  expect(FIELD_TIMEOUT_MS).toBe(5_000);
  expect(SOURCE_TIMEOUT_MS).toBe(30_000);
  expect(MAX_FACETS_PER_ITEM).toBe(6);
  expect(MAX_DETAIL_ROWS).toBe(20);
  expect(MAX_FIELDS_PER_ITEM).toBe(12);
  expect(MAX_FIELD_LEN).toBe(4000);
});

// ---- 从 src/plugin-enrich.test.ts 搬来 -----------------------------------------
//
// 这条口子的失败语义只有一种：**拿不到就当没有**。来源抛了、超时了、返回了不是
// 对象的东西，都只是这一轮没有 facet，首页照常渲染。内核的页面不能因为一个来源
// 而出不来——这是开这个口子的唯一安全阀。

const src = (enrich: PluginEnricher, provider = "alpha"): ItemSourceProvider => ({ provider, enrich });

const okEnrich: PluginEnricher = async () => ({ "it-1": [{ dim: "jira.status", value: "In Progress" }] });
const throwsEnrich: PluginEnricher = async () => {
  throw new Error("boom");
};
const hangsEnrich: PluginEnricher = () => new Promise(() => {});

test("没有来源时给空表", async () => {
  expect(await collectFacets(items, [], [])).toEqual({});
});

test("正常来源的 facet 收得到", async () => {
  expect(await collectFacets(items, [src(okEnrich)], [])).toEqual({
    "it-1": [{ dim: "jira.status", value: "In Progress" }],
  });
});

test("来源抛了，只是这一轮没有 facet", async () => {
  expect(await collectFacets(items, [src(throwsEnrich)], [])).toEqual({});
});

test("一个来源抛了不影响另一个", async () => {
  expect(
    await collectFacets(items, [src(throwsEnrich, "beta"), src(okEnrich, "alpha")], []),
  ).toEqual({ "it-1": [{ dim: "jira.status", value: "In Progress" }] });
});

test("来源卡住时超时返回，不吊死页面", async () => {
  const started = Date.now();
  expect(await collectFacets(items, [src(hangsEnrich)], [])).toEqual({});
  expect(Date.now() - started).toBeLessThan(ENRICH_TIMEOUT_MS * 4);
});

test("卡住的来源不影响正常来源", async () => {
  expect(
    await collectFacets(items, [src(hangsEnrich, "beta"), src(okEnrich, "alpha")], []),
  ).toEqual({ "it-1": [{ dim: "jira.status", value: "In Progress" }] });
});

test("返回不是对象时当作没有", async () => {
  const weird = (async () => ["nope"]) as unknown as PluginEnricher;
  expect(await collectFacets(items, [src(weird)], [])).toEqual({});
});

// 来源只能标注被问到的单，不能塞进没要求的键。
test("没被问到的 item id 被丢掉", async () => {
  const sneaky: PluginEnricher = async () => ({
    "it-1": [{ dim: "a", value: "1" }],
    "it-999": [{ dim: "b", value: "2" }],
  });
  expect(await collectFacets(items, [src(sneaky)], [])).toEqual({ "it-1": [{ dim: "a", value: "1" }] });
});

test("role 只认 pr / check，别的当没给", async () => {
  const src: ItemSourceProvider = {
    provider: "alpha",
    enrich: async () => ({
      "it-1": [
        { dim: "a.prs", value: "1", role: "pr" },
        { dim: "a.checks", value: "0/1", role: "check" },
        { dim: "a.other", value: "x", role: "bogus" } as unknown as Facet,
      ],
    }),
  };
  const got = await collectFacets(items, [src], []);
  expect(got["it-1"]!.map((f) => f.role)).toEqual(["pr", "check", undefined]);
});

test("value 截断到 120 字符", async () => {
  const long: PluginEnricher = async () => ({ "it-1": [{ dim: "a", value: "x".repeat(500) }] });
  const got = await collectFacets(items, [src(long)], []);
  expect(got["it-1"]![0]!.value.length).toBe(120);
});

test("dim 也截断，且没有 dim 或没有 value 的整条丢掉", async () => {
  const messy = (async () => ({
    "it-1": [
      { dim: "", value: "无维度" },
      { dim: "a", value: "" },
      { dim: "y".repeat(500), value: "有" },
    ],
  })) as unknown as PluginEnricher;
  const got = await collectFacets(items, [src(messy)], []);
  expect(got["it-1"]!.length).toBe(1);
  expect(got["it-1"]![0]!.dim.length).toBe(120);
});

// 一个来源不能刷爆卡片。
test("每单最多 6 个 facet", async () => {
  const flood: PluginEnricher = async () => ({
    "it-1": Array.from({ length: 50 }, (_, i) => ({ dim: `d${i}`, value: String(i) })),
  });
  const got = await collectFacets(items, [src(flood)], []);
  expect(got["it-1"]!.length).toBe(MAX_FACETS_PER_ITEM);
});

// 详情面板不是卡片：itemDetail 传 Infinity 跳过这条护栏，不然一张 Jira 单凑够 7 个
// 维度，最后一个（往往是 checks）就会被这条为首页设计的封顶悄悄吃掉。
test("cap 传 Infinity 时不截断", async () => {
  const flood: PluginEnricher = async () => ({
    "it-1": Array.from({ length: 50 }, (_, i) => ({ dim: `d${i}`, value: String(i) })),
  });
  const got = await collectFacets(items, [src(flood)], [], Infinity);
  expect(got["it-1"]!.length).toBe(50);
});

// 上一条用单个来源×50 条，就算把封顶挪回每个来源自己清理那一步（每个来源各自
// 砍到 6 条）也照样绿——那条测不出"两边加起来不能刷爆一张卡片"这条真正的属性。
// 这里换成一个来源级和一个插件级各给 4 条，合起来 8 条：封顶必须在合并之后做
// 才能压到 MAX_FACETS_PER_ITEM。
test("两处各自没超上限，合起来仍然砍到卡片的上限", async () => {
  const a: PluginEnricher = async () => ({
    "it-1": Array.from({ length: 4 }, (_, i) => ({ dim: `a${i}`, value: String(i) })),
  });
  const b: PluginEnricher = async () => ({
    "it-1": Array.from({ length: 4 }, (_, i) => ({ dim: `b${i}`, value: String(i) })),
  });
  const got = await collectFacets(items, [src(a, "alpha")], [b]);
  expect(got["it-1"]!.length).toBe(MAX_FACETS_PER_ITEM);
});

// 来源冒充内核自己的命名空间：一个坏来源贴一个 item.agent 就能在页面上再画一个
// Agent chip、把卡片重新分到别的组，等于让来源替内核的事实撒谎。
test("来源不能冒充 item.* 命名空间下的维度", async () => {
  const impostor: PluginEnricher = async () => ({
    "it-1": [
      { dim: "item.agent", value: "waiting" },
      { dim: "jira.status", value: "In Progress" },
    ],
  });
  const got = await collectFacets(items, [src(impostor)], []);
  expect(got["it-1"]).toEqual([{ dim: "jira.status", value: "In Progress" }]);
});

test("tone 只认三个值，别的丢掉", async () => {
  const toned = (async () => ({
    "it-1": [
      { dim: "a", value: "1", tone: "ok" },
      { dim: "b", value: "2", tone: "purple" },
    ],
  })) as unknown as PluginEnricher;
  const got = await collectFacets(items, [src(toned)], []);
  expect(got["it-1"]![0]!.tone).toBe("ok");
  expect(got["it-1"]![1]!.tone).toBeUndefined();
});

// 来源级和插件级给同一张单贴维度时，合并成一行 chips，而不是分层。
test("多处来的 facet 合并到同一张单下", async () => {
  const other: PluginEnricher = async () => ({ "it-1": [{ dim: "git.branch", value: "main" }] });
  const got = await collectFacets(items, [src(okEnrich, "alpha")], [other]);
  expect(got["it-1"]!.length).toBe(2);
  expect(got["it-1"]!.map((f: Facet) => f.dim).sort()).toEqual(["git.branch", "jira.status"]);
});

/**
 * facet 底下可展开的明细。
 *
 * 内核不解释这些行是什么——是 CI 检查还是别的，只有来源知道。但它照样不信来源给
 * 的长度和数量：截断、封顶、tone 只认三个值，跟 facet 本身同一套姿态。
 */

test("明细原样带过来", async () => {
  const withDetail: PluginEnricher = async () => ({
    "it-1": [
      {
        dim: "jira.checks",
        value: "1/2",
        detail: [
          { label: "ci/circleci: test", value: "FAILED", tone: "warn" },
          { label: "ci/circleci: build", value: "SUCCESSFUL", tone: "ok" },
        ],
      },
    ],
  });
  const got = await collectFacets(items, [src(withDetail)], []);
  expect(got["it-1"]![0]!.detail?.length).toBe(2);
  expect(got["it-1"]![0]!.detail?.[0]!.label).toBe("ci/circleci: test");
});

test("没有明细的 facet 不带 detail 字段", async () => {
  const got = await collectFacets(items, [src(okEnrich)], []);
  expect(got["it-1"]![0]!.detail).toBeUndefined();
});

// 一个坏来源不能靠明细撑爆浮层。
test("明细行数封顶", async () => {
  const flood: PluginEnricher = async () => ({
    "it-1": [
      {
        dim: "a",
        value: "1",
        detail: Array.from({ length: 100 }, (_, i) => ({ label: `c${i}`, value: "OK" })),
      },
    ],
  });
  const got = await collectFacets(items, [src(flood)], []);
  expect(got["it-1"]![0]!.detail?.length).toBe(MAX_DETAIL_ROWS);
});

test("明细的 label 截断到 120，没有 label 的整行丢掉", async () => {
  const messy = (async () => ({
    "it-1": [
      {
        dim: "a",
        value: "1",
        detail: [{ label: "x".repeat(500), value: "OK" }, { label: "", value: "OK" }],
      },
    ],
  })) as unknown as PluginEnricher;
  const got = await collectFacets(items, [src(messy)], []);
  expect(got["it-1"]![0]!.detail?.length).toBe(1);
  expect(got["it-1"]![0]!.detail?.[0]!.label.length).toBe(120);
});

test("明细的 tone 只认三个值", async () => {
  const toned = (async () => ({
    "it-1": [
      { dim: "a", value: "1", detail: [{ label: "c", value: "OK", tone: "purple" }] },
    ],
  })) as unknown as PluginEnricher;
  const got = await collectFacets(items, [src(toned)], []);
  expect(got["it-1"]![0]!.detail?.[0]!.tone).toBeUndefined();
});

// detail 不是绕过 item.* 保护的后门：整条 facet 仍然按 dim 被拦掉。
test("冒充 item.* 的 facet 连带它的明细一起被拦", async () => {
  const sneaky = (async () => ({
    "it-1": [{ dim: "item.agent", value: "waiting", detail: [{ label: "c", value: "OK" }] }],
  })) as unknown as PluginEnricher;
  expect(await collectFacets(items, [src(sneaky)], [])).toEqual({});
});

// 明细行的链接会变成页面上的 href，所以内核只放行 http/https。这几条不是"格式校验"，
// javascript: 是一条真的注入路径，相对地址则按当前页解析——来源不知道自己挂在哪。
test("明细里的 http/https 链接原样带过去", async () => {
  const got = await collectFacets([{ id: "a", source: null }], [], [
    async () => ({
      a: [{ dim: "x", value: "1", detail: [
        { label: "PR-1", value: "OPEN", url: "https://example.com/pr/1" },
        { label: "PR-2", value: "OPEN", url: "http://example.com/pr/2" },
      ] }],
    }),
  ]);
  expect(got.a![0]!.detail![0]!.url).toBe("https://example.com/pr/1");
  expect(got.a![0]!.detail![1]!.url).toBe("http://example.com/pr/2");
});

test("非 http/https 的链接被丢掉，但那一行还在", async () => {
  const got = await collectFacets([{ id: "a", source: null }], [], [
    async () => ({
      a: [{ dim: "x", value: "1", detail: [
        { label: "坏的", value: "OPEN", url: "javascript:alert(1)" },
        { label: "相对", value: "OPEN", url: "/p/jira/" },
        { label: "文件", value: "OPEN", url: "file:///etc/passwd" },
        // 插件清单那一侧是 JS，类型挡不住这个；safeHttpUrl 挡的正是运行时。
        { label: "不是字符串", value: "OPEN", url: { toString: () => "https://x/" } as unknown as string },
      ] }],
    }),
  ]);
  const rows = got.a![0]!.detail!;
  expect(rows.length).toBe(4);
  expect(rows.every((r) => r.url === undefined)).toBe(true);
  expect(rows[0]!.label).toBe("坏的");
});

/**
 * chip 图标：来源给形状，内核套外壳。
 *
 * 传的是 SVG 路径而不是图标名，因为内核不认识 epic——史诗和缺陷的区别是 Jira 的
 * 概念，issue 类型还是个开放集合。跟顶栏标签的 plugin.icon 同源。
 *
 * 但这个字段最终会进 innerHTML，而净化对来源给的每一个别的字段都做了处理（文本
 * 限长、tone 白名单、url 只认 http）。留一个字段直通，会让下一个读这段代码的人
 * 搞不清这里到底管不管，所以它也过一道白名单——下面钉住那道白名单。
 */
const withIcon = (icon: unknown): PluginEnricher =>
  async () => ({ "it-1": [{ dim: "jira.type", value: "Epic", icon } as unknown as Facet] });

test("chip 图标：几何图元原样通过", async () => {
  const paths = '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>';
  const got = await collectFacets(items, [src(withIcon(paths))], []);
  expect(got["it-1"]![0]!.icon).toBe(paths);
});

test("chip 图标：多个图元也通过", async () => {
  const paths = '<rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="12" cy="12" r="3"/>';
  const got = await collectFacets(items, [src(withIcon(paths))], []);
  expect(got["it-1"]![0]!.icon).toBe(paths);
});

// 白名单是按"整串必须由自闭合的图元标签组成"写的，不是逐个黑名单去堵——所以
// script、事件属性、乃至一个多出来的裸文本节点，在语法上就进不来。
test.each([
  ['<script>alert(1)</script>', "script 标签"],
  ['<path d="M0 0" onload="alert(1)"/>', "事件属性"],
  ['<path d="M0 0"/><script src="x"/>', "夹带一个 script"],
  ['<image href="javascript:alert(1)"/>', "不在白名单里的元素"],
  ['<path d="M0 0"/>裸文本', "尾巴上挂文本"],
  ["", "空串"],
  [42, "根本不是字符串"],
])("chip 图标：%s 一律当没给", async (bad) => {
  const got = await collectFacets(items, [src(withIcon(bad))], []);
  expect(got["it-1"]![0]!.icon).toBeUndefined();
  // 图标被丢掉，facet 本身还在——一个画不出来的图标不该连带把这条维度也吞了。
  expect(got["it-1"]![0]!.value).toBe("Epic");
});

test("chip 图标：过长的一律当没给", async () => {
  const huge = '<path d="' + "M0 0".repeat(600) + '"/>';
  const got = await collectFacets(items, [src(withIcon(huge))], []);
  expect(got["it-1"]![0]!.icon).toBeUndefined();
});

/**
 * badge 是显示上的一个分流开关（单号前的徽标，而不是一格 chip），所以它跟别的
 * 字段一样只认一个确定的值：`true`。给别的东西就当没说——一个真值不明的开关会让
 * 同一条维度在两个位置之间跳。
 */
const withBadge = (badge: unknown): PluginEnricher =>
  async () => ({ "it-1": [{ dim: "jira.type", value: "Epic", badge } as unknown as Facet] });

test("badge：true 原样带过去", async () => {
  const got = await collectFacets(items, [src(withBadge(true))], []);
  expect(got["it-1"]![0]!.badge).toBe(true);
});

test.each([["yes"], [1], [{}], [false]])("badge：%p 当没给", async (bad) => {
  const got = await collectFacets(items, [src(withBadge(bad))], []);
  expect(got["it-1"]![0]!.badge).toBeUndefined();
  expect(got["it-1"]![0]!.value).toBe("Epic");
});

// stage/light/sortKey 曾经被漏掉透传——来源给了，净化函数却只拷贝了
// dim/value/tone/detail/icon/badge 这几个字段，statusLightRow 因此从未在
// 任何页面画出过一个点，排序下拉的「按状态排」也一样悄悄失效。
const withStage = (stage: unknown): PluginEnricher => async () => ({
  "it-1": [{ dim: "jira.status", value: "Ready for release", stage } as Facet],
});

test("stage：合法的 {rank, total} 原样带过去", async () => {
  const got = await collectFacets(items, [src(withStage({ rank: 4, total: 6 }))], []);
  expect(got["it-1"]![0]!.stage).toEqual({ rank: 4, total: 6 });
});

test.each([
  [{ rank: -1, total: 6 }],
  [{ rank: 1.5, total: 6 }],
  [{ rank: 6, total: 6 }], // rank 不能越过或等于 total
  [{ rank: 0 }],
  [{ total: 6 }],
  [{ rank: "0", total: 6 }],
  ["ok"],
  [null],
])("stage：形状不对的 %p 当没给", async (bad) => {
  const got = await collectFacets(items, [src(withStage(bad))], []);
  expect(got["it-1"]![0]!.stage).toBeUndefined();
});

test("light：true 原样带过去", async () => {
  const got = await collectFacets(items, [
    src(async () => ({ "it-1": [{ dim: "jira.checks", value: "0/1", light: true } as Facet] })),
  ], []);
  expect(got["it-1"]![0]!.light).toBe(true);
});

test.each([["yes"], [1], [false]])("light：%p 当没给", async (bad) => {
  const got = await collectFacets(items, [
    src(async () => ({
      "it-1": [{ dim: "jira.checks", value: "0/1", light: bad } as unknown as Facet],
    })),
  ], []);
  expect(got["it-1"]![0]!.light).toBeUndefined();
});

test("sortKey：{key, rank} 原样带过去", async () => {
  const got = await collectFacets(items, [
    src(async () => ({
      "it-1": [{ dim: "jira.status", value: "Done", sortKey: { key: "stage", rank: 5 } } as Facet],
    })),
  ], []);
  expect(got["it-1"]![0]!.sortKey).toEqual({ key: "stage", rank: 5 });
});

test("sortKey：rank 缺席时只带 key", async () => {
  const got = await collectFacets(items, [
    src(async () => ({
      "it-1": [{ dim: "jira.assignee", value: "Sam", sortKey: { key: "assignee" } } as Facet],
    })),
  ], []);
  expect(got["it-1"]![0]!.sortKey).toEqual({ key: "assignee" });
});

test.each([[{ rank: 1 }], [{ key: "", rank: 1 }], [{ key: "stage", rank: NaN }], [{ key: "stage", rank: "1" }]])(
  "sortKey：形状不对的 %p 只丢坏的那部分或整体丢弃",
  async (bad) => {
    const got = await collectFacets(items, [
      src(async () => ({
        "it-1": [{ dim: "jira.status", value: "Done", sortKey: bad } as unknown as Facet],
      })),
    ], []);
    const sortKey = got["it-1"]![0]!.sortKey;
    if (sortKey) expect(sortKey.rank).toBeUndefined();
    else expect(sortKey).toBeUndefined();
  },
);

// group 跟 label/value 同一套不信任姿态：截断、缺席时不出现在结果里。
test("明细行的 group 原样带过去，跟 label/value 一样限长", async () => {
  const got = await collectFacets([{ id: "a", source: null }], [], [
    async () => ({
      a: [{ dim: "x", value: "1", detail: [
        { label: "ci/test", value: "FAILED", group: "web-app · fix/login → main · OPEN" },
        { label: "ci/build", value: "SUCCESSFUL", group: "x".repeat(200) },
        { label: "无组", value: "OK" },
      ] }],
    }),
  ]);
  const rows = got.a![0]!.detail!;
  expect(rows[0]!.group).toBe("web-app · fix/login → main · OPEN");
  expect(rows[1]!.group?.length).toBe(120);
  expect(rows[2]!.group).toBeUndefined();
});

// groupUrl 跟 url 走同一道白名单：只放行 http/https，理由跟 url 完全相同——
// javascript: 是真的注入路径。
test("groupUrl 只放行 http/https，别的协议原样丢掉那个字段", async () => {
  const got = await collectFacets([{ id: "a", source: null }], [], [
    async () => ({
      a: [{ dim: "x", value: "1", detail: [
        { label: "ci/test", value: "OK", groupUrl: "https://example.com/pr/1" },
        { label: "ci/build", value: "OK", groupUrl: "javascript:alert(1)" },
        { label: "无链接", value: "OK" },
      ] }],
    }),
  ]);
  const rows = got.a![0]!.detail!;
  expect(rows[0]!.groupUrl).toBe("https://example.com/pr/1");
  expect(rows[1]!.groupUrl).toBeUndefined();
  expect(rows[2]!.groupUrl).toBeUndefined();
});

// send 是"该往会话里发什么"的原始文本，跟 label/value 一样净化，但截断上限
// 单独更宽（500，见 sources.ts 的 MAX_SEND_TEXT）——它要装得下一整句带链接
// 的提示，不是一格标签。
test("明细行的 send 原样带过去，截断到 500 字符，没给就不带这个字段", async () => {
  const got = await collectFacets([{ id: "a", source: null }], [], [
    async () => ({
      a: [{ dim: "x", value: "1", detail: [
        { label: "ci/test", value: "FAILED", send: "PR https://example.com/pr/1 的检查失败，请修复。" },
        { label: "ci/build", value: "SUCCESSFUL" },
        { label: "超长", value: "FAILED", send: "x".repeat(600) },
      ] }],
    }),
  ]);
  const rows = got.a![0]!.detail!;
  expect(rows[0]!.send).toBe("PR https://example.com/pr/1 的检查失败，请修复。");
  expect(rows[1]!.send).toBeUndefined();
  expect(rows[2]!.send?.length).toBe(500);
});

// ---- 从 src/plugin-fields.test.ts 搬来 ----------------------------------------
//
// 同一条道理：这个口子的失败语义只有一种——**拿不到就当没有**，占位符渲染成空。

const fieldItem: ItemRef = { id: "it-1", source: { provider: "alpha", ref: "A-1" } };
const fsrc = (fields: PluginFieldSource): ItemSourceProvider => ({ provider: "alpha", fields });

const okFields: PluginFieldSource = async () => ({ "jira.summary": "修登录页" });
const throwsFields: PluginFieldSource = async () => {
  throw new Error("boom");
};
const hangsFields: PluginFieldSource = () => new Promise(() => {});

test("没有来源时给空字段表", async () => {
  expect(await collectFields(fieldItem, [])).toEqual({});
});

test("正常来源的字段收得到", async () => {
  expect(await collectFields(fieldItem, [fsrc(okFields)])).toEqual({ "jira.summary": "修登录页" });
});

test("来源抛了，只是这一轮没有字段", async () => {
  expect(await collectFields(fieldItem, [fsrc(throwsFields)])).toEqual({});
});

test("来源卡住时超时返回，不吊死调用方", async () => {
  const started = Date.now();
  // 注入 50ms 的超时值而不是用 5 秒的默认值，让这条测试能在毫秒级证明超时会兜住。
  expect(await collectFields(fieldItem, [fsrc(hangsFields)], 50)).toEqual({});
  expect(Date.now() - started).toBeLessThan(200);
});

test("字段返回不是对象时当作没有", async () => {
  const weird = (async () => ["nope"]) as unknown as PluginFieldSource;
  expect(await collectFields(fieldItem, [fsrc(weird)])).toEqual({});
});

// item.* 是内核的命名空间。让来源写进来，等于让它伪造这张单的标题和单号，
// 而模板渲染分不出是谁写的。
test("来源不能占用 item.* 前缀", async () => {
  const sneaky: PluginFieldSource = async () => ({ "item.title": "假的", "jira.ok": "真的" });
  expect(await collectFields(fieldItem, [fsrc(sneaky)])).toEqual({ "jira.ok": "真的" });
});

test("占位符语法认不出的键被丢掉", async () => {
  const weird: PluginFieldSource = async () => ({ "有空格 的键": "x", "jira.ok": "真的" });
  expect(await collectFields(fieldItem, [fsrc(weird)])).toEqual({ "jira.ok": "真的" });
});

test("空值被丢掉，跟没给这个键一样", async () => {
  const blank: PluginFieldSource = async () => ({ "jira.epic": "" });
  expect(await collectFields(fieldItem, [fsrc(blank)])).toEqual({});
});

test("值截到 MAX_FIELD_LEN", async () => {
  const long: PluginFieldSource = async () => ({ "jira.description": "x".repeat(MAX_FIELD_LEN + 100) });
  const got = await collectFields(fieldItem, [fsrc(long)]);
  expect(got["jira.description"]!.length).toBe(MAX_FIELD_LEN);
});

// 封顶还在，只是现在一张单只有认领它来源的那一个来源能答：一个来源也不能灌爆一张单。
test("按 MAX_FIELDS_PER_ITEM 封顶", async () => {
  const many: PluginFieldSource = async () =>
    Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`a.k${i}`, "v"]));
  const got = await collectFields(fieldItem, [fsrc(many)]);
  expect(Object.keys(got).length).toBe(MAX_FIELDS_PER_ITEM);
});

test("facet 的 url 只认 http/https", async () => {
  const src: ItemSourceProvider = {
    provider: "alpha",
    enrich: async () => ({
      "it-1": [
        { dim: "a.epic", value: "x", url: "https://j/browse/E-1" },
        { dim: "a.bad", value: "y", url: "javascript:alert(1)" },
        { dim: "a.rel", value: "z", url: "browse/E-1" },
      ],
    }),
  };
  const got = await collectFacets(items, [src], []);
  expect(got["it-1"]!.map((f) => f.url)).toEqual(["https://j/browse/E-1", undefined, undefined]);
});
