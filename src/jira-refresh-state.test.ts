import { test, expect } from "bun:test";
import { refreshState } from "../plugins/jira/public/refresh-state.js";

/**
 * 刷新按钮的外观必须是**推导**出来的。
 *
 * 曾经它是点击时挂到 DOM 节点上的 class，于是每一次整体重画都会连节点带状态一起
 * 丢掉——表现就是"转了一下就没了，过一会儿才变"。只要外观由下面这个函数在每次渲染
 * 时算出来，重画就没有可丢的东西了。
 */

const S = (...ids: string[]) => new Set(ids);

test("闲置时既不转也不报错，且可以点", () => {
  const s = refreshState("1", S(), S());
  expect(s.className).toBe("jira-again");
  expect(s.disabled).toBe(false);
});

test("正在刷新的单：转动并禁用自己", () => {
  const s = refreshState("1", S("1"), S());
  expect(s.className).toContain("spin");
  expect(s.disabled).toBe(true);
});

test("失败过的单：留下可见的错误态，但仍然可以再点", () => {
  // 静默失败跟"刷了但没变化"长得一模一样，那正是最初被抱怨的体感。
  const s = refreshState("1", S(), S("1"));
  expect(s.className).toContain("err");
  expect(s.disabled).toBe(false);
});

test("重新开始刷新时不再显示上次的失败", () => {
  // 一次新的尝试正在进行，上一次的结果已经不是当前状态了。
  const s = refreshState("1", S("1"), S("1"));
  expect(s.className).toContain("spin");
  expect(s.className).not.toContain("err");
});

test("状态只认自己那个单，不会串到别的卡片上", () => {
  expect(refreshState("2", S("1"), S("3")).className).toBe("jira-again");
});
