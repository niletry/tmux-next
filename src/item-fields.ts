import type { WorkItem } from "./items";

/**
 * 一张单的内核字段，喂给模板渲染。
 *
 * 纯函数：不碰磁盘、不碰 tmux、不发请求。要什么由调用方查好了传进来，于是能无头测。
 *
 * 全部占用 `item.` 这个命名空间，而 collectFields 挡住插件的键用这个前缀——两条规则
 * 合起来是一句干净的话：**内核的字段在这里，插件不许进来**。这跟 collectFacets 里那条
 * `dim.startsWith("item.")` 是同一个命名空间、同一个理由，区别只在这次内核真的往里放
 * 东西。模板语法因此不需要知道哪个键是谁产的。
 *
 * 单上**没有 cwd**，这里也不会凭空造一个：目录是"手段"的属性，不是"单"的属性
 * （见 CLAUDE.md）。要知道这单在哪个仓库，看它绑着的会话的 path。
 */

/** 取不到的一律是空字符串，不是 undefined——render 的"这一行是否全空"要靠这个判断。 */
export function kernelFields(item: WorkItem): Record<string, string> {
  return {
    "item.id": item.id,
    "item.title": item.title,
    "item.provider": item.source?.provider ?? "",
    "item.ref": item.source?.ref ?? "",
    "item.url": item.source?.url ?? "",
    "item.tags": item.tags.join(", "),
  };
}

/**
 * 设置页列给用户看的内核字段名。
 *
 * 走服务端（GET /api/templates 把它带上）而不是在 settings.js 里再抄一份：抄一份就有
 * 两处会飘，而飘了之后页面上列出的键名依然长得很像真的，没有任何东西会红。
 */
export const KERNEL_FIELD_KEYS: readonly string[] = [
  "item.title",
  "item.ref",
  "item.url",
  "item.provider",
  "item.tags",
  "item.id",
];
