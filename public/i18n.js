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

  "term.copied": "已复制",
  "term.copyNeedsHttps": "复制失败：需要 HTTPS",
  "term.copyFailedHttps": "复制失败（需 HTTPS）",
  "term.connecting": "连接中…",
  "term.connected": "已连接",
  "term.error": "错误: {message}",
  "term.reconnecting": "已断开，重连中…",
  "term.loginExpired": "登录已过期 · 点此重新登录",
  "term.end": "结束",
  "term.endConfirm": "确认结束?",
  "term.ending": "结束中…",
  "term.endFailed": "结束失败",
  "term.rename": "改名",
  "term.renaming": "重命名中…",
  "term.nameTaken": "名字已被占用",
  "term.nameInvalid": "名字不合法",
  "term.renameFailed": "重命名失败",
  "term.newName": "新的会话名",
  "term.cancel": "取消",
  "term.uploading": "上传中…",
  "term.imageTooBig": "图片过大",
  "term.imageBadType": "格式不支持",
  "term.uploadFailed": "上传失败",
  "term.pathInserted": "已插入路径",
  "term.clipboardEmpty": "剪贴板是空的",
  "term.pasteUnsupported": "此浏览器不支持粘贴",
  "term.pasteDenied": "粘贴被拒绝或失败",
  "term.screenEmpty": "屏幕是空的",
  "term.copyHint": "选中文字复制 · 点链接直接复制 · 点空白处关闭",
  "term.copiedTick": "已复制 ✓",
  "term.fontSize": "字号 {px}px",
  "term.fontSizeWrap": "字号 {px}px · {cols} 列，可能换行",

  "new.title": "新建会话",
  "new.filterDirs": "筛选目录",
  "new.namePlaceholder": "会话名（选填，如 PROJ-1088）",
  "new.agentMissing": "{label} 不在 PATH 上，无法启动",
  "new.skipPermissions": "跳过权限确认",
  "new.skipWarn": "Claude 将无需确认直接执行",
  "new.resumeEntry": "从历史恢复对话 →",
  "new.resumeEntryCount": "从历史恢复对话 ({n}) →",
  "new.backToHistory": "‹ 选一段历史对话",
  "new.cancel": "取消",
  "new.create": "创建",
  "new.creating": "创建中…",
  "new.resuming": "恢复中…",
  "new.offline": "无法连接到服务",
  "new.mkdirFailed": "创建目录失败",
  "new.makeHere": "在这里创建 {name}/",
  "new.noMatch": "没有匹配的目录",
  "new.noSubdirs": "没有子目录",
  "new.parentDir": "↑ 上级",
  "new.dirForbidden": "这个目录不让访问",
  "new.createFailed": "创建失败",
  "mkdir.empty": "名字不能为空",
  "mkdir.invalid": "名字里不能有 / 或 \\",
  "mkdir.hidden": "以 . 开头的目录不会显示在列表里",
  "mkdir.toolong": "名字太长了",
  "mkdir.exists": "这个目录已经存在",
  "mkdir.badparent": "上级目录不见了",
  "mkdir.failed": "创建失败，可能没有权限",
  "create.baddir": "这个目录用不了",
  "create.empty": "名字不能只有空格",
  "create.reserved": "这个名字是内部保留的",
  "create.invalid": "名字里不能有 . 或 :",
  "create.failed": "创建失败，请重试",

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

  "term.copied": "Copied",
  "term.copyNeedsHttps": "Copy failed: needs HTTPS",
  "term.copyFailedHttps": "Copy failed (needs HTTPS)",
  "term.connecting": "Connecting…",
  "term.connected": "Connected",
  "term.error": "Error: {message}",
  "term.reconnecting": "Disconnected, reconnecting…",
  "term.loginExpired": "Session expired · tap to sign in again",
  "term.end": "End",
  "term.endConfirm": "Tap again to end",
  "term.ending": "Ending…",
  "term.endFailed": "Could not end",
  "term.rename": "Rename",
  "term.renaming": "Renaming…",
  "term.nameTaken": "That name is taken",
  "term.nameInvalid": "Invalid name",
  "term.renameFailed": "Rename failed",
  "term.newName": "New session name",
  "term.cancel": "Cancel",
  "term.uploading": "Uploading…",
  "term.imageTooBig": "Image too large",
  "term.imageBadType": "Unsupported format",
  "term.uploadFailed": "Upload failed",
  "term.pathInserted": "Path inserted",
  "term.clipboardEmpty": "Clipboard is empty",
  "term.pasteUnsupported": "This browser cannot paste",
  "term.pasteDenied": "Paste denied or failed",
  "term.screenEmpty": "Screen is empty",
  "term.copyHint": "Select to copy · tap a link to copy it · tap outside to close",
  "term.copiedTick": "Copied ✓",
  "term.fontSize": "Font {px}px",
  "term.fontSizeWrap": "Font {px}px · {cols} columns, may wrap",

  "new.title": "New session",
  "new.filterDirs": "Filter directories",
  "new.namePlaceholder": "Session name (optional, e.g. PROJ-1088)",
  "new.agentMissing": "{label} is not on PATH and cannot start",
  "new.skipPermissions": "Skip permission prompts",
  "new.skipWarn": "Claude will act without asking",
  "new.resumeEntry": "Resume a past conversation →",
  "new.resumeEntryCount": "Resume a past conversation ({n}) →",
  "new.backToHistory": "‹ Pick a past conversation",
  "new.cancel": "Cancel",
  "new.create": "Create",
  "new.creating": "Creating…",
  "new.resuming": "Resuming…",
  "new.offline": "Cannot reach the service",
  "new.mkdirFailed": "Could not create the directory",
  "new.makeHere": "Create {name}/ here",
  "new.noMatch": "No matching directory",
  "new.noSubdirs": "No sub-directories",
  "new.parentDir": "↑ Up",
  "new.dirForbidden": "That directory is not readable",
  "new.createFailed": "Could not create the session",
  "mkdir.empty": "Name cannot be empty",
  "mkdir.invalid": "Name cannot contain / or \\",
  "mkdir.hidden": "Names starting with . are hidden from the list",
  "mkdir.toolong": "Name is too long",
  "mkdir.exists": "That directory already exists",
  "mkdir.badparent": "The parent directory is gone",
  "mkdir.failed": "Could not create it — check permissions",
  "create.baddir": "That directory cannot be used",
  "create.empty": "Name cannot be only spaces",
  "create.reserved": "That name is reserved internally",
  "create.invalid": "Name cannot contain . or :",
  "create.failed": "Could not create the session, try again",

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
