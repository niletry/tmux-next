// @ts-check
/**
 * 通知历史的清单。
 *
 * 注意这个插件**不拥有**那份日志：~/.tmux-next/notifications.jsonl 是推送管线
 * （/api/notify → src/push.ts）写的，插件只读。所以 src/notifications.ts 留在
 * 内核——否则内核要反向依赖插件才能记一条日志，接缝就白划了。
 *
 * 结果是：这个插件被禁用时推送照常工作，只是网页上翻不到历史。
 */

/** @type {import("../types").Plugin} */
export default {
  id: "notifications",
  titleKey: "notif.title",
  icon:
    '<path d="M22 12h-6l-2 3h-4l-2-3H2"/>' +
    '<path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  i18n: {
    zh: {
      "notif.title": "通知历史",
      "notif.loadFailed": "加载失败",
      "notif.count": "{n} 条",
      "notif.empty": "还没有通知",
    },
    en: {
      "notif.title": "Notification history",
      "notif.loadFailed": "Could not load",
      "notif.count": "{n}",
      "notif.empty": "No notifications yet",
    },
  },
};
