// @ts-check
/**
 * 单个工单刷新按钮的外观，从状态推导出来。
 *
 * 这个模块存在的理由是一个真实的缺陷：这些 class 曾经是点击时用 `classList.add`
 * 挂到按钮节点上的，而 `renderIssues()` 是整体 `replaceChildren`——任何一次重画
 * （最常见的是慢十几秒的全量加载终于回来了）都会把正在转的那个按钮连同它的状态
 * 一起销毁重建，看起来就是"转了一下就没了，过一会儿才变"。
 *
 * 把状态存进模块变量、渲染时由这里推导，重画就不再能丢掉它——不是因为渲染代码
 * 小心，而是因为它没有别的地方可丢。
 */

/**
 * @param {string} id 工单的 Jira 内部 id
 * @param {Set<string>} refreshing 正在刷新的
 * @param {Set<string>} failed 上次刷新失败的
 * @returns {{ className: string, disabled: boolean, busy: boolean, failed: boolean }}
 */
export function refreshState(id, refreshing, failed) {
  const busy = refreshing.has(id);
  // 正在转的时候不显示失败：一次新的尝试正在进行，上一次的结果已经不是当前状态了。
  const isFailed = !busy && failed.has(id);
  return {
    className: "jira-again" + (busy ? " spin" : isFailed ? " err" : ""),
    disabled: busy,
    busy,
    failed: isFailed,
  };
}
