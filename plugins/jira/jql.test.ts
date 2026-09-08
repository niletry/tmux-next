import { test, expect } from "bun:test";
import { incrementalJql } from "./jql";

/**
 * 纯函数，无 I/O。两个坑各自一条测试：AND 比 OR 绑得紧（不加括号会漏一半结果），
 * 以及 ORDER BY 必须留在最后（拼错了是语法错误，不是"结果少了点"）。
 */

test("用户 JQL 里有 OR 时先加括号再 AND，不然 AND 会绑得比 OR 紧", () => {
  const got = incrementalJql("project = A OR project = B", 12);
  expect(got).toBe('(project = A OR project = B) AND updated >= "-12m"');
});

test("末尾带 ORDER BY 时，条件被切开、AND 只加在条件那半，ORDER BY 原样接回去", () => {
  const got = incrementalJql("assignee = currentUser() ORDER BY updated DESC", 5);
  expect(got).toBe('(assignee = currentUser()) AND updated >= "-5m" ORDER BY updated DESC');
});

test("大小写不敏感地识别 ORDER BY，且支持多字段 + ASC/DESC", () => {
  const got = incrementalJql("project = A order by priority desc, updated asc", 3);
  expect(got).toBe('(project = A) AND updated >= "-3m" order by priority desc, updated asc');
});

test("空/纯空白 JQL 只返回时间条件本身，不产生空括号", () => {
  expect(incrementalJql("", 10)).toBe('updated >= "-10m"');
  expect(incrementalJql("   ", 10)).toBe('updated >= "-10m"');
});

test("minutes 非正数被钳到至少 1 分钟", () => {
  expect(incrementalJql("project = A", 0)).toBe('(project = A) AND updated >= "-1m"');
  expect(incrementalJql("project = A", -5)).toBe('(project = A) AND updated >= "-1m"');
});

test("minutes 是小数时向上取整——差一分钟也不该漏掉窗口边缘的那条", () => {
  expect(incrementalJql("project = A", 1.2)).toBe('(project = A) AND updated >= "-2m"');
});
