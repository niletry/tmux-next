// @ts-check
/**
 * Jira 工单插件的清单。纯数据——服务端在 plugins/jira/server.ts。
 *
 * 浏览器会 import 这个文件（i18n.js 合并字典、nav.js 画 tab），所以这里不能引
 * 任何 .ts。
 */

/** @type {import("../types").Plugin} */
export default {
  id: "jira",
  titleKey: "jira.title",
  icon:
    '<path d="M4 7a2 2 0 0 1 2-2h6l8 8-7 7-8-8V7z"/>' +
    '<circle cx="8.5" cy="9.5" r="1.5"/>',
  // 页面外壳由内核生成，见 plugins/types.ts 的 page。
  page: { mainId: "issues" },
  // 认领 source.provider === "jira" 的单：内核据此知道该找谁做同步/单条刷新，
  // 不用维护一张 provider→插件名的表。
  provides: ["jira"],
  // 单卡片上的维度 chips：内核没有"哪个插件有哪些维度"的表，dim 就是 i18n 键，
  // 跟着数据一起来。src/i18n.test.ts 单独认这个数组字面量，只把这几个键当成
  // 有真实使用点（跟 titleKey 一样，它也不长成 t()/tr()/data-i18n 的样子）。
  facetDims: ["jira.type", "jira.status", "jira.epic", "jira.prs", "jira.checks", "jira.assignee"],
  // 模板可以引用的字段。设置页照着这个列"可用字段"给模板作者点选。
  // 跟 facetDims 不同：**这些不是 i18n 键**，原样显示、不翻译——模板作者要打的就是这串字。
  // src/i18n.test.ts 只扫 titleKey: 和 facetDims: 两个字面量，不会把这里的值当成待翻译的键。
  fieldKeys: [
    "jira.summary",
    "jira.status",
    "jira.type",
    "jira.epic",
    "jira.assignee",
    "jira.description",
  ],
  // 设置页照着这个画表单。内核不知道这些字段是什么意思，也不该知道——它只认
  // type（怎么画、密钥要不要藏）和 labelKey（叫什么）。值的存取归 server.ts。
  //
  // token 和 appPassword 是 secret：读回来只有"设没设过"一个比特，留空表示不改。
  // 这不是修饰，是这个服务没有认证决定的——配置一个 token 不需要看见它。
  settings: [
    { key: "url", type: "url", labelKey: "jira.cfg.url", hintKey: "jira.cfg.urlHint", required: true },
    { key: "email", type: "text", labelKey: "jira.cfg.email", required: true },
    { key: "token", type: "secret", labelKey: "jira.cfg.token", hintKey: "jira.cfg.tokenHint", required: true },
    { key: "jql", type: "text", labelKey: "jira.cfg.jql", hintKey: "jira.cfg.jqlHint" },
    { key: "onlyKeyedPrs", type: "boolean", labelKey: "jira.cfg.onlyKeyedPrs", hintKey: "jira.cfg.onlyKeyedPrsHint" },
    { key: "bitbucket.email", type: "text", labelKey: "jira.cfg.bbEmail", hintKey: "jira.cfg.bbHint" },
    { key: "bitbucket.appPassword", type: "secret", labelKey: "jira.cfg.bbPassword" },
  ],
  i18n: {
    zh: {
      "jira.title": "工单",
      "jira.count": "{n} 个",
      "jira.empty": "没有分给你的单",
      "jira.unconfigured": "还没配置 Jira",
      "jira.unconfiguredHint": "到设置页里填 URL、邮箱和 API token",
      "jira.cfg.url": "Jira 地址",
      "jira.cfg.urlHint": "例如 https://example.atlassian.net",
      "jira.cfg.email": "邮箱",
      "jira.cfg.token": "API token",
      "jira.cfg.tokenHint": "只写不读：留空表示保持不变",
      "jira.cfg.jql": "JQL",
      "jira.cfg.jqlHint": "留空用默认：分给我的、还没做完的",
      "jira.cfg.onlyKeyedPrs": "只保留带本单单号的 PR",
      "jira.cfg.onlyKeyedPrsHint": "Jira 的关联很松，提交信息里提过别的单号就会挂过来",
      "jira.cfg.bbEmail": "Bitbucket 邮箱",
      "jira.cfg.bbHint": "选填。不填就只列 PR，不问构建状态",
      "jira.cfg.bbPassword": "Bitbucket 应用密码",
      "jira.authFailed": "凭据无效，请检查邮箱与 API token",
      "jira.queryFailed": "查询有误，请检查 config.json 里的 jql",
      "jira.unreachable": "连不上 Jira",
      "jira.refresh": "刷新",
      "jira.filterEpic": "史诗",
      "jira.filterStatus": "状态",
      "jira.noneMatch": "没有符合筛选的单",
      "jira.refreshOne": "刷新这个单的 PR 与构建",
      "jira.ciNone": "无检查",
      "jira.checksTitle": "构建检查",
      "jira.close": "关闭",
      "jira.askedTitle": "它在等你回答",
      "jira.loadingAsk": "读取中…",
      "jira.askedNone": "没读到它最后说的话",
      "jira.replyPlaceholder": "回一句…",
      "jira.send": "发送",
      "jira.sending": "发送中…",
      "jira.sendFailed": "发送失败，会话可能已经结束",
      "jira.prHidden": "另有 {n} 条 PR 未带本单号，已隐藏",
      "jira.newSession": "再开一个会话",
      "jira.firstSession": "开一个会话",
      "jira.dead": "已停止",
      "jira.unbind": "解除绑定",
      "jira.open": "进入",
      "jira.type": "类型",
      "jira.status": "状态",
      "jira.epic": "史诗",
      "jira.prs": "PR",
      "jira.checks": "检查",
      "jira.assignee": "负责人",
    },
    en: {
      "jira.title": "Issues",
      "jira.count": "{n}",
      "jira.empty": "No issues assigned to you",
      "jira.unconfigured": "Jira is not configured",
      "jira.unconfiguredHint": "Fill in the URL, e-mail and API token on the settings page",
      "jira.cfg.url": "Jira URL",
      "jira.cfg.urlHint": "e.g. https://example.atlassian.net",
      "jira.cfg.email": "E-mail",
      "jira.cfg.token": "API token",
      "jira.cfg.tokenHint": "Write-only: leave empty to keep the current one",
      "jira.cfg.jql": "JQL",
      "jira.cfg.jqlHint": "Empty uses the default: assigned to me, not done",
      "jira.cfg.onlyKeyedPrs": "Only PRs carrying this issue's key",
      "jira.cfg.onlyKeyedPrsHint": "Jira links loosely — a commit message mentioning another key pulls that PR in",
      "jira.cfg.bbEmail": "Bitbucket e-mail",
      "jira.cfg.bbHint": "Optional. Without it, PRs are listed but build status is not fetched",
      "jira.cfg.bbPassword": "Bitbucket app password",
      "jira.authFailed": "Invalid credentials — check the e-mail and API token",
      "jira.queryFailed": "Bad query — check `jql` in config.json",
      "jira.unreachable": "Cannot reach Jira",
      "jira.refresh": "Refresh",
      "jira.filterEpic": "Epic",
      "jira.filterStatus": "Status",
      "jira.noneMatch": "No issues match the filter",
      "jira.refreshOne": "Refresh this issue's PRs and builds",
      "jira.ciNone": "no checks",
      "jira.checksTitle": "Checks",
      "jira.close": "Close",
      "jira.askedTitle": "Waiting on you",
      "jira.loadingAsk": "Reading…",
      "jira.askedNone": "Could not read what it last said",
      "jira.replyPlaceholder": "Reply…",
      "jira.send": "Send",
      "jira.sending": "Sending…",
      "jira.sendFailed": "Could not send — the session may have ended",
      "jira.prHidden": "{n} more PR(s) hidden — no issue key on the branch or title",
      "jira.newSession": "New session",
      "jira.firstSession": "Start a session",
      "jira.dead": "Stopped",
      "jira.unbind": "Unbind",
      "jira.open": "Open",
      "jira.type": "Type",
      "jira.status": "Status",
      "jira.epic": "Epic",
      "jira.prs": "PRs",
      "jira.checks": "Checks",
      "jira.assignee": "Assignee",
    },
  },
};
