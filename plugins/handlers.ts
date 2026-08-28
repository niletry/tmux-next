import { PLUGINS } from "./registry.js";
import type { Plugin, PluginHandler } from "./types";
import { handle as gallery } from "./gallery/server";

/**
 * 插件的服务端那一半。
 *
 * 跟 registry.js 分开，是因为那张表要被浏览器 import：清单里只要引到一个 .ts，
 * 服务端代码就被打进浏览器包。plugins/registry.test.ts 有一条断言专守这个。
 */
export const HANDLERS: Record<string, PluginHandler> = { gallery };

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
