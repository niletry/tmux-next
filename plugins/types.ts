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
