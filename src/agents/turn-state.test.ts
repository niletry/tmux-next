import { test, expect } from "bun:test";
import { turnFrom, turnStateFrom } from "./turn-state";

/**
 * 轮次状态的判定。
 *
 * 这个模块存在的理由是会话列表现在靠**认屏幕**判断"在等你"——那是启发式，agent 改
 * 一次 TUI 就可能失灵。`stop_reason` 是记录格式的一部分，改不掉。
 *
 * 下面这些形状取自开发机上真实的 transcript 尾部，包括那些不表示轮次归属、必须被
 * 忽略的记录类型。
 */

const line = (o: unknown) => JSON.stringify(o);
const assistant = (stop: string) => line({ type: "assistant", message: { stop_reason: stop } });
const user = () => line({ type: "user" });

test("一轮说完了就是在等你", () => {
  expect(turnStateFrom(assistant("end_turn"))).toBe("waiting");
});

test("还在调工具就是在跑", () => {
  expect(turnStateFrom(assistant("tool_use"))).toBe("working");
});

test("stop_sequence 也算一轮结束", () => {
  expect(turnStateFrom(assistant("stop_sequence"))).toBe("waiting");
});

test("你回过话之后就是在跑，哪怕上一条是 end_turn", () => {
  // 这是最要紧的一条：只看最后一个 assistant 会把"你刚发了新指令"读成"在等你"。
  expect(turnStateFrom([assistant("end_turn"), user()].join("\n"))).toBe("working");
});

test("工具回合里穿插的 user 记录不会把状态搅乱", () => {
  // 工具结果本身就是以 user 记录写进去的，所以中间会出现 user；最后仍是 end_turn
  // 的话，那一轮确实结束了。
  const chunk = [assistant("tool_use"), user(), assistant("end_turn")].join("\n");
  expect(turnStateFrom(chunk)).toBe("waiting");
});

test("不表示轮次归属的记录一律忽略", () => {
  // system / attachment，以及这个实例里真实出现过的 atis-latch、bridge-session。
  const chunk = [
    assistant("end_turn"),
    line({ type: "system" }),
    line({ type: "attachment" }),
    line({ type: "atis-latch" }),
    line({ type: "bridge-session" }),
  ].join("\n");
  expect(turnStateFrom(chunk)).toBe("waiting");
});

test("尾部读会从半行开始，残行跳过而不是当成失败", () => {
  const chunk = ['ge":{"stop_reason":"tool_use"}}', assistant("end_turn")].join("\n");
  expect(turnStateFrom(chunk)).toBe("waiting");
});

test("没有 stop_reason 的 assistant 不参与判断", () => {
  // 流式写入过程中会出现这种半成品记录。
  const chunk = [assistant("tool_use"), line({ type: "assistant", message: {} })].join("\n");
  expect(turnStateFrom(chunk)).toBe("working");
});

test("一条轮次记录都没有就是 null，由调用方退回屏幕判断", () => {
  expect(turnStateFrom("")).toBeNull();
  expect(turnStateFrom([line({ type: "system" }), "not json"].join("\n"))).toBeNull();
});

// ---- 它最后说的那段话 --------------------------------------------------------


const said = (stop: string, ...blocks: unknown[]) =>
  JSON.stringify({ type: "assistant", message: { stop_reason: stop, content: blocks } });
const text = (t: string) => ({ type: "text", text: t });
const thinking = (t: string) => ({ type: "thinking", thinking: t });

test("等你回答时，带回它最后说的那段话", () => {
  expect(turnFrom(said("end_turn", text("要我继续吗？"))).text).toBe("要我继续吗？");
});

test("thinking 块不算它对你说的话", () => {
  // 那是它自己想的，摆进"它问了你什么"的弹窗里既没用又容易误导。
  expect(turnFrom(said("end_turn", thinking("盘算一下"), text("选 A 还是 B？"))).text).toBe("选 A 还是 B？");
});

test("多个 text 块拼起来", () => {
  expect(turnFrom(said("end_turn", text("第一段"), text("第二段"))).text).toBe("第一段\n\n第二段");
});

test("在跑的时候没有待回答的话", () => {
  expect(turnFrom(said("tool_use", text("我去看看"))).text).toBeNull();
});

test("你回过话之后，它上一轮说的就不再是待回答的了", () => {
  // 只看最后一个 assistant 会把已经被回答过的问题又端出来。
  const chunk = [said("end_turn", text("要我继续吗？")), JSON.stringify({ type: "user" })].join("\n");
  expect(turnFrom(chunk)).toEqual({ state: "working", text: null });
});

test("只有 thinking 没有 text 时，状态仍在等你，但没有可展示的话", () => {
  expect(turnFrom(said("end_turn", thinking("嗯")))).toEqual({ state: "waiting", text: null });
});
