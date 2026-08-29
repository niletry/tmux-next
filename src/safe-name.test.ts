import { test, expect } from "bun:test";
import { safeBasename } from "./safe-name";

/**
 * safeBasename 是内核模块：既守着会话上传，也守着 /p/<id>/* 的插件静态资源
 * 路由。这些用例本来睡在 plugins/gallery/gallery.test.ts 里——删掉制品库插件
 * 本身（接缝要证明这是安全的）会把它们一起带走，内核的路径穿越防线就没测试
 * 了。挪到这里，跟着它守护的模块走。
 */

test("accepts an ordinary basename", () => {
  expect(safeBasename("chart-2.png")).toBe("chart-2.png");
  expect(safeBasename("我的图.png")).toBe("我的图.png");
});

test("refuses anything that could climb out of the target directory", () => {
  for (const bad of [
    "../secret",
    "a/b.png",
    "a\\b.png",
    "..",
    ".",
    ".hidden",
    "with\0null.png",
    "",
  ]) {
    expect(safeBasename(bad)).toBe(null);
  }
});
