// @ts-check
/**
 * 监察者：一个自己去理解上下文、巡视同一 cwd 下其他 Claude Code 会话的 agent。
 * 检测/介入的判断全在首条提示词里（见 prompt.ts），这个插件只管创建入口、
 * 一人一岗的登记表，和只读的巡检记录页。
 */

/** @type {import("../types").Plugin} */
export default {
  id: "supervisor",
  titleKey: "supervisor.title",
  icon:
    '<circle cx="12" cy="12" r="3"/>' +
    '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>',
  page: { mainId: "list" },
  i18n: {
    zh: {
      "supervisor.title": "监察者",
      "supervisor.cwdPlaceholder": "要监控的目录",
      "supervisor.autoConfirmLabel": "允许自动确认权限提示",
      "supervisor.createButton": "创建监察者",
      "supervisor.createFailed_baddir": "目录无效",
      "supervisor.createFailed_exists": "该目录已有监察者",
      "supervisor.createFailed_failed": "创建失败",
      "supervisor.loadFailed": "加载失败",
      "supervisor.empty": "还没有监察者",
      "supervisor.logEmpty": "还没有巡检记录",
      "supervisor.autoConfirmOn": "自动确认权限：开",
      "supervisor.autoConfirmOff": "自动确认权限：关",
      "supervisor.actionAnswered": "已代答",
      "supervisor.actionNotified": "已上报",
      "supervisor.actionNoop": "无需处理",
    },
    en: {
      "supervisor.title": "Supervisor",
      "supervisor.cwdPlaceholder": "Directory to watch",
      "supervisor.autoConfirmLabel": "Allow auto-confirming permission prompts",
      "supervisor.createButton": "Create supervisor",
      "supervisor.createFailed_baddir": "Invalid directory",
      "supervisor.createFailed_exists": "This directory already has a supervisor",
      "supervisor.createFailed_failed": "Could not create",
      "supervisor.loadFailed": "Could not load",
      "supervisor.empty": "No supervisors yet",
      "supervisor.logEmpty": "No patrol entries yet",
      "supervisor.autoConfirmOn": "Auto-confirm permissions: on",
      "supervisor.autoConfirmOff": "Auto-confirm permissions: off",
      "supervisor.actionAnswered": "Answered",
      "supervisor.actionNotified": "Reported",
      "supervisor.actionNoop": "No action needed",
    },
  },
};
