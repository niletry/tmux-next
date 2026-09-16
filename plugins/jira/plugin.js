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
  // 这个插件没有页面：单在首页，它只是首页的一个数据源。
  // 单卡片上的维度 chips：内核没有"哪个插件有哪些维度"的表，dim 就是 i18n 键，
  // 跟着数据一起来。src/i18n.test.ts 单独认这个数组字面量，只把这几个键当成
  // 有真实使用点（跟 titleKey 一样，它也不长成 t()/tr()/data-i18n 的样子）。
  facetDims: [
    "jira.type",
    "jira.created",
    "jira.status",
    "jira.epic",
    "jira.prs",
    "jira.checks",
    "jira.assignee",
  ],
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
    {
      key: "transition.inProgress",
      type: "text",
      labelKey: "jira.cfg.transitionInProgress",
      hintKey: "jira.cfg.transitionHint",
    },
    {
      key: "transition.inReview",
      type: "text",
      labelKey: "jira.cfg.transitionInReview",
      hintKey: "jira.cfg.transitionHint",
    },
    {
      key: "transition.inMerge",
      type: "text",
      labelKey: "jira.cfg.transitionInMerge",
      hintKey: "jira.cfg.transitionHint",
    },
    {
      key: "transition.done",
      type: "text",
      labelKey: "jira.cfg.transitionDone",
      hintKey: "jira.cfg.transitionHint",
    },
  ],
  // 设置页 Save 旁边的按钮。内核不知道「完整同步」是什么意思——只知道按了要
  // POST 到 /api/plugins/jira/actions/full-sync，回来一个布尔。
  actions: [{ key: "full-sync", labelKey: "jira.fullSync", doneKey: "jira.fullSyncDone" }],
  i18n: {
    zh: {
      "jira.cfg.url": "Jira 地址",
      "jira.cfg.urlHint": "例如 https://example.atlassian.net",
      "jira.cfg.email": "邮箱",
      "jira.cfg.token": "API token",
      "jira.cfg.tokenHint": "只写不读：留空表示保持不变",
      "jira.cfg.jql": "JQL",
      "jira.cfg.jqlHint": "留空用默认：分给我的、还没做完的",
      "jira.fullSync": "完整同步",
      "jira.fullSyncDone": "已完整同步一次",
      "jira.cfg.onlyKeyedPrs": "只保留带本单单号的 PR",
      "jira.cfg.onlyKeyedPrsHint": "Jira 的关联很松，提交信息里提过别的单号就会挂过来",
      "jira.cfg.transitionInProgress": "「进行中」对应的 Jira 状态",
      "jira.cfg.transitionInReview": "「待审查」对应的 Jira 状态",
      "jira.cfg.transitionInMerge": "「待合并」对应的 Jira 状态",
      "jira.cfg.transitionDone": "「已完成」对应的 Jira 状态",
      "jira.cfg.transitionHint": "留空表示这一步不写回 Jira",
      "jira.cfg.bbEmail": "Bitbucket 邮箱",
      "jira.cfg.bbHint": "选填。不填就只列 PR，不问构建状态",
      "jira.cfg.bbPassword": "Bitbucket 应用密码",
      "jira.type": "类型",
      "jira.created": "创建于",
      "jira.status": "状态",
      "jira.epic": "史诗",
      "jira.prs": "PR",
      "jira.checks": "检查",
      "jira.assignee": "负责人",
    },
    en: {
      "jira.cfg.url": "Jira URL",
      "jira.cfg.urlHint": "e.g. https://example.atlassian.net",
      "jira.cfg.email": "E-mail",
      "jira.cfg.token": "API token",
      "jira.cfg.tokenHint": "Write-only: leave empty to keep the current one",
      "jira.cfg.jql": "JQL",
      "jira.cfg.jqlHint": "Empty uses the default: assigned to me, not done",
      "jira.fullSync": "Full sync",
      "jira.fullSyncDone": "Full sync finished",
      "jira.cfg.onlyKeyedPrs": "Only PRs carrying this issue's key",
      "jira.cfg.onlyKeyedPrsHint": "Jira links loosely — a commit message mentioning another key pulls that PR in",
      "jira.cfg.transitionInProgress": "Jira status for “In progress”",
      "jira.cfg.transitionInReview": "Jira status for “In review”",
      "jira.cfg.transitionInMerge": "Jira status for “Ready to merge”",
      "jira.cfg.transitionDone": "Jira status for “Done”",
      "jira.cfg.transitionHint": "Leave blank to skip writing this step back to Jira",
      "jira.cfg.bbEmail": "Bitbucket e-mail",
      "jira.cfg.bbHint": "Optional. Without it, PRs are listed but build status is not fetched",
      "jira.cfg.bbPassword": "Bitbucket app password",
      "jira.type": "Type",
      "jira.created": "Created",
      "jira.status": "Status",
      "jira.epic": "Epic",
      "jira.prs": "PRs",
      "jira.checks": "Checks",
      "jira.assignee": "Assignee",
    },
  },
};
