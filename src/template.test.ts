import { test, expect } from "bun:test";
import { render, sanitiseName, MAX_RENDERED } from "./template";

test("占位符换成字段值", () => {
  expect(render("修 {item.ref}", { "item.ref": "EXAMPLE-1" })).toBe("修 EXAMPLE-1");
});

test("不认识的键渲染成空，不留大括号", () => {
  expect(render("a{nope}b", {})).toBe("ab");
});

// 这条是"删行"规则要解决的那个问题本身：没挂史诗时不该留下"史诗："这半句话。
test("一行的占位符全空，整行删掉", () => {
  expect(render("标题\n史诗：{jira.epic}\n结尾", { "jira.epic": "" })).toBe("标题\n结尾");
});

// 反面：规则是按行全有全无，部分为空时这一行仍然保留。
test("同一行里只有一部分为空，这行保留", () => {
  expect(render("{item.ref}：{jira.summary}", { "item.ref": "E-1", "jira.summary": "" })).toBe(
    "E-1：",
  );
});

test("没有占位符的行永远保留，哪怕只有标点", () => {
  expect(render("---\n{x}", {})).toBe("---");
});

test("渲染结果截到 MAX_RENDERED", () => {
  const long = "x".repeat(MAX_RENDERED + 500);
  expect(render("{a}", { a: long }).length).toBe(MAX_RENDERED);
});

test("空白折叠成连字符", () => {
  expect(sanitiseName("  修 登录  页 ")).toBe("修-登录-页");
});

// tmux 把 . 和 : 当 session:window.pane 的分隔符，带上就是一个连 kill 都 kill 不掉的会话。
test("点号和冒号被剔除", () => {
  expect(sanitiseName("a.b:c")).toBe("abc");
});

test("截到 64 字且不以连字符结尾", () => {
  const got = sanitiseName("a".repeat(70))!;
  expect(got.length).toBe(64);
  expect(got.endsWith("-")).toBe(false);
});

test("净化后为空退回 null，等于没提供名字", () => {
  expect(sanitiseName("  ...  ")).toBeNull();
});

test("撞上挂载会话保留前缀的退回 null", () => {
  expect(sanitiseName("web-123")).toBeNull();
});
