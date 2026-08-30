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
  i18n: {
    zh: {
      "jira.title": "工单",
      "jira.count": "{n} 个",
      "jira.loading": "加载中…",
      "jira.empty": "没有分给你的单",
      "jira.unconfigured": "还没配置 Jira",
      "jira.unconfiguredHint": "把 URL、邮箱、API token 写进 ~/.tmux-next/jira/config.json（权限 0600）",
      "jira.authFailed": "凭据无效，请检查邮箱与 API token",
      "jira.queryFailed": "查询有误，请检查 config.json 里的 jql",
      "jira.unreachable": "连不上 Jira",
      "jira.refresh": "刷新",
      "jira.newSession": "再开一个会话",
      "jira.firstSession": "开一个会话",
      "jira.sessions": "{n} 个会话",
      "jira.noSessions": "还没有会话",
      "jira.dead": "已停止",
      "jira.unbind": "解除绑定",
      "jira.open": "进入",
      "jira.createFailed": "创建失败",
      "jira.nameTaken": "名字已被占用，换一个",
    },
    en: {
      "jira.title": "Issues",
      "jira.count": "{n}",
      "jira.loading": "Loading…",
      "jira.empty": "No issues assigned to you",
      "jira.unconfigured": "Jira is not configured",
      "jira.unconfiguredHint": "Put the URL, e-mail and API token in ~/.tmux-next/jira/config.json (mode 0600)",
      "jira.authFailed": "Invalid credentials — check the e-mail and API token",
      "jira.queryFailed": "Bad query — check `jql` in config.json",
      "jira.unreachable": "Cannot reach Jira",
      "jira.refresh": "Refresh",
      "jira.newSession": "New session",
      "jira.firstSession": "Start a session",
      "jira.sessions": "{n} sessions",
      "jira.noSessions": "No sessions yet",
      "jira.dead": "Stopped",
      "jira.unbind": "Unbind",
      "jira.open": "Open",
      "jira.createFailed": "Could not create",
      "jira.nameTaken": "That name is taken — pick another",
    },
  },
};
