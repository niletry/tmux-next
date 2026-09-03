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
  /**
   * 这个插件的可配置项。内核照着画表单，但**不认识任何一项是什么意思**。
   *
   * 跟 titleKey / facetDims / provides 同一步棋：内核需要知道、又不该写死的东西，
   * 由清单声明。有了它，接进来的下一个数据源自动就有配置界面，不必再动内核一行。
   *
   * 值不在这里——清单是同构的、要被浏览器 import，凭据绝不能进这个文件。存取归
   * 插件自己（handlers.ts 的 readSettings / writeSettings）。
   */
  settings?: SettingField[];
};

/**
 * 一个可配置项。
 *
 * `secret` 是唯一一个内核要区别对待的类型：它的值**从不出门**，读回来只有"设没
 * 设过"这一个比特。这不是修饰，是这个服务本身没有认证决定的——把 token 发进浏览器
 * 等于把它摊在任何能打开这个页面的东西面前，而配置它并不需要看见它。
 */
export type SettingField = {
  /** 存取时用的键。允许一层点号（`bitbucket.email`），插件自己解释它的含义。 */
  key: string;
  type: "text" | "url" | "secret" | "boolean";
  /** 字段名的 i18n 键，跟 titleKey 一样并进两份字典。 */
  labelKey: string;
  /** 可选的一行说明，也是 i18n 键。 */
  hintKey?: string;
  /** 留空是否算"没填"。secret 永远可留空——留空表示不改。 */
  required?: boolean;
};

/**
 * 读回来的配置值。
 *
 * secret 只报 `{ set: boolean }`，别的类型报原值。两者形状不同是故意的：如果密钥
 * 也用字符串表示"已设置"，那个占位串迟早会被某处当成真值写回去。
 */
export type SettingValue = string | boolean | { set: boolean };

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
/**
 * facet 底下可以展开的一行明细。
 *
 * 内核**不解释**这些行是什么——它只知道"这个维度带了若干行，可以点开看"。是 CI
 * 检查、是 PR 列表、还是别的，只有产生它的插件知道。这跟 `dim` 是个内核不去理解
 * 的 i18n 键、`source.url` 是只有来源方拼得出的链接，是同一步棋：**破坏插件界线
 * 的是内核去理解内容，不是插件提供内容。**
 *
 * 故意没有 url。明细只用来说明"这一格里都有什么"，需要跳转的话那是插件自己页面
 * 的事——而内核一旦开始渲染插件给的链接，就得管协议白名单（`javascript:` 是实打
 * 实的注入面）。不开这个口子，这条安全考量就不存在。
 */
export type FacetDetail = {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "dim";
  /**
   * 这一行指向哪里。只认 http/https，内核在 collectFacets 里挡（见 safeHttpUrl）。
   *
   * checks 当初刻意不给链接，理由是"给了就得管协议白名单"。PR 让这个理由不成立了：
   * 一次 CI 检查在这份数据里没有自己的地址，一个 PR 有，而且那正是看完状态之后
   * 要去的地方。列出来却点不开，等于只答了一半。白名单本身是三行 new URL 判断，
   * 不是当初担心的那种复杂度。
   */
  url?: string;
};

export type Facet = {
  dim: string;
  value: string;
  tone?: "ok" | "warn" | "dim";
  /**
   * 这一条说的是"这张单是个什么东西"，不是"它现在怎么样"——画在单号前面的一枚
   * 徽标，而不是下面那一排 chip 里的一格。
   *
   * 来源和类型是同一件事的两半（"Jira 上的一个缺陷"），各占一格 chip 时是两个
   * 词、一整行，而它们在一张卡片上从来不变。合成单号前面的一枚图标之后，那一行
   * 让给真正会变的东西：状态、检查、负责人。
   *
   * 仍然只是**显示**上的分流：这些维度照常参与分组和筛选，值也照常进徽标的
   * title，所以合并不会让"这单是从哪来的"变成读不到的信息。
   */
  badge?: boolean;
  /** 可展开的明细。有它的 chip 画成按钮，没有的还是一格静态文字。 */
  detail?: FacetDetail[];
  /**
   * 这个 chip 前面画一个图标，给的是 SVG 路径，不是图标名。
   *
   * 为什么是路径：内核没有、也不该有一张"维度取值 → 图标"的表。史诗和缺陷的
   * 区别是 Jira 的概念，issue 类型是一个开放集合（不同实例能自己造类型），内核
   * 一旦认识 epic，就等于认识了一个插件。跟顶栏标签的 `plugin.icon` 完全同源：
   * 插件给形状，内核套外壳（svgShell），画布、线宽、线头因此对所有插件一致。
   *
   * 内核只做三件事：套外壳、限长、只放行几何图元（见 collectFacets 的
   * ICON_SHAPES）。它不解析、不缓存、也不问这个形状是什么意思。
   */
  icon?: string;
};

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
