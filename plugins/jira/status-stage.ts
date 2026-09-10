/**
 * Jira 状态名 → 状态灯的六档归类。
 *
 * 只用三种已有色相（dim/accent/ok——跟 Facet.tone 是同一套，卡片上早就在用这
 * 三个 CSS 角色令牌）叠加空心/实心两级，凑出六个视觉上能分辨的阶段，不往主题
 * 系统里加任何新颜色：todo/backlog → 灰空心，in progress → 灰实心，ready for
 * acceptance → 强调色空心，accepted → 强调色实心，ready for release → 绿空心，
 * done → 绿实心。颜色从灰到绿的走向本身就是"越往后越接近完成"的视觉线索。
 *
 * 纯关键词匹配，不认识的状态名兜底成"todo"的样子（灰空心）——没匹配上不代表
 * 状态不存在，只是不知道它在流程里的位置，比抛错或不画更诚实。
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
