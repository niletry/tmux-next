import { test, expect } from "bun:test";
// 浏览器模块，但是 `// @ts-check` 过的——它的 JSDoc 类型是真的。
import { ICON_PATHS, icon, svgShell } from "../public/icons.js";

/**
 * 图标集的约束。
 *
 * 这个文件断言的不是"图标好不好看"——那看不出来。断言的是**这一套图标确实是
 * 一套**：同一块画布、同一个线宽、同一种线头，颜色一律 currentColor。以前图标
 * 散在四个文件里各自内联，任何一处少写一个属性，那个图标就比旁边硬一档或粗一
 * 档，而这种不一致恰恰是评审时最容易看漏的。
 *
 * 颜色那条尤其重要：图标里出现一个写死的颜色，就意味着它不跟随主题，也不跟随
 * :hover——而且它会绕过 src/themes.test.ts 的字面量扫描，因为那条只扫样式表。
 */

const names = Object.keys(ICON_PATHS);

test("有图标，而且都不是空的", () => {
  expect(names.length).toBeGreaterThan(10);
  const empty = names.filter((n) => !ICON_PATHS[n]!.trim());
  expect(empty).toEqual([]);
});

test.each(names)("%s 用的是共享的那套外壳属性", (name) => {
  const svg = icon(name);
  for (const attr of [
    'viewBox="0 0 24 24"',
    'fill="none"',
    'stroke="currentColor"',
    'stroke-width="2"',
    'stroke-linecap="round"',
    'stroke-linejoin="round"',
    'aria-hidden="true"',
  ]) {
    expect({ name, attr, present: svg.includes(attr) }).toEqual({ name, attr, present: true });
  }
});

test("图标里不出现颜色字面量", () => {
  const offenders = names.filter((n) => /#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(ICON_PATHS[n]!));
  expect(offenders).toEqual([]);
});

test("不认识的名字返回空串，而不是抛异常", () => {
  // 调用点常常是 `el.innerHTML = icon(name)`。抛出来会把整块渲染带走，而一个
  // 少画的图标只是少一个图标——两者的破坏范围差着数量级。
  expect(icon("no-such-icon")).toBe("");
});

test("给了尺寸就写死宽高，没给就交给 CSS", () => {
  expect(icon("plus", 18)).toContain('width="18" height="18"');
  // 顶栏的标签是这么排的：尺寸由样式表决定，而不是由每个调用点各写一个数字。
  // 前面留空格，否则会匹配上 stroke-width。
  expect(svgShell(ICON_PATHS.plus!)).not.toContain(' width="');
});

test("插件给的路径走同一个外壳", () => {
  // 插件在自己的清单里给路径而不是名字——内核不认识任何一个插件，当然也没有
  // 它们的图标名。共用外壳是"所有图标长得像一套"对插件也成立的唯一保证。
  const svg = svgShell('<circle cx="12" cy="12" r="5"/>', 16);
  expect(svg).toContain('stroke-width="2"');
  expect(svg).toContain('<circle cx="12" cy="12" r="5"/>');
});
