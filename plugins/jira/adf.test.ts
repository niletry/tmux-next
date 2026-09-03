import { test, expect } from "bun:test";
import { adfToText } from "./adf";

test("段落之间空一行", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "第一段" }] },
      { type: "paragraph", content: [{ type: "text", text: "第二段" }] },
    ],
  };
  expect(adfToText(doc)).toBe("第一段\n\n第二段");
});

test("同一段里的多个文本节点连起来", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "加粗" }, { type: "text", text: "普通" }] },
    ],
  };
  expect(adfToText(doc)).toBe("加粗普通");
});

test("列表项前面加短横", () => {
  const doc = {
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "甲" }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "乙" }] }] },
        ],
      },
    ],
  };
  expect(adfToText(doc)).toBe("- 甲\n- 乙");
});

test("hardBreak 是一个换行", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "上" }, { type: "hardBreak" }, { type: "text", text: "下" }] },
    ],
  };
  expect(adfToText(doc)).toBe("上\n下");
});

// 描述可能是 null（没写描述）、可能是字符串（老的 wiki 格式），也可能是别的什么。
// 一律不抛：拿不到就当没有，这是 fields 整条路的失败语义。
test("认不出的输入返回空串", () => {
  expect(adfToText(null)).toBe("");
  expect(adfToText("纯字符串")).toBe("纯字符串");
  expect(adfToText(42)).toBe("");
});

test("深度嵌套不会栈溢出", () => {
  let node: unknown = { type: "text", text: "底" };
  for (let i = 0; i < 200; i++) node = { type: "paragraph", content: [node] };
  expect(adfToText({ type: "doc", content: [node] })).toContain("底");
});
