// @ts-check
/**
 * Interface strings, in both languages.
 *
 * Data and one pure function, no DOM — so the test suite can load this directly
 * and check it, which is the entire point. The browser files it serves are not
 * type-checked, so a mistyped key raises nothing there; the check has to happen
 * here instead. See src/i18n.test.ts.
 *
 * Keys are dotted and grouped by where they appear. Both dictionaries must
 * define exactly the same set — a key present in one and missing from the other
 * is invisible to whoever speaks the other language.
 */

/** @typedef {Record<string, string>} Dict */

/** @type {Dict} */
const zh = {
  "list.title": "tmux 会话",
  "list.loading": "加载中…",
  "list.artifacts": "制品",
  "list.notifyHistory": "通知历史",
  "list.notifyToggle": "开启/关闭通知",
  "list.settings": "设置",
  "list.newSession": "新建会话",
  "list.noSessions": "没有 tmux 会话",
  "list.endFailedCode": "失败: {code}",
  "list.count": "{n} 个",
  "list.offline": "无法连接到服务",
  "list.restorable": "{n} 个上次的会话可恢复",
  "list.restore": "恢复",
  "list.restoring": "恢复中…",
  "list.pin": "置顶",
  "list.unpin": "取消置顶",
  "list.pinned": "已置顶",
  "list.endSession": "结束会话",
  "list.endWarn": "里面正在运行的进程会被杀掉，未保存的内容会丢失。",
  "list.ending": "正在结束…",
  "list.endFailed": "失败，请重试",
  "list.cancel": "取消",
  "list.actionsFor": "{name} 的操作",
  "list.waitingDot": "等待你的回复",
  "list.pendingInput": "待发送",
  "list.justNow": "刚刚",
  "list.minutesAgo": "{n} 分钟前",
  "list.hoursAgo": "{n} 小时前",
  "list.daysAgo": "{n} 天前",

  "settings.title": "设置",
  "settings.language": "语言",
  "settings.theme": "配色",
  "settings.note": "语言和配色对所有设备生效；字号在终端页单独调。",
  "settings.saveFailed": "已应用，但没能保存到这台机器",
  "common.close": "关闭",
};

/** @type {Dict} */
const en = {
  "list.title": "tmux sessions",
  "list.loading": "Loading…",
  "list.artifacts": "Artifacts",
  "list.notifyHistory": "Notification history",
  "list.notifyToggle": "Turn notifications on/off",
  "list.settings": "Settings",
  "list.newSession": "New session",
  "list.noSessions": "No tmux sessions",
  "list.endFailedCode": "Failed: {code}",
  "list.count": "{n}",
  "list.offline": "Cannot reach the service",
  "list.restorable": "{n} session(s) can be restored",
  "list.restore": "Restore",
  "list.restoring": "Restoring…",
  "list.pin": "Pin to top",
  "list.unpin": "Unpin",
  "list.pinned": "Pinned",
  "list.endSession": "End session",
  "list.endWarn": "Everything running inside will be killed and unsaved work lost.",
  "list.ending": "Ending…",
  "list.endFailed": "Failed, try again",
  "list.cancel": "Cancel",
  "list.actionsFor": "Actions for {name}",
  "list.waitingDot": "Waiting for your reply",
  "list.pendingInput": "unsent",
  "list.justNow": "just now",
  "list.minutesAgo": "{n} min ago",
  "list.hoursAgo": "{n} hr ago",
  "list.daysAgo": "{n} d ago",

  "settings.title": "Settings",
  "settings.language": "Language",
  "settings.theme": "Theme",
  "settings.note": "Language and theme apply to every device; font size is set per screen on the terminal page.",
  "settings.saveFailed": "Applied, but could not be saved to this machine",
  "common.close": "Close",
};

/** @type {Record<string, Dict>} */
export const DICTS = { zh, en };

/** Display order in the picker. */
export const LANGS = ["zh", "en"];

/** Labels for the picker itself, always shown in their own language. */
export const LANG_LABELS = { zh: "中文", en: "English" };

/**
 * English, not Chinese.
 *
 * Whatever the author uses, someone arriving from npm has read an English
 * README and an English package page. A first screen they cannot read is worse
 * than one the author has to switch once.
 */
export const DEFAULT_LANG = "en";

/**
 * A string in the given language.
 *
 * Falls back to the key itself rather than to empty: a blank label hides the
 * mistake, whereas `list.titel` on screen names it.
 *
 * @param {string} key
 * @param {string} lang
 * @param {Record<string, string | number>} [vars]
 * @returns {string}
 */
export function t(key, lang, vars) {
  const dict = DICTS[lang] || DICTS[DEFAULT_LANG];
  const template = (dict && dict[key]) || key;
  if (!vars) return template;
  // Named placeholders rather than positional: the two languages put counts and
  // names in different places, and a positional scheme would silently swap them.
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/**
 * The best language for an Accept-Language header.
 *
 * Only the primary subtag is compared, so `zh-Hant-TW` and `zh-CN` both mean
 * Chinese. Quality values are ignored beyond ordering — browsers already send
 * them in preference order, and honouring q properly would be more machinery
 * than this decision deserves.
 *
 * @param {string | undefined} header
 * @returns {string}
 */
export function pickLang(header) {
  if (!header) return DEFAULT_LANG;
  for (const part of header.split(",")) {
    const tag = part.split(";")[0].trim().toLowerCase();
    const primary = tag.split("-")[0];
    if (primary && LANGS.includes(primary)) return primary;
  }
  return DEFAULT_LANG;
}
