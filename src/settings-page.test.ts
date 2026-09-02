import { test, expect, afterEach } from "bun:test";
import { Window } from "happy-dom";

/**
 * 系统配置页，在真 DOM 里跑一遍。
 *
 * 这一页有两处真会出错的地方，而且都不会在别的测试里露头：换语言要把整页连同顶栏
 * 一起重建（只重建正文会留下一句旧话），以及返回键要认得来路（齿轮是从任意页面点
 * 进来的，包括插件页 /p/<id>/）。
 */

const PAGE = new URL("../public/settings.js", import.meta.url).pathname;

const PATCHED = ["window", "document", "location", "history", "URLSearchParams",
  "localStorage", "fetch"] as const;
const saved = new Map<string, unknown>();
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

/** 页面发出去的写请求。 */
let posted: { url: string; body: string }[] = [];

async function mount(search = "") {
  posted = [];
  const win = new Window({ url: `http://127.0.0.1:7682/settings.html${search}` });
  const doc = win.document;
  doc.body.innerHTML = '<header id="header"></header><main id="settings"></main>';

  const store: Record<string, string> = {};
  const shims: Record<string, unknown> = {
    window: win,
    document: doc,
    location: win.location,
    history: win.history,
    URLSearchParams: win.URLSearchParams,
    localStorage: {
      getItem: (k: string) => (k in store ? store[k]! : null),
      setItem: (k: string, v: string) => { store[k] = v; },
    },
    fetch: (async (u: unknown, init?: RequestInit) => {
      const href = String(u);
      if (init?.method && init.method !== "GET") {
        posted.push({ url: href, body: String(init.body ?? "") });
        return new Response(JSON.stringify({ ok: true }));
      }
      if (href.includes("api/language")) return new Response(JSON.stringify({ lang: "zh" }));
      if (href.includes("api/theme")) return new Response(JSON.stringify({ theme: "tokyo-night" }));
      if (href.includes("api/key-usage")) return new Response(JSON.stringify({}));
      return new Response("{}");
    }) as typeof fetch,
  };
  // 只有第一层记录原值：一个测试里 mount 两次时 globalThis 上放着的是上一层 shim，
  // 存进去会让 afterEach 把假 fetch 当原值还原，弄脏整个进程。
  const first = !patched;
  patched = true;
  for (const key of PATCHED) {
    if (first && key in globalThis) saved.set(key, (globalThis as Record<string, unknown>)[key]);
    Object.defineProperty(globalThis, key, {
      value: shims[key], writable: true, configurable: true,
    });
  }

  await import(`${PAGE}?t=${Math.random()}`);
  await new Promise((r) => setTimeout(r, 120));
  return doc.getElementById("settings")!;
}

const click = (n: unknown) =>
  (n as { dispatchEvent: (e: unknown) => void } | null)?.dispatchEvent(
    new (globalThis as any).window.Event("click", { bubbles: true }),
  );

test("三节配置都画出来了", async () => {
  const root = await mount();
  const heads = [...root.querySelectorAll(".settings-head")].map((h) => h.textContent);
  expect(heads.length).toBe(3);
  // 语言在最前：它决定这一页其余部分用什么字写。
  expect(heads[0]).toBe("语言");
});

test("主题一节列出每一款配色", async () => {
  const root = await mount();
  const opts = root.querySelectorAll(".theme-opt");
  expect(opts.length).toBeGreaterThan(1);
  // 选中的那一款要标出来，否则这一页说不出当前是哪个。
  expect(root.querySelectorAll(".theme-opt.on").length).toBe(1);
});

test("点一款配色会存起来", async () => {
  const root = await mount();
  const off = [...root.querySelectorAll(".theme-opt")].find((o) => !o.className.includes("on"));
  click(off);
  await new Promise((r) => setTimeout(r, 40));
  expect(posted.some((p) => p.url.includes("api/theme"))).toBe(true);
});

// 换语言之后顶栏那句返回文案也变了。只重建正文会留下一句旧话——这一条盯的就是它。
test("换语言把顶栏一起重建", async () => {
  const root = await mount();
  const before = document.querySelector(".settings-title")?.textContent;
  expect(before).toBe("设置");

  const en = [...root.querySelectorAll(".agent-chip")].find((c) => c.textContent === "English");
  click(en);
  await new Promise((r) => setTimeout(r, 60));

  expect(document.querySelector(".settings-title")?.textContent).toBe("Settings");
  expect([...root.querySelectorAll(".settings-head")][0]?.textContent).toBe("Language");
});

test("返回键认得来路", async () => {
  await mount("?from=sessions");
  const link = document.querySelector(".settings-back") as HTMLAnchorElement;
  expect(link.getAttribute("href")).toContain("sessions.html");
});

// 齿轮从插件页也点得到，而认不出来的来路必须落回一个真存在的页面，不能是空 href。
test("认不出来路就回默认页", async () => {
  await mount("?from=%E4%B8%8D%E5%AD%98%E5%9C%A8%E7%9A%84");
  const link = document.querySelector(".settings-back") as HTMLAnchorElement;
  expect(link.getAttribute("href")).toContain("index.html");
});
