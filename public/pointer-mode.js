// @ts-check
/**
 * 打开终端要不要开一个新标签页。
 *
 * 9 月 11 号那次改动（"Open terminal links in a new tab"）把会话列表、单子面板、
 * Jira 浮层、通知卡片一共五处终端链接全部改成 `target="_blank"`：原地跳走会把
 * 点开它之前那一页（列表、面板）一起带走。这条理由在有鼠标的设备上成立——多开
 * 几个标签页是常态；但在手机上，浏览器的标签页管理本来就挤，每点一个会话就多
 * 一个标签页很快就堆不下，而手机上"后退"本身就够用，不需要新标签页替它兜底。
 *
 * 用 `pointer: fine` 而不是判断屏幕宽度或嗅探 UA：跟这个项目里所有"这是不是触屏
 * 设备"的判断（响应式布局那条规矩，见 CLAUDE.md）用的是同一个信号——一台窄的
 * 桌面窗口仍然有精确指针，不该因为窗口宽度就被当成手机。
 */

/**
 * @returns {boolean} 有精确指针（鼠标/触控板）时为 true——这时终端链接开新标签页；
 * 纯触屏设备为 false——原地跳转，交给系统的后退手势。
 */
export function opensInNewTab() {
  return window.matchMedia("(pointer: fine)").matches;
}

/**
 * 把一个即将跳去终端页的 `<a>` 按当前设备设成新标签页或原地跳转。
 *
 * `rel="noopener noreferrer"` 只在真的开新标签页时才有意义——原地跳转没有
 * `window.opener` 这回事，留着空跑一次判断不会错，但没必要。
 *
 * @param {HTMLAnchorElement} link
 */
export function applyTerminalLinkTarget(link) {
  if (!opensInNewTab()) return;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
}
