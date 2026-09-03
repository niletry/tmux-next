import { WEB_SESSION_PREFIX } from "./tmux/session-manager";
import { MAX_TEXT } from "./tmux/send-text";

/**
 * 模板渲染。纯函数，不碰磁盘、不认识任何一个具体字段。
 *
 * 字段表是**平的**：内核的键占 `item.*`，插件的键由插件自己命名（collectFields 挡住
 * 了它们冒充 `item.*`）。这里不区分谁产的——跟 Facet.dim 同源的设计。
 */

/**
 * 渲染结果的上限，从 src/tmux/send-text.ts 的 MAX_TEXT 推导而不是各写各的字面量：
 * §3 的"所见即所发"要求创建页里那份预览就是最终敲进 pane 的那份，两个常量分开写
 * 迟早会飘，而 `sendText` 才是真正决定"能敲多少"的那一边，所以它是源头。
 */
export const MAX_RENDERED = MAX_TEXT;

/** 会话名的上限。tmux 本身不限，但更长的名字在手机上一行放不下。 */
const MAX_NAME_LEN = 64;

/**
 * 占位符语法认得的键名字符集，plugins/handlers.ts 的 FIELD_KEY 引用这份而不是
 * 自己重写一条一样的正则——两处必须相等，`collectFields` 才不会悄悄丢掉一个
 * 语法上合法、却被自己那份正则拒收的插件字段。
 */
export const FIELD_KEY_CHARS = "A-Za-z0-9._-";

const PLACEHOLDER = new RegExp(`\\{([${FIELD_KEY_CHARS}]+)\\}`, "g");

/**
 * 一行里的占位符**全部**渲染成空时，整行删掉；没有占位符的行永远保留。
 *
 * 规则是按行全有全无，不是"把剩下的标点清掉"：要判断"剩下的算不算半句话"就得让内核去
 * 理解标点和语言。想让某一行在缺字段时消失，就把它单独写成一行——这条规则一句话说得清，
 * 也测得住。
 *
 * 这条规则不区分单行多行，单行模板也算。单行恰恰是最常见的模板形状——一条模板往往就是
 * 一行"标题：{item.ref} {jira.summary}"——如果单行时不删，`史诗：{jira.epic}` 在没挂
 * 史诗的单上照样会渲染成"史诗："这半句话，规则要防的 bug 原样放回来。所以
 * `render("a{nope}b", {})` 的结果是空串，不是"ab"：这一整行只有一个占位符，且它渲染
 * 成了空，按规则整行就该消失。
 */
export function render(template: string, fields: Record<string, string>): string {
  const lines: string[] = [];
  for (const line of template.split("\n")) {
    let seen = 0;
    let filled = 0;
    const out = line.replace(PLACEHOLDER, (_match, key: string) => {
      seen++;
      const value = fields[key] ?? "";
      if (value) filled++;
      return value;
    });
    if (seen > 0 && filled === 0) continue;
    lines.push(out);
  }
  // 截断发生在这里而不是发送时：创建页框里那段文字必须就是最终会敲进去的那段，
  // 否则预览会撒谎。
  return lines.join("\n").slice(0, MAX_RENDERED);
}

/**
 * 渲染结果 → 一个能当会话名用的字符串，用不了就是 null（等于"没提供名字"，
 * 服务端按目录生成，跟今天的默认路径一致）。
 *
 * **必须在服务端做。** `.` 和 `:` 是 tmux 的 `session:window.pane` 分隔符：带上它们
 * 建出来的会话之后每一次 `-t` 查找都会失败，连 kill 都 kill 不掉（见
 * src/tmux/session-create.ts 的 UNTARGETABLE）。`web-` 是本应用挂载会话的保留前缀。
 * 两件事都是服务端的事实，浏览器不该复述。
 */
export function sanitiseName(raw: string): string | null {
  const name = raw
    .trim()
    .replace(/[.:]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_NAME_LEN)
    .replace(/-+$/, "");
  if (!name) return null;
  if (name.startsWith(WEB_SESSION_PREFIX)) return null;
  return name;
}
