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
  // 模板正文里本来就含有字面量 "true"（「只有 {{autoConfirmPermission}} 为
  // true 时…」），所以单独 toContain("true") 哪怕占位符渲染成了 "false" 也会
  // 通过——这里改成断言替换后的那句话本身，把 IMPORTANT 3 说的"这一个 flag
  // 没有诚实的测试"堵上。
  expect(text).toContain("只有 true 为 true 时才可以代为");
  expect(text).not.toContain("只有 false 为 true 时才可以代为");
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
  expect(text).toContain("只有 false 为 true 时才可以代为");
  expect(text).not.toContain("只有 true 为 true 时才可以代为");
});
