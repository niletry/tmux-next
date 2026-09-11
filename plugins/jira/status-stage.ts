/**
 * Jira 状态名 → 流程里第几步的六档归类。
 *
 * 这个函数只负责"这个状态名排在流程的第几步"——具体画成几颗点、走到的点上什么
 * 颜色，是 public/item-card.js 的 statusLightRow 的事：那边把 stageRank 的结果
 * 当成"6 步走到第几步"，走过的绿、没走到的灰，不再关心这里的 hue/filled 字段。
 * 这两个字段仍然留着，是因为 stageRank 靠"跟 ORDER 里哪一档相等"找位置，换成
 * 别的判等方式对这段代码不值得。
 *
 * 六档：todo/backlog、in progress、ready for acceptance、accepted、
 * ready for release、done——从头到尾就是"越往后越接近完成"这一条线索。
 *
 * 纯关键词匹配，不认识的状态名兜底成"todo"的样子——没匹配上不代表状态不存在，
 * 只是不知道它在流程里的位置，比抛错或不画更诚实。
 */

export type StatusStage = { hue: "dim" | "accent" | "ok"; filled: boolean };

const RULES: [RegExp, StatusStage][] = [
  [/\bdone\b|\bclosed\b|\breleased\b/, { hue: "ok", filled: true }],
  [/ready\s+for\s+release/, { hue: "ok", filled: false }],
  [/\baccepted\b/, { hue: "accent", filled: true }],
  [/ready\s+for\s+acceptance/, { hue: "accent", filled: false }],
  [/in\s*progress|\breview\b/, { hue: "dim", filled: true }],
];

const FALLBACK: StatusStage = { hue: "dim", filled: false };

export function classifyStatusStage(statusName: string): StatusStage {
  const name = statusName.toLowerCase();
  for (const [pattern, stage] of RULES) {
    if (pattern.test(name)) return stage;
  }
  return FALLBACK;
}

/**
 * 排序用的数字序：跟灯带上从灰空心到绿实心的视觉顺序完全一致，0 是 todo，
 * 5 是 done。给排序下拉用——列表按「状态」排序时比的就是这个数字。
 */
const ORDER: StatusStage[] = [
  { hue: "dim", filled: false },
  { hue: "dim", filled: true },
  { hue: "accent", filled: false },
  { hue: "accent", filled: true },
  { hue: "ok", filled: false },
  { hue: "ok", filled: true },
];

export function stageRank(stage: StatusStage): number {
  return ORDER.findIndex((s) => s.hue === stage.hue && s.filled === stage.filled);
}

/**
 * 灯带要画几颗点——固定 6 步（跟 ORDER 的长度锁死，不能悄悄漂开）。灯带自己
 * 不再认 dim/accent/ok 三种色相：走到的一律绿，没走到的一律灰，两种颜色的
 * 阶梯比"记住六种空心/实心配色"更容易一眼看懂。
 */
export const STAGE_COUNT = ORDER.length;
