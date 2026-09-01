import { test, expect, afterEach } from "bun:test";
import { Window } from "happy-dom";
import { url } from "../public/root.js";

/**
 * 顶栏是插件唯一的入口。它从注册表生成，而 nav.js 不在 checkJs 里——
 * 一个拼错的字段名在这里的表现是"tab 静静地少一个"，别的测试全都照绿。
 *
 * 另一半是回退：启用列表要现问服务端，而默认是全开，所以问不到的时候必须
 * 当全开处理。反过来做，服务暂时不可达就等于把功能藏了。
 */

const NAV = new URL("../public/nav.js", import.meta.url).pathname;

const saved = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document };
afterEach(() => {
  // 覆盖全局却不还原，曾经一次弄红了别的文件里 38 个测试——Bun 一个进程跑全部。
  globalThis.fetch = saved.fetch;
  globalThis.window = saved.window;
  globalThis.document = saved.document;
});

async function mount(
  /** 让 /api/plugins 返回什么，null = 让它失败 */ ids: string[] | null,
  current = "sessions",
) {
  const window = new Window({ url: "http://localhost/" });
  const doc = window.document;
  doc.body.innerHTML = '<header id="header"></header>';
  // @ts-expect-error happy-dom 的 window 不是 lib.dom 的那个
  globalThis.window = window;
  globalThis.document = doc as unknown as Document;
  globalThis.fetch = (async (input: string) => {
    const href = String(input);
    if (href.endsWith("/api/plugins")) {
      if (ids === null) throw new Error("offline");
      return new Response(JSON.stringify(ids));
    }
    if (href.endsWith("/api/language")) return new Response(JSON.stringify({ lang: "en" }));
    return new Response("{}");
  }) as typeof fetch;

  const { renderNav } = await import(NAV + `?t=${Math.random()}`);
  await renderNav(doc.getElementById("header"), current);
  return doc;
}

test("顶栏画出单加会话页加每个启用的插件", async () => {
  // current 不落在任何一个 tab 上：让四个都当链接画出来，好断言各自的 href。
  const doc = await mount(["gallery", "notifications"], "other");
  const items = [...doc.querySelectorAll(".hseg-item")];
  // 单是首页，排最前；会话页跟着；插件按注册表顺序跟在后面。
  expect(items.length).toBe(4);
  // href 走 url()：绝对 URL 才在反代子路径下不破，所以拿 url() 的产出算期望值，
  // 而不是写死一个相对路径字面量（那样的字面量永远不会等于 url() 的返回值）。
  expect(items[0]!.getAttribute("href")).toBe(url("./"));
  expect(items[1]!.getAttribute("href")).toBe(url("sessions.html"));
  expect(items[2]!.getAttribute("href")).toBe(url("p/gallery/"));
  expect(items[2]!.getAttribute("aria-label")).toBe("Artifacts");
  expect(items[3]!.getAttribute("href")).toBe(url("p/notifications/"));
});

test("被禁用的插件不出现在顶栏", async () => {
  const doc = await mount([]);
  // 单和会话页永远在，插件都关掉时只剩这两个。
  expect([...doc.querySelectorAll(".hseg-item")].length).toBe(2);
});

test("问不到启用列表就当全开——离线不该把功能藏起来", async () => {
  const doc = await mount(null);
  const hrefs = [...doc.querySelectorAll(".hseg-item")].map((n) => n.getAttribute("href"));
  expect(hrefs).toContain(url("p/gallery/"));
});

test("当前页是 span 不是链接，且带上计数元素", async () => {
  const doc = await mount(["gallery"]);
  const active = doc.querySelector(".hseg-item.on")!;
  expect(active.tagName).toBe("SPAN");
  expect(active.getAttribute("aria-current")).toBe("page");
  expect(doc.getElementById("count")).not.toBeNull();
});

test("aria-current 落在传入的当前页上，不是永远第一个", async () => {
  const doc = await mount([], "items");
  const items = [...doc.querySelectorAll(".hseg-item")];
  expect(items[0]!.tagName).toBe("SPAN");
  expect(items[0]!.getAttribute("aria-current")).toBe("page");
  expect(items[1]!.tagName).toBe("A");
});
