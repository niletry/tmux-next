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
