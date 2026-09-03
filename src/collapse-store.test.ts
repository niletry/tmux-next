import { test, expect, afterEach } from "bun:test";

/**
 * 折叠状态的存储层。会话列表页和设置页共用它，两边存的语义相反——列表页存
 * "折起的那几个"（默认全展开），设置页存"展开的那几个"（默认全折起）——所以
 * 这个模块只认"一组 id"，不认哪一边是默认。
 *
 * 值得单独测的是每一条读路径：这三种情况都必须退化成空集而不是抛出去，否则
 * 一个半写的 localStorage 值就能让整页画不出来，而画出来才是那两页的正事。
 *
 * DOM 垫片必须把它替换掉的全局还回去——Bun 在一个进程里跑所有测试文件。
 */
const saved = Object.hasOwn(globalThis, "localStorage")
  ? { has: true, value: (globalThis as { localStorage?: unknown }).localStorage }
  : { has: false, value: undefined };

afterEach(() => {
  if (saved.has) {
    Object.defineProperty(globalThis, "localStorage", {
      value: saved.value, writable: true, configurable: true,
    });
  } else {
    delete (globalThis as Record<string, unknown>).localStorage;
  }
});

/** @param impl 假的 localStorage；不给就是一个正常的内存实现。 */
function shim(impl?: Partial<Storage>) {
  const store: Record<string, string> = {};
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => (k in store ? store[k]! : null),
      setItem: (k: string, v: string) => { store[k] = v; },
      ...impl,
    },
    writable: true,
    configurable: true,
  });
  return store;
}

const load = () => import("../public/collapse-store.js");

test("空存储读出空集", async () => {
  shim();
  const { readIds } = await load();
  expect([...readIds("k")]).toEqual([]);
});

test("写进去的 id 读得回来", async () => {
  shim();
  const { readIds, writeIds } = await load();
  writeIds("k", new Set(["a", "b"]));
  expect([...readIds("k")].sort()).toEqual(["a", "b"]);
});

test("两个键互不相干", async () => {
  shim();
  const { readIds, writeIds } = await load();
  writeIds("one", new Set(["a"]));
  writeIds("two", new Set(["b"]));
  expect([...readIds("one")]).toEqual(["a"]);
  expect([...readIds("two")]).toEqual(["b"]);
});

test("坏 JSON 退化成空集，不抛", async () => {
  const store = shim();
  store["k"] = "{ not json";
  const { readIds } = await load();
  expect([...readIds("k")]).toEqual([]);
});

// 存的是数组，读到对象/字符串/null 都只能当"没存过"——JSON.parse 成功但形状不对
// 是最容易漏的一种，它不抛异常，直接把一个不是 Set 的东西送进渲染。
test("形状不对退化成空集", async () => {
  const { readIds } = await load();
  for (const bad of ['{"a":1}', '"a"', "null", "42"]) {
    const store = shim();
    store["k"] = bad;
    expect([...readIds("k")]).toEqual([]);
  }
});

test("数组里的非字符串被丢掉", async () => {
  const store = shim();
  store["k"] = JSON.stringify(["a", 1, null, "b", {}]);
  const { readIds } = await load();
  expect([...readIds("k")].sort()).toEqual(["a", "b"]);
});

// 隐私窗口、站点数据被清、浏览器设置里禁掉存储——这三种在真机上都出现过，
// 而它们是 getItem 自己抛，不是返回 null。
test("存储本身抛异常也只是空集", async () => {
  shim({ getItem: () => { throw new Error("denied"); } });
  const { readIds } = await load();
  expect([...readIds("k")]).toEqual([]);
});

test("写不进去不抛——只是记不住", async () => {
  shim({ setItem: () => { throw new Error("quota"); } });
  const { writeIds } = await load();
  expect(() => writeIds("k", new Set(["a"]))).not.toThrow();
});

// 两个调用点都是"读—翻转—写—重画"，所以翻转也在这里，不在各自页面里抄一遍。
test("toggleId 翻转并返回新的一组", async () => {
  shim();
  const { readIds, toggleId } = await load();
  expect([...toggleId("k", "a")]).toEqual(["a"]);
  expect([...readIds("k")]).toEqual(["a"]);
  expect([...toggleId("k", "a")]).toEqual([]);
  expect([...readIds("k")]).toEqual([]);
});
