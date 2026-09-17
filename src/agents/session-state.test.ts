import { test, expect } from "bun:test";
import { sessionState } from "./session-state";

/**
 * `turn` 优先、`idle` 兜底这条规则原本在三处各写一遍（工单 facet、sessions 列表页、
 * 以及现在要加的轮询循环）。抽出来之后这个文件是它唯一的说明书。
 *
 * 最后一条是真正要钉住的：`turn` 存在时 `idle` 的值必须被完全忽略。反过来写——
 * 「idle 为真就算在等」——在大多数会话上给出相同答案，只在一个刚跑起来、屏幕上还
 * 留着上一轮空闲标记的会话上说错，而那恰好是最需要说对的时刻。
 */
test("turn 为 waiting 时算在等你", () => {
  expect(sessionState({ turn: "waiting", idle: false })).toBe("waiting");
});

test("turn 为 working 时算在跑", () => {
  expect(sessionState({ turn: "working", idle: true })).toBe("working");
});

test("没有 turn 时退回屏幕上的 idle 标记", () => {
  expect(sessionState({ turn: null, idle: true })).toBe("waiting");
  expect(sessionState({ turn: null, idle: false })).toBe("working");
});

test("turn 存在时 idle 被完全忽略", () => {
  expect(sessionState({ turn: "working", idle: true })).toBe("working");
  expect(sessionState({ turn: "waiting", idle: false })).toBe("waiting");
});
