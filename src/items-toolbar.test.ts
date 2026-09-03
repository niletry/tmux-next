import { test, expect, afterEach } from "bun:test";
import { Window } from "happy-dom";

/**
 * 工作单页工具条的控件外观，在真 DOM 里驱动。
 *
 * 单独一个文件而不是并进 items-page.test.ts：那个文件测的是"单和会话怎么画成
 * 卡片"，这里测的是"工具条上的控件戴没戴对类"——两件事的失败原因不重叠，混在
 * 一起时，卡片渲染的一处改动会把工具条的断言一起弄红，反过来也一样。
 *
 * 这些断言存在的理由是一个真实的缺陷：两个下拉的 class 完全相同，样式却是按 ID
 * 挂的（`#group-by` 有外观规则、`#session-filter` 没有），于是"开工"那个下拉掉回
 * 了浏览器原生的白底方框。加三态筛选时补了触控高度、漏了外观——按 ID 挂样式，
 * 没有任何东西会提醒你"还有一个同类控件"。下面第一条断言就是当时该有的那条。
 */

const PAGE = new URL("../public/items.js", import.meta.url).pathname;

const NOW = Math.floor(Date.now() / 1000);

const payload = {
  items: [{ id: "it-1", title: "修登录页", source: null, tags: [], createdAt: NOW, closedAt: null }],
  bindings: [],
  sessions: [],
  facets: {},
};

const PATCHED = ["window", "document", "location", "history", "URLSearchParams",
  "localStorage", "fetch", "setInterval"] as const;
const saved = new Map<string, unknown>();
// 只有 mount() 动过 globalThis 时才还原。没这个开关的话，一个从没 mount 过的
// 测试文件也会跑还原循环，把 saved 里没有的真全局（fetch 之类）直接删掉，
// 弄坏同进程里其它文件——这个仓库出过这个事故。
let patched = false;

afterEach(() => {
  if (!patched) return;
  for (const key of PATCHED) {
    if (saved.has(key)) {
      Object.defineProperty(globalThis, key, {
        value: saved.get(key), writable: true, configurable: true,
      });
    } else {
      delete (globalThis as Record<string, unknown>)[key];
    }
  }
  saved.clear();
  patched = false;
});

async function mountToolbar(store: Record<string, string> = {}) {
  const win = new Window({ url: "http://127.0.0.1:7682/index.html" });
  const doc = win.document;
  doc.body.innerHTML = '<header id="header"></header><main id="items"></main>';

  const first = !patched;
  patched = true;
  const shims: Record<string, unknown> = {
    window: win,
    document: doc,
    location: win.location,
    history: win.history,
    URLSearchParams: win.URLSearchParams,
    localStorage: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = v; },
    },
    fetch: (async (u: unknown) => {
      const href = String(u);
      if (href.includes("api/items")) return new Response(JSON.stringify(payload));
      if (href.includes("api/plugins")) return new Response(JSON.stringify([]));
      if (href.includes("api/language")) return new Response(JSON.stringify({ lang: "en" }));
      return new Response("{}");
    }) as typeof fetch,
    setInterval: () => 0,
  };
  for (const key of PATCHED) {
    if (first && key in globalThis) saved.set(key, (globalThis as Record<string, unknown>)[key]);
    Object.defineProperty(globalThis, key, {
      value: shims[key], writable: true, configurable: true,
    });
  }

  await import(`${PAGE}?t=${Math.random()}`);
  await new Promise((r) => setTimeout(r, 250));
  return doc.querySelector(".toolbar-actions")!;
}

/**
 * 这条是本次修复的核心断言，也是当初能拦住那个 bug 的那条。
 *
 * 它不列举控件，而是要求 `.toolbar-actions` 的每个孩子都戴 `.toolbar-control`。
 * 按名字列举的清单挡不住"新加一个控件时忘了给它挂样式"——那正是发生过的事；
 * 而这条断言对将来加进来的控件同样成立。
 */
test("工具条里每个控件都戴 .toolbar-control", async () => {
  const actions = await mountToolbar();
  expect(actions.children.length).toBeGreaterThan(0);
  const bare = [...actions.children]
    .filter((c) => !c.classList.contains("toolbar-control"))
    .map((c) => c.id || c.className || c.tagName);
  expect(bare).toEqual([]);
});

test("下拉都是同一种外观，不是一个药丸一个原生方框", async () => {
  const actions = await mountToolbar();
  const selects = [...actions.querySelectorAll("select")];
  expect(selects.map((s) => s.id).sort()).toEqual(["group-by", "session-filter", "view-mode"]);
  // 各自的容器戴同一个变体类——外观由类决定，而不是由哪个 id 恰好被写过规则决定。
  for (const s of selects) {
    const wrap = s.closest(".toolbar-control");
    expect(wrap).not.toBeNull();
    expect(wrap!.classList.contains("is-field")).toBe(true);
  }
});

test("主动作和次动作各自成一档", async () => {
  const actions = await mountToolbar();
  const sync = actions.querySelector("#sync-items")!;
  const create = actions.querySelector("#new-item")!;
  expect(sync.classList.contains("is-primary")).toBe(true);
  expect(create.classList.contains("is-secondary")).toBe(true);
  // 两档必须真的不同——都挂成主动作的话上面两条仍然全绿。
  expect(sync.classList.contains("is-secondary")).toBe(false);
  expect(create.classList.contains("is-primary")).toBe(false);
});

/**
 * 归档开关有了药丸容器，但里面仍然是原生 checkbox。
 *
 * 值得单独钉一条：把它画成"看起来像开关的按钮"最省事，代价是丢掉原生复选框的
 * 键盘语义和读屏播报。容器只是外观，交互控件不许被换掉。
 */
test("归档开关是同一档外观，里面仍是原生 checkbox", async () => {
  const actions = await mountToolbar();
  const wrap = actions.querySelector(".show-archived-wrap")!;
  expect(wrap.classList.contains("toolbar-control")).toBe(true);
  expect(wrap.classList.contains("is-field")).toBe(true);
  const box = wrap.querySelector("input")!;
  expect(box.getAttribute("type")).toBe("checkbox");
  expect(wrap.tagName).toBe("LABEL");
});
