// @ts-check
/**
 * 内置插件，写死的一张表。
 *
 * 不扫目录、不做运行时加载：这是个无认证的 loopback 服务，动态 import 等于在
 * 里面跑任意第三方代码。加插件 = 加目录 + 在这里加一行。
 *
 * 同构：服务端和浏览器都 import 它，所以这里只能有清单，不能引任何 .ts。
 * 服务端那半在 plugins/handlers.ts。
 */

import gallery from "./gallery/plugin.js";
import notifications from "./notifications/plugin.js";

/** @type {import("./types").Plugin[]} */
export const PLUGINS = [gallery, notifications];
