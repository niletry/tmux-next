import { test, expect } from "bun:test";
import { PLUGINS } from "./registry.js";
import { KERNEL_KEYS } from "../public/i18n.js";

/**
 * 注册表是写死的，所以这里检的不是"扫描对不对"，而是清单本身自洽——
 * 尤其是最后那条 import 图断言：registry.js 被浏览器加载，里面只要引到一个
 * .ts，服务端代码就被拖进浏览器包，而这种事只有构建器看得见。
 */

test("有插件可查", () => {
  expect(PLUGINS.length).toBeGreaterThan(0);
});

test("每个 id 合法、唯一，且不撞内核路由", () => {
  const ids = PLUGINS.map((p) => p.id);
  for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  expect(ids).toEqual([...new Set(ids)]);
  // /api/plugins 是内核的，一个叫 plugins 的插件会把它盖掉。
  expect(ids).not.toContain("plugins");
});

test("每个清单字段齐全", () => {
  for (const p of PLUGINS) {
    expect(typeof p.titleKey).toBe("string");
    expect(p.titleKey.length).toBeGreaterThan(0);
    expect(typeof p.icon).toBe("string");
    expect(p.icon.length).toBeGreaterThan(0);
  }
});

test("每个插件的两本字典键集一致", () => {
  for (const p of PLUGINS) {
    const zh = Object.keys(p.i18n.zh).sort();
    const en = Object.keys(p.i18n.en).sort();
    // 报成 diff 而不是布尔，失败时能直接看见是哪个键。
    expect({ id: p.id, zhOnly: zh.filter((k) => !en.includes(k)) })
      .toEqual({ id: p.id, zhOnly: [] });
    expect({ id: p.id, enOnly: en.filter((k) => !zh.includes(k)) })
      .toEqual({ id: p.id, enOnly: [] });
  }
});

test("清单里的标题键在它自己的字典里", () => {
  for (const p of PLUGINS) expect(p.i18n.en[p.titleKey]).toBeDefined();
});

test("没有插件字典键悄悄盖掉内核的键", () => {
  // public/i18n.js 用 Object.assign 把每个插件的字典合到内核字典上——撞了
  // 键就静默覆盖，不报错也不留痕迹。这里在合并前就把内核自己的键集存下来，
  // 拿它跟每个插件的键分别比对。
  for (const p of PLUGINS) {
    const collide = [...Object.keys(p.i18n.en), ...Object.keys(p.i18n.zh)].filter((k) =>
      KERNEL_KEYS.has(k),
    );
    expect({ id: p.id, collide: [...new Set(collide)] }).toEqual({ id: p.id, collide: [] });
  }
});

test("registry.js 的 import 图里没有 .ts", async () => {
  // 浏览器要加载它。引到一个 .ts 就等于把服务端代码打进浏览器包——
  // 这是这套两张表设计唯一防的东西，所以由测试守着。
  const built = await Bun.build({
    entrypoints: [new URL("./registry.js", import.meta.url).pathname],
    target: "browser",
  });
  expect(built.logs.map(String)).toEqual([]);
  expect(built.success).toBe(true);
});
