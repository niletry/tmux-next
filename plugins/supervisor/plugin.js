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
  // 新建会话页上的一种类型：选中它之后目录浏览器照旧，但"普通会话"才有意义的
  // agent 选择/跳过权限/恢复历史/模板选择器都会被那个页面隐藏，换成这里声明的
  // 唯一字段——是否允许自动确认权限提示。提交时新建会话页把 { kind: "supervisor",
  // dir, name, fields: { autoConfirmPermission } } POST 给
  // /api/supervisor/create-session，就是下面 handle() 里新增的那条路由。
  sessionKinds: [
    {
      key: "supervisor",
      labelKey: "supervisor.kind",
      hintKey: "supervisor.kindHint",
      fields: [{ key: "autoConfirmPermission", type: "boolean", labelKey: "supervisor.autoConfirmLabel" }],
    },
  ],
  i18n: {
    zh: {
      "supervisor.title": "监察者",
      "supervisor.kind": "监察者",
      "supervisor.kindHint": "巡视这个目录下的其他 Claude 会话，卡住时提醒你",
      "supervisor.autoConfirmLabel": "允许自动确认权限提示",
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
      "supervisor.kind": "Supervisor",
      "supervisor.kindHint": "Patrols the other Claude sessions in this directory and tells you when one is stuck",
      "supervisor.autoConfirmLabel": "Allow auto-confirming permission prompts",
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
