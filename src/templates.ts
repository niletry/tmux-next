import { homedir } from "node:os";
import { join } from "node:path";
import { readJson, writeJsonAtomic, serialized } from "./json-store";

/**
 * 会话模板：从一张单开会话时，会话名和首条输入长什么样。
 *
 * 一份**全局**清单，不按来源分组：所有模板对所有单可选，取不到的字段渲染成空。分组要求
 * 用户在建模板时就想清楚它适用于哪种单，而那个判断在选它的那一刻做才是自然的。
 *
 * 空清单 = 这个特性不存在：创建页不画选择器，也不多发一次请求。所以不预置任何默认模板。
 */

export type SessionTemplate = {
  id: string;
  /** 选择器上显示的名字。没有它就没法在清单里认出这一条，所以是唯一的必填项。 */
  label: string;
  /** 会话名模板。渲染后还要过 sanitiseName——净化是服务端的事。 */
  name: string;
  /** 首条输入模板，可多行、可为空。 */
  input: string;
};

export const MAX_TEMPLATES = 50;
export const MAX_LABEL = 60;
export const MAX_NAME = 200;
export const MAX_INPUT = 4000;

/** 路径在函数里现读，不在模块加载时捕获——测试要能先设 env 再调用。 */
export function templatesPath(): string {
  return process.env.TMUX_NEXT_TEMPLATES_PATH || join(homedir(), ".tmux-next", "templates.json");
}

/** `tpl-` + 时间 + 随机，跟 items.ts 的 id 同一种生成法。 */
function newId(): string {
  return `tpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * 任意输入 → 一份能存的模板表。全函数：坏文件、坏记录一律丢掉，绝不抛。
 *
 * 读和写共用同一份净化：写进去的和读出来的必须是同一种东西，否则"存了看不到"这种 bug
 * 会挑在最难查的时候出现。
 */
function sanitise(raw: unknown): SessionTemplate[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionTemplate[] = [];
  for (const value of raw.slice(0, MAX_TEMPLATES)) {
    const v = value as Record<string, unknown>;
    const label = text(v?.label, MAX_LABEL).trim();
    if (!label) continue; // 认不出的一条，留着只会在选择器上显示成一格空白
    out.push({
      id: typeof v?.id === "string" && v.id ? v.id : newId(),
      label,
      name: text(v?.name, MAX_NAME),
      input: text(v?.input, MAX_INPUT),
    });
  }
  return out;
}

export async function readTemplates(): Promise<SessionTemplate[]> {
  return readJson<SessionTemplate[]>(templatesPath(), [], sanitise);
}

/**
 * 整份替换。设置页就是一个编辑器，而逐条 CRUD 是为多写者准备的——这里只有一个人和
 * 一台机器。返回真正写进去的那份，调用方据此更新界面，不必自己猜净化的结果。
 */
export async function writeTemplates(raw: unknown): Promise<SessionTemplate[]> {
  const clean = sanitise(raw);
  await serialized(async () => {
    await writeJsonAtomic(templatesPath(), clean);
  });
  return clean;
}
