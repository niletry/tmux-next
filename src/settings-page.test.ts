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

async function mount(search = "", opts: { settingsStatus?: number } = {}) {
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
      if (href.includes("/settings")) {
        if (opts.settingsStatus) return new Response("no", { status: opts.settingsStatus });
        // 服务端读回来的形状：密钥只有一个比特，别的是原值。
        return new Response(JSON.stringify({
          url: "https://example.atlassian.net",
          email: "me@example.com",
          token: { set: true },
          jql: "assignee = currentUser()",
          onlyKeyedPrs: true,
          "bitbucket.email": "",
          "bitbucket.appPassword": { set: false },
        }));
      }
      if (href.includes("api/language")) return new Response(JSON.stringify({ lang: "zh" }));
      // 两个名字，且**故意不同**：选中态、预览、点击写哪个字段，三件事都只有在
      // 两半不一样的时候才分得出对错。
      if (href.includes("api/theme")) {
        return new Response(JSON.stringify({ name: "nord", ui: "catppuccin-latte" }));
      }
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

test("内核自己的四节排在最前", async () => {
  const root = await mount();
  const heads = [...root.querySelectorAll(".settings-head")].map((h) => h.textContent);
  // 语言在最前：它决定这一页其余部分用什么字写。插件那几节要等一次网络往返，
  // 追加在后面——所以这里只钉前四个，不钉总数。
  expect(heads.slice(0, 4)).toEqual(["语言", "终端配色", "界面配色", "虚拟按键"]);
});

test("两节各列出每一款配色", async () => {
  const root = await mount();
  const lists = root.querySelectorAll(".theme-list");
  expect(lists.length).toBe(2);
  for (const list of lists) {
    // 深色/浅色两组标题，七款配色——组标题也是 list 的子节点，不能只数子节点数。
    expect(list.querySelectorAll(".theme-group").length).toBe(2);
    expect(list.querySelectorAll(".theme-opt").length).toBe(7);
    // 选中的那一款要标出来，否则这一节说不出当前是哪个。
    expect(list.querySelectorAll(".theme-opt.on").length).toBe(1);
  }
});

// 缓存是空的（垫片里的 localStorage 每次 mount 都是新的），所以选中态只能来自
// 那一次 api/theme。这一条同时钉住"设置页真的去问了服务端"——在此之前这一页
// 谁也没调 initTheme()，于是它画的是兜底调色板、勾的是缓存。
test("两节各自勾住服务端那一份", async () => {
  const root = await mount();
  const [term, ui] = [...root.querySelectorAll(".theme-list")];
  const picked = (list: any) => list.querySelector(".theme-opt.on b")?.textContent;
  expect(picked(term)).toBe("Nord");
  expect(picked(ui)).toBe("Catppuccin Latte");
});

test("点一款配色会存起来", async () => {
  const root = await mount();
  const list = root.querySelector(".theme-list");
  const off = [...list!.querySelectorAll(".theme-opt")].find((o) => !o.className.includes("on"));
  click(off);
  await new Promise((r) => setTimeout(r, 40));
  expect(posted.some((p) => p.url.includes("api/theme"))).toBe(true);
  // 只有点中的那一款该带 .on / aria-pressed="true"——分组标题 <h3> 也是 list 的
  // 子节点，用 list.children 更新会把标题也误标成"选中"，这条断言才抓得到那个 bug。
  expect(list!.querySelectorAll(".theme-opt.on").length).toBe(1);
  expect(list!.querySelectorAll('[aria-pressed="true"]').length).toBe(1);
});

// 两个旋钮真的独立：发上去的是补丁，只有被点的那一节对应的字段。合并在服务端，
// 所以改界面外观这一下不该在请求里提到终端调色板。
test("每一节只写自己那个字段", async () => {
  const root = await mount();
  const [termList, uiList] = [...root.querySelectorAll(".theme-list")];
  const other = (list: any) =>
    [...list.querySelectorAll(".theme-opt")].find((o: any) => !o.className.includes("on"));

  click(other(uiList));
  await new Promise((r) => setTimeout(r, 40));
  let body = JSON.parse(posted.at(-1)!.body);
  expect(Object.keys(body)).toEqual(["ui"]);

  click(other(termList));
  await new Promise((r) => setTimeout(r, 40));
  body = JSON.parse(posted.at(-1)!.body);
  expect(Object.keys(body)).toEqual(["name"]);

  // 点了终端那一节之后，界面那一节的选中态不该跟着动。
  expect(uiList.querySelectorAll(".theme-opt.on").length).toBe(1);
  expect(termList.querySelectorAll(".theme-opt.on").length).toBe(1);
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

/**
 * 插件配置那几节。
 *
 * 这一页照着清单里的 settings 画表单，**不知道任何一个字段是什么意思**——所以这里
 * 断言的是"照声明画"，不是"Jira 长这样"。
 */

test("声明了配置的插件各画一节", async () => {
  const root = await mount();
  await new Promise((r) => setTimeout(r, 80));
  const heads = [...root.querySelectorAll(".settings-head")].map((h) => h.textContent);
  // 内核四节（语言、终端配色、界面配色、虚拟按键），加上声明了 settings 的那个插件
  expect(heads.length).toBe(5);
});

test("密钥画成 password，且输入框是空的", async () => {
  const root = await mount();
  await new Promise((r) => setTimeout(r, 80));
  const secrets = [...root.querySelectorAll('input[type="password"]')] as unknown as HTMLInputElement[];
  expect(secrets.length).toBe(2);
  // 值绝不回填：回填一串掩码迟早会被当成真值存回去。
  for (const input of secrets) expect(input.value).toBe("");
  // 设过没设过靠占位符说，不靠往框里塞东西。
  expect(secrets[0]!.getAttribute("placeholder")).toBe("已设置 · 留空则不改");
  expect(secrets[1]!.getAttribute("placeholder")).toBe("未设置");
});

test("非密钥字段回填当前值", async () => {
  const root = await mount();
  await new Promise((r) => setTimeout(r, 80));
  const urlInput = root.querySelector('input[type="url"]') as unknown as HTMLInputElement;
  expect(urlInput.value).toBe("https://example.atlassian.net");
});

test("保存把整份表单 PUT 上去", async () => {
  const root = await mount();
  await new Promise((r) => setTimeout(r, 80));
  click([...root.querySelectorAll(".settings-actions .btn")][0]);
  await new Promise((r) => setTimeout(r, 60));

  const req = posted.find((p) => p.url.includes("api/plugins/jira/settings"));
  expect(req).toBeDefined();
  const body = JSON.parse(req!.body);
  // 没动过的密钥送空串——服务端把它解释成"不改"。
  expect(body.token).toBe("");
  expect(body.url).toBe("https://example.atlassian.net");
  expect(body.onlyKeyedPrs).toBe(true);
});

// 存成了也要说一句：密钥框存完仍然是空的，没有回执的话屏幕上看不出生效没有。
test("保存后给一句回执", async () => {
  const root = await mount();
  await new Promise((r) => setTimeout(r, 80));
  click([...root.querySelectorAll(".settings-actions .btn")][0]);
  await new Promise((r) => setTimeout(r, 60));
  const note = root.querySelector(".settings-result") as unknown as HTMLElement;
  expect(note.hidden).toBe(false);
  expect(note.textContent).toBe("已保存");
});

// 读不到就不画这一节：那意味着插件被关掉了或服务端答不上来，画一个存不进去的
// 表单只是骗人。
test("读不到配置就不画那一节", async () => {
  const root = await mount("", { settingsStatus: 404 });
  await new Promise((r) => setTimeout(r, 80));
  expect(root.querySelectorAll(".settings-head").length).toBe(4);
  expect(root.querySelector(".settings-form")).toBeNull();
});
