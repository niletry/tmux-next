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
};

/**
 * 插件的服务端入口。只在路径命中 /api/<id> 或 /api/<id>/* 时被调用，
 * 前缀由内核校验。返回 null 表示"这个子路径我不认"，内核继续往下走到 404。
 */
export type PluginHandler = (req: Request, url: URL) => Promise<Response | null>;

/**
 * 插件贴在会话列表某一行上的一小段只读展示数据。
 *
 * 只读、只展示：插件不能改列表行为、不能加动作、不能排序。这条边界是这个口子
 * 得以存在的前提——当初砍掉"跨页面挂钩"是因为没有消费者，现在有了，但能力面
 * 仍然按需要开，不按能想到的开。
 */
export type Annotation = { text: string; detail?: string; tone?: "ok" | "warn" | "dim" };

/**
 * 插件可选导出的标注函数。拿到的是会话名，返回会话名到标注的映射；不认识的会话
 * 不必出现在返回值里。
 */
export type PluginAnnotator = (sessions: string[]) => Promise<Record<string, Annotation>>;
