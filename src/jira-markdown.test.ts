import { test, expect } from "bun:test";
import { parseMarkdown, parseInline } from "../plugins/jira/public/markdown.js";

/**
 * Markdown 解析。
 *
 * 解析成数据而不是 HTML 字符串，所以这些测试就是这个渲染器的全部行为——建 DOM 那
 * 一层只是照着这棵树建节点。
 *
 * 会话内容是外部输入：下面关于链接协议、以及"行内代码里的标记不再是标记"的几条，
 * 不是锦上添花，是这个模块被允许存在的前提。
 */

test("段落：连续的行并成一段，空行分段", () => {
  expect(parseMarkdown("第一行\n还是第一段\n\n第二段")).toEqual([
    { type: "p", spans: [{ type: "text", value: "第一行 还是第一段" }] },
    { type: "p", spans: [{ type: "text", value: "第二段" }] },
  ]);
});

test("标题带级别", () => {
  expect(parseMarkdown("## 小标题")).toEqual([
    { type: "h", level: 2, spans: [{ type: "text", value: "小标题" }] },
  ]);
});

test("围栏代码整块原样收走，里面的标记不解析", () => {
  // 这是最容易错的一处：代码里的 # 和 - 只是代码。
  const md = "```ts\n# 不是标题\n- 不是列表\n```";
  expect(parseMarkdown(md)).toEqual([{ type: "code", value: "# 不是标题\n- 不是列表", lang: "ts" }]);
});

test("没有收尾围栏时，剩下的全算代码而不是丢掉", () => {
  // 尾部读天然会截断，半截围栏是常态。
  expect(parseMarkdown("```\n半截")).toEqual([{ type: "code", value: "半截", lang: "" }]);
});

test("无序与有序列表各自成块", () => {
  expect(parseMarkdown("- 甲\n- 乙")).toEqual([
    { type: "list", ordered: false, items: [[{ type: "text", value: "甲" }], [{ type: "text", value: "乙" }]] },
  ]);
  expect(parseMarkdown("1. 甲\n2. 乙")).toEqual([
    { type: "list", ordered: true, items: [[{ type: "text", value: "甲" }], [{ type: "text", value: "乙" }]] },
  ]);
});

test("列表紧跟段落时不会把段落吞进去", () => {
  const blocks = parseMarkdown("- 甲\n后面这句是段落");
  expect(blocks.map((b) => b.type)).toEqual(["list", "p"]);
});

test("行内：粗体、斜体、代码", () => {
  expect(parseInline("**粗** 和 *斜* 和 `码`")).toEqual([
    { type: "strong", value: "粗" },
    { type: "text", value: " 和 " },
    { type: "em", value: "斜" },
    { type: "text", value: " 和 " },
    { type: "code", value: "码" },
  ]);
});

test("行内代码里的星号不再是标记", () => {
  // 先切代码就是为了这个：`a * b` 里的星号是代码的一部分。
  expect(parseInline("`a * b`")).toEqual([{ type: "code", value: "a * b" }]);
});

test("链接只放行 http/https", () => {
  expect(parseInline("[看这里](https://example.com/x)")).toEqual([
    { type: "link", value: "看这里", href: "https://example.com/x" },
  ]);
});

test.each([
  "[点我](javascript:alert(1))",
  "[点我](data:text/html,<script>)",
  "[点我](  javascript:alert(1)  )",
])("%s 不产生链接，原文一字不丢", (input) => {
  // 要紧的是「没有造出可点的脚本链接」和「文字没被吃掉」。它具体切成几段文字是
  // 实现细节，断言那个只会让正则一改就红。
  const spans = parseInline(input);
  expect(spans.some((s) => s.type === "link")).toBe(false);
  expect(spans.map((s) => ("value" in s ? s.value : "")).join("")).toBe(input);
});

test("引用与分隔线", () => {
  expect(parseMarkdown("> 引用\n\n---")).toEqual([
    { type: "quote", spans: [{ type: "text", value: "引用" }] },
    { type: "hr" },
  ]);
});

test("空输入与非字符串都得出空数组，不抛", () => {
  expect(parseMarkdown("")).toEqual([]);
  // 这段文字来自网络响应，不能假设它一定是字符串。
  expect(parseMarkdown(undefined as unknown as string)).toEqual([]);
});

test("输出是数据不是标记：标签原样留在 text 里，等着经 textContent 落地", () => {
  const blocks = parseMarkdown("# 标题\n\n<img src=x onerror=alert(1)>\n\n- 项");

  // 每一个 span 都只能是这几种已知类型——没有任何一处能携带标记进入 DOM。
  const KINDS = new Set(["text", "code", "strong", "em", "link"]);
  const spans = blocks.flatMap((b) =>
    b.type === "list" ? b.items.flat() : "spans" in b ? b.spans : [],
  );
  expect(spans.every((s) => KINDS.has(s.type))).toBe(true);

  // 那段标签仍在，但身份是「文字」——它会被当字面量画出来，不会被解释。
  const para = blocks.find((b) => b.type === "p");
  expect(para && "spans" in para && para.spans).toEqual([
    { type: "text", value: "<img src=x onerror=alert(1)>" },
  ]);
});
