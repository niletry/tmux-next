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

test("旧地址只能是纯文件名，不能带路径", () => {
  // 它会被拿去跟 url.pathname 比对。允许 `/` 就等于让一个插件声明自己接管
  // `p/别的插件/` 或任意深路径——即便顺序上静态文件优先，也没有理由留这个口子。
  for (const p of PLUGINS) {
    for (const legacy of p.legacyPaths ?? []) {
      expect({ id: p.id, legacy }).toEqual({ id: p.id, legacy: legacy.replace(/[/\\]/g, "") });
      expect(legacy.startsWith(".")).toBe(false);
    }
  }
});

test("两个插件不能声明同一个旧地址", () => {
  // 撞了的话谁接管取决于注册表顺序，那是最难查的一类 bug。
  const all = PLUGINS.flatMap((p) => p.legacyPaths ?? []);
  expect(all).toEqual([...new Set(all)]);
});

test("注册表里的每个插件都在服务端能力表里有对应项", async () => {
  // 加了清单却忘了接线，表现是这个插件的 tab 出来了、点进去所有 API 都 404——
  // 一个只有真跑起来才发现的错误。两张表必须分开（registry.js 是同构的，不能引
  // .ts），所以只能由测试来保证它们同步。
  const { SERVERS } = await import("./handlers");
  for (const p of PLUGINS) {
    expect({ id: p.id, wired: p.id in SERVERS }).toEqual({ id: p.id, wired: true });
  }
});

test("能力表里没有注册表之外的孤儿", async () => {
  const { SERVERS } = await import("./handlers");
  const ids = new Set(PLUGINS.map((p) => p.id));
  expect(Object.keys(SERVERS).filter((id) => !ids.has(id))).toEqual([]);
});
