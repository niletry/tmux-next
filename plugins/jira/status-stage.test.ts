import { test, expect } from "bun:test";
import { classifyStatusStage } from "./status-stage";

/**
 * 状态灯用的六档归类：3 种已有色相（dim/accent/ok）× 空心/实心，映射真实的
 * Jira 状态名。零新增颜色——这三种色相已经是 facet.tone 在用的那套。
 */

test("todo / backlog 归为灰色空心", () => {
  expect(classifyStatusStage("To Do")).toEqual({ hue: "dim", filled: false });
  expect(classifyStatusStage("Backlog")).toEqual({ hue: "dim", filled: false });
});

test("in progress 归为灰色实心", () => {
  expect(classifyStatusStage("In Progress")).toEqual({ hue: "dim", filled: true });
});

test("ready for acceptance 归为强调色空心", () => {
  expect(classifyStatusStage("Ready for Acceptance")).toEqual({ hue: "accent", filled: false });
});

test("accepted 归为强调色实心，不会被 acceptance 的匹配抢先命中", () => {
  expect(classifyStatusStage("Accepted")).toEqual({ hue: "accent", filled: true });
});

test("ready for release 归为绿色空心", () => {
  expect(classifyStatusStage("Ready for Release")).toEqual({ hue: "ok", filled: false });
});

test("done 归为绿色实心", () => {
  expect(classifyStatusStage("Done")).toEqual({ hue: "ok", filled: true });
});

test("大小写不敏感", () => {
  expect(classifyStatusStage("DONE")).toEqual({ hue: "ok", filled: true });
});

test("认不出的状态名兜底为灰色空心，不抛错", () => {
  expect(classifyStatusStage("某种自定义状态")).toEqual({ hue: "dim", filled: false });
});
