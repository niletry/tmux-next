// plugins/supervisor/prompt.test.ts
import { expect, test } from "bun:test";
import { renderSupervisorPrompt } from "./prompt";

test("替换全部占位符，不残留任何 {{ }}", () => {
  const text = renderSupervisorPrompt({
    cwd: "/Users/you/proj",
    selfSession: "supervisor-proj",
    autoConfirmPermission: true,
    logPath: "/Users/you/.tmux-next/supervisor/logs/-Users-you-proj.jsonl",
    port: "7682",
  });

  expect(text).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
  expect(text).toContain("/Users/you/proj");
  expect(text).toContain("supervisor-proj");
  expect(text).toContain("true");
  expect(text).toContain("/Users/you/.tmux-next/supervisor/logs/-Users-you-proj.jsonl");
  expect(text).toContain("http://127.0.0.1:7682/api/notify");
});

test("autoConfirmPermission=false 也原样写进文本", () => {
  const text = renderSupervisorPrompt({
    cwd: "/a",
    selfSession: "s",
    autoConfirmPermission: false,
    logPath: "/a.jsonl",
    port: "7682",
  });
  expect(text).toContain("false");
});
