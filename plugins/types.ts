/**
 * 一个插件对内核声明的东西。纯数据，没有行为——行为在 handlers.ts 那张表里，
 * 分开是因为这份清单要被浏览器 import。
 */
export type Plugin = {
  /** 同时决定 /api/<id>/*、/p/<id>/*、以及状态目录名。^[a-z][a-z0-9-]*$ */
  id: string;
  /** 顶栏 title/aria-label 用的 i18n 键。 */
  titleKey: string;
  /** 24×24 viewBox 里的 path 串，格式跟 nav.js 现有图标一致。 */
  icon: string;
  i18n: { zh: Record<string, string>; en: Record<string, string> };
  /**
   * 这个插件贴的 Facet.dim 会用到的 i18n 键，例如 `["jira.status", "jira.epic"]`。
   *
   * 纯粹是给 src/i18n.test.ts 的死键扫描看的：`tr(facet.dim)` 是动态查找，扫描器
   * 只认字符串字面量，看不见跟着数据来的键名，会把这些键误判成没人用。列在这里
   * 的键因此被扫描器当成真实使用点（跟 titleKey 同一个道理），不写也完全不影响
   * 运行时——chip 渲染走的是 tr(dim) 本身的回退，不读这个数组。
   */
  facetDims?: string[];
  /**
   * 这个插件搬家前占用过的地址，例如 `gallery.html`。
   *
   * 内核据此发 301 到 `p/<id>/`，所以手机上存了书签、装了 PWA 的人不会撞 404。
   * 只收纯文件名（不含 `/`），而且这个跳转排在静态文件之后——真实存在的页面永远
   * 优先，插件声明一个 `index.html` 也劫持不了首页。
   */
  legacyPaths?: string[];
  /**
   * 让内核替这个插件生成页面外壳，`mainId` 是内容容器的 id。
   *
   * 那段外壳（视口、PWA 清单的 use-credentials、图标、主题样式表、顶栏容器）三个
   * 插件一字不差，靠复制粘贴维持——飘了不会有任何东西报错，而其中 manifest 那行的
   * `crossorigin` 一旦漏掉，反代要求登录时 PWA 安装会无声失败。写成清单里的一个 id，
   * 就没有可飘的东西了。
   *
   * 不写这一项就是自带 `public/index.html`：制品库要的全屏查看器需要额外的 DOM，
   * 这个逃生口是为它这种情况留的，不是摆设。
   */
  page?: { mainId: string };
  /**
   * 这个插件认领哪些 `WorkItem.source.provider`，例如 `["jira"]`。
   *
   * 内核据此知道"谁负责这个来源"，从而能在首页发起「刷新这一个单」而**不点名任何
   * 插件**——它只做一次查表，而这张表是插件自己声明的数据，不是内核维护的名单。
   * 跟 titleKey、legacyPaths、facetDims 同一步棋：凡是内核需要知道、又不该写死的
   * 东西，都由清单声明。
   */
  provides?: string[];
};

/**
 * 插件的服务端入口。只在路径命中 /api/<id> 或 /api/<id>/* 时被调用，
 * 前缀由内核校验。返回 null 表示"这个子路径我不认"，内核继续往下走到 404。
 */
export type PluginHandler = (req: Request, url: URL) => Promise<Response | null>;

/**
 * 插件贴在一张单上的一个维度。
 *
 * `dim` 是 **i18n 键**，不是显示文本（`jira.status`、`jira.epic`）。插件的字典本
 * 来就合并进内核字典，所以 `tr(dim)` 直接查得到，查不到就退回显示 dim 本身。
 *
 * 这条是整个设计能不违反"内核绝不点名插件"的关键：**内核里因此没有任何"哪个插件
 * 有哪些维度"的表**——维度是数据，跟着 facet 一起来。
 */
export type Facet = { dim: string; value: string; tone?: "ok" | "warn" | "dim" };

/**
 * 问插件时给它看的单。
 *
 * 传**全部**单给每个插件，不按 `source.provider === 插件 id` 预筛——预筛会在内核里
 * 写死"provider 名就是插件 id"这个等式，而那正是要守的那条线。让插件自己看 source
 * 挑，成本可以忽略（几十条），还顺带允许一个不绑定任何来源的插件（比如读 git 分支
 * 的）也贡献维度。
 */
export type ItemRef = { id: string; source: { provider: string; ref: string } | null };

/** 插件可选导出的维度函数。不认识的单不必出现在返回值里。 */
export type PluginEnricher = (items: ItemRef[]) => Promise<Record<string, Facet[]>>;
