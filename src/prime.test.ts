import { test, expect } from "bun:test";
import { waitForReady } from "./tmux/prime";

const MARKER = /^\s*(?:>|❯)\s*$/;
// 注入的 sleep：这几条测试要证的是轮询逻辑，跟真的等多久无关。
const noSleep = async () => {};

test("一上来就就绪，问一次就返回", async () => {
  let calls = 0;
  const capture = async () => {
    calls++;
    return "some output\n❯ ";
  };
  expect(await waitForReady(capture, MARKER, { sleep: noSleep })).toBe(true);
  expect(calls).toBe(1);
});

test("先没就绪、后就绪：会一直问到命中", async () => {
  let calls = 0;
  const capture = async () => {
    calls++;
    return calls < 3 ? "Installing…" : "❯ ";
  };
  expect(await waitForReady(capture, MARKER, { sleep: noSleep })).toBe(true);
  expect(calls).toBe(3);
});

// 超时是"放弃，不发"：那时候 agent 还没到能收输入的状态，敲进去的字会变成对某个
// 确认框的回答。
test("预算耗尽就放弃", async () => {
  const capture = async () => "还在装依赖…";
  expect(
    await waitForReady(capture, MARKER, { budgetMs: 1000, pollMs: 250, sleep: noSleep }),
  ).toBe(false);
});

test("预算耗尽前问的次数由 budget/poll 决定", async () => {
  let calls = 0;
  const capture = async () => {
    calls++;
    return "nope";
  };
  await waitForReady(capture, MARKER, { budgetMs: 1000, pollMs: 250, sleep: noSleep });
  expect(calls).toBe(4);
});

// capture 拿不到屏幕（会话已经没了）跟"还没就绪"是同一种处理：继续等，等到预算用完。
test("capture 返回 null 不当成就绪", async () => {
  const capture = async () => null;
  expect(
    await waitForReady(capture, MARKER, { budgetMs: 500, pollMs: 250, sleep: noSleep }),
  ).toBe(false);
});

// 弹着选择菜单的屏幕上没有空提示行，所以不会命中——"菜单亮着时绝不敲字"是免费成立的。
test("菜单屏幕不算就绪", async () => {
  const capture = async () => "  5. Chat about this\n\nEnter to select · ↑/↓ to navigate";
  expect(
    await waitForReady(capture, MARKER, { budgetMs: 500, pollMs: 250, sleep: noSleep }),
  ).toBe(false);
});
