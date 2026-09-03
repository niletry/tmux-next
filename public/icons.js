// @ts-check
/**
 * 全站的图标，一处定义。
 *
 * 在此之前图标散在四个地方：nav.js 自带一张 ICONS 表和一个 svg() 助手，list.js
 * 和 jira.js 各自内联，terminal.html 里还有六个写死在 HTML 里的。四份同样的样板
 * 属性（viewBox、fill、stroke、linecap）意味着四份会各自漂移的东西——只要有一处
 * 少写 stroke-linecap，那个图标就比旁边的硬一档，而没有任何测试会发现。
 *
 * 这套的风格是既有的：Feather / Lucide 那一路，24×24 的画布、只描边不填充、
 * stroke-width 2、圆头圆角、颜色一律 currentColor。currentColor 是关键——图标因此
 * 自动跟着它所在元素的文字色走，包括主题切换和 :hover，不需要为图标单独定义任何
 * 颜色，也就不会有颜色字面量溜进来。
 *
 * 只放路径，不放 <svg> 外壳：外壳由 icon() 统一生成，这样"所有图标共享同一组样板
 * 属性"是构造保证的，不是靠每个调用点自觉。
 */

/** @type {Record<string, string>} */
export const ICON_PATHS = {
  // --- 导航 ---
  bell:
    '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>' +
    '<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  gear:
    '<circle cx="12" cy="12" r="3.2"/>' +
    '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 ' +
    '1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 ' +
    '0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 ' +
    '0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 ' +
    '0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 ' +
    '2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  sessions:
    '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>' +
    '<line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1.2"/>' +
    '<circle cx="3.5" cy="12" r="1.2"/><circle cx="3.5" cy="18" r="1.2"/>',
  // 一个带勾的方框——刻意跟 sessions 的三条线区分开，否则前两个标签在余光里
  // 是同一个形状。
  items:
    '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/>' +
    '<path d="M8 12.5l2.5 2.5 5.5-5.5"/>',

  // --- 动作 ---
  // 打开会话 = 打开一个终端。提示符加一条命令行，比一个泛用的"外链"箭头更说明
  // 点下去会发生什么。
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  pin: '<line x1="12" y1="17" x2="12" y2="22"/><path d="M6 17h12l-1.6-3.2V5a2 2 0 0 0-2-2H9.6a2 2 0 0 0-2 2v8.8z"/>',
  link:
    '<path d="M9.5 17H7.5a5 5 0 0 1 0-10h2"/><path d="M14.5 7h2a5 5 0 0 1 0 10h-2"/>' +
    '<line x1="8" y1="12" x2="16" y2="12"/>',
  // 左右各一支箭头：改挂是"从这里换到那里"，一个循环箭头会读成"刷新"。
  swap: '<path d="M8 3 4 7l4 4"/><path d="M4 7h15"/><path d="M16 21l4-4-4-4"/><path d="M20 17H5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 4.5 21 10.5 15 10.5"/>',
  archive:
    '<rect x="3" y="4" width="18" height="4" rx="1"/>' +
    '<path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/>' +
    '<line x1="10" y1="12.5" x2="14" y2="12.5"/>',
  // 电源符号。结束会话不是"删除"——会话是跑着的东西，关掉它才是那个动作；
  // 垃圾桶会让人以为有什么东西被丢掉了。
  power: '<path d="M12 3.5v8.5"/><path d="M18.4 7a9 9 0 1 1-12.8 0"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  // 会话此刻的状态，三个形状。它们替掉的是"等待你的回复""工作中""待发送"三个词
  // ——卡片那一行原来要写满一句话才说得清的事，现在一个字宽。
  hourglass:
    '<path d="M7 3h10"/><path d="M7 21h10"/>' +
    '<path d="M8 3v3.5L12 11l4-4.5V3"/><path d="M8 21v-3.5L12 13l4 4.5V21"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  pencil:
    '<path d="M12 20h9"/>' +
    '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  x: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
  chevronRight: '<path d="M9 5l7 7-7 7"/>',
  chevronDown: '<path d="M5 9l7 7 7-7"/>',
  folder: '<path d="M3 7.5a2 2 0 0 1 2-2h3.6l2 2H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  filter: '<path d="M21 4H3l7.5 8.5V19l3 1.5v-8z"/>',
};

/**
 * 一个图标的 SVG 字符串。
 *
 * `size` 是渲染尺寸，不是画布尺寸——画布永远是 24×24，缩放交给 width/height，
 * 所以同一个图标在 16px 和 20px 下的线宽比例一致。
 *
 * `aria-hidden`：图标在这套 UI 里从不单独承担含义，它旁边要么有文字，要么那个
 * 元素自己带 title/aria-label。让读屏软件念一遍图标名，只会在每个按钮前面多念
 * 一个没用的词。
 *
 * @param {string} name  ICON_PATHS 里的键
 * @param {number} [size] 边长，默认 16
 * @returns {string}
 */
export function icon(name, size = 16) {
  const paths = ICON_PATHS[name];
  return paths ? svgShell(paths, size) : "";
}

/**
 * 同一组样板属性，套在任意一段路径上。
 *
 * 给两种调用方用：icon() 按名字取路径，而插件在自己的清单里直接给路径——内核
 * 不认识任何一个插件，当然也不会有它们的图标名。两边共用这一个外壳，是为了让
 * "所有图标长得像一套"这件事对插件也成立：一个自带 <svg> 外壳的插件图标可以
 * 悄悄用上不同的 stroke-width，而那正是最难在评审里看出来的一类不一致。
 *
 * `size` 省略时不写 width/height，尺寸交给 CSS——顶栏的标签就是这么排的。
 *
 * @param {string} paths
 * @param {number} [size]
 * @returns {string}
 */
export function svgShell(paths, size) {
  const dim = size ? ` width="${size}" height="${size}"` : "";
  return (
    `<svg class="icon" viewBox="0 0 24 24"${dim} ` +
    'fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    `${paths}</svg>`
  );
}
