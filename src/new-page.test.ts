import { test, expect, afterEach } from "bun:test";
import { Window } from "happy-dom";

/**
 * The new-session page, driven in a real DOM.
 *
 * Bundling proves it parses; nothing proved it *renders*. When the directory
 * page was split out of the sheet, a history.replaceState call landed in the
 * middle of browse() — one throw there and the list, the breadcrumb and the
 * favourites were all skipped, while every test stayed green because none of
 * them ever built the page.
 *
 * This is the cheapest thing that would have caught it: load the module the way
 * a browser does and look at what it drew.
 */

const PAGE = new URL("../public/new.js", import.meta.url).pathname;

const DIRS = {
  ok: true,
  path: "/tmp",
  parent: "/",
  entries: [
    { name: "alpha", path: "/tmp/alpha" },
    { name: "beta", path: "/tmp/beta" },
  ],
};

function stubFetch(overrides: Record<string, unknown> = {}) {
  return (async (u: unknown) => {
    const url = String(u);
    const body = (key: string, fallback: unknown) =>
      new Response(JSON.stringify(key in overrides ? overrides[key] : fallback));
    if (url.includes("api/directories"))
      return body("directories", { home: "/Users/x", recent: ["/tmp", "/srv"] });
    if (url.includes("api/dirs")) return body("dirs", DIRS);
    if (url.includes("api/agents"))
      return body("agents", {
        agents: [{ id: "claude", label: "Claude Code", supportsSkipPermissions: true, available: true }],
      });
    if (url.includes("api/language")) return body("language", { lang: "zh" });
    if (url.includes("api/history")) return body("history", { conversations: [] });
    if (url.includes("api/templates"))
      return body("templates", {
        templates: [{ id: "tpl-1", label: "修 bug", name: "{item.ref}", input: "修 {item.title}" }],
        fieldKeys: ["item.title", "item.ref"],
      });
    if (url.includes("/render"))
      return body("render", { name: "EXAMPLE-1", input: "修 修登录页" });
    // 会话类型选择器只在有已启用插件声明了 sessionKinds 时才画——见下面
    // "会话类型" 那组测试，它们各自按需覆盖这一条。
    if (url.includes("api/plugins")) return body("plugins", []);
    return new Response("{}");
  }) as typeof fetch;
}

/**
 * Globals this file replaces, so they can be put back.
 *
 * Bun runs every test file in one process, so overwriting `fetch` here broke
 * 38 tests elsewhere that talk to the real server. A DOM shim must clean up
 * after itself or it stops being a test and becomes a hazard.
 */
const PATCHED = ["window", "document", "location", "history", "URLSearchParams",
  "localStorage", "fetch"] as const;
const saved = new Map<string, unknown>();

afterEach(() => {
  for (const key of PATCHED) {
    const had = saved.has(key);
    if (had) {
      Object.defineProperty(globalThis, key, {
        value: saved.get(key), writable: true, configurable: true,
      });
    } else {
      delete (globalThis as Record<string, unknown>)[key];
    }
  }
  saved.clear();
});

/** Loads the page module against a fresh DOM and returns its root element. */
async function mount(fetchImpl = stubFetch(), path = "/new.html") {
  const win = new Window({ url: `http://127.0.0.1:7682${path}` });
  const doc = win.document;
  doc.body.innerHTML = '<header id="header"></header><main id="new"></main>';

  const shims: Record<string, unknown> = {
    window: win,
    document: doc,
    location: win.location,
    history: win.history,
    URLSearchParams: win.URLSearchParams,
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: fetchImpl,
  };
  // 一个测试里 mount 两次时 globalThis 上放着的是上一层 shim，把它存进 saved 会让
  // afterEach 把假 fetch 当原值还原，之后整个进程所有文件的 fetch 都是假的。
  const first = saved.size === 0;
  for (const key of PATCHED) {
    if (first && key in globalThis) saved.set(key, (globalThis as Record<string, unknown>)[key]);
    Object.defineProperty(globalThis, key, {
      value: shims[key], writable: true, configurable: true,
    });
  }

  // Cache-busted so each test gets a fresh module instance; the module wires
  // itself up at import time, exactly as the browser loads it.
  await import(`${PAGE}?t=${Math.random()}`);
  await new Promise((r) => setTimeout(r, 250));
  return doc.getElementById("new")!;
}

/** `mount` 的薄封装：按 `search` 拼出 `/new.html?...` 这个路径。 */
async function mountNewPage(opts: { search?: string; fetchImpl?: typeof fetch } = {}) {
  return mount(opts.fetchImpl ?? stubFetch(), `/new.html${opts.search ?? ""}`);
}

test("the directory listing renders", async () => {
  const root = await mount();
  const rows = [...root.querySelectorAll(".dir-row")].map((e) => e.textContent);
  expect(rows).toEqual(["alpha", "beta"]);
});

test("the breadcrumb and favourites render alongside it", async () => {
  const root = await mount();
  // All three come after the point where the URL sync used to throw, so any of
  // them missing means the same class of bug is back.
  expect(root.querySelector(".crumb")?.textContent).toContain("/tmp");
  expect(root.querySelectorAll(".chip").length).toBeGreaterThan(0);
});

test("a directory listing that fails does not leave the page blank", async () => {
  const root = await mount(
    (async (u: unknown) => {
      const url = String(u);
      if (url.includes("api/dirs")) return new Response("nope", { status: 404 });
      return stubFetch()(u as string);
    }) as typeof fetch,
  );
  // An error message, not an empty page with no explanation.
  expect(root.querySelector(".sheet-error")?.textContent?.length ?? 0).toBeGreaterThan(0);
});

test("the create button and agent picker are present", async () => {
  const root = await mount();
  expect(root.querySelector(".btn.primary")).toBeTruthy();
  expect(root.querySelector(".agent-row")).toBeTruthy();
});

// ---- binding to a work item (Ruling 11) ------------------------------------
//
// items.js links here as `new.html?item=<id>`; the card that started the
// session should end up owning it. Without this wiring the session comes
// back unbound and lands in 未归单 while the card still invites "开一个会话".

test("创建成功且带 item 参数时，用服务端返回的名字去绑定这个单", async () => {
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  const fetchImpl = (async (u: unknown, init?: RequestInit) => {
    const url = String(u);
    calls.push({ url, method: init?.method, body: init?.body as string | undefined });
    if (url.includes("api/sessions") && init?.method === "POST") {
      // The server de-duplicates; the returned name differs from the typed one
      // on purpose, so the test fails if the bind used the form value instead.
      return new Response(JSON.stringify({ name: "myproj-2" }), { status: 201 });
    }
    if (url.includes("/bind")) return new Response(JSON.stringify({ ok: true }));
    return stubFetch()(u as string);
  }) as typeof fetch;

  const root = await mount(fetchImpl, "/new.html?item=it-42");
  const nameField = [...root.querySelectorAll(".field")][1] as unknown as HTMLInputElement | undefined;
  if (nameField) nameField.value = "myproj";
  (root.querySelector(".btn.primary") as unknown as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 100));

  const bindCall = calls.find((c) => c.url.includes("/bind"));
  expect(bindCall?.url).toContain("api/items/it-42/bind");
  expect(bindCall?.method).toBe("POST");
  expect(JSON.parse(bindCall?.body ?? "{}")).toEqual({ session: "myproj-2" });
});

test("绑定失败时仍然导航到新会话，而不是拦在表单上", async () => {
  const fetchImpl = (async (u: unknown, init?: RequestInit) => {
    const url = String(u);
    if (url.includes("api/sessions") && init?.method === "POST") {
      return new Response(JSON.stringify({ name: "myproj-2" }), { status: 201 });
    }
    if (url.includes("/bind")) return new Response("no such item", { status: 404 });
    return stubFetch()(u as string);
  }) as typeof fetch;

  await mount(fetchImpl, "/new.html?item=gone");
  (document.querySelector(".btn.primary") as unknown as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 100));

  expect(String((globalThis as { location: Location }).location.href)).toContain(
    "terminal.html?target=myproj-2",
  );
});

test("没有 item 参数时，创建成功不会尝试绑定", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (u: unknown, init?: RequestInit) => {
    const url = String(u);
    calls.push(url);
    if (url.includes("api/sessions") && init?.method === "POST") {
      return new Response(JSON.stringify({ name: "myproj-2" }), { status: 201 });
    }
    return stubFetch()(u as string);
  }) as typeof fetch;

  await mount(fetchImpl, "/new.html");
  (document.querySelector(".btn.primary") as unknown as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 100));

  expect(calls.some((u) => u.includes("/bind"))).toBe(false);
});

/**
 * 单号必须扛得住这个页面自己改写 URL。
 *
 * syncUrl 每次浏览目录都会重写一遍 query，而它原来只把 `name` 和 `return` 带过去。
 * 它那条注释写明了存在的理由就是"中途刷新还知道自己要去哪"——那么漏掉 `item` 时，
 * 刷新之后会话照样建得出来，只是不挂在任何单下；首页是按单画的，看着像凭空消失。
 * 不刷新则碰巧没事，因为 itemId 是模块加载时读一次存在内存里的，所以这个 bug 只在
 * 刷新那一下现形。
 */
test("浏览目录后 URL 仍然带着 item", async () => {
  await mount(stubFetch(), "/new.html?item=it-1&name=%E7%94%B2");
  // 页面初始化时就会同步一次 URL（step/dir 都要落进去）。
  expect(location.search).toContain("item=it-1");

  const row = document.querySelector(".dir-row") as unknown as HTMLElement | null;
  row?.click();
  await new Promise((r) => setTimeout(r, 60));

  const params = new URLSearchParams(location.search);
  // 先证明 syncUrl 真的跑了：dir 只可能由它写进去。少了这一条，"item 还在"就可能
  // 只是因为 syncUrl 压根没执行、初始 URL 原封不动——那正是这个函数被局部变量
  // 遮蔽时的样子，测试会为了错误的理由变绿。
  expect(params.get("dir")).toBe("/tmp");
  expect(params.get("item")).toBe("it-1");
  // 原来就带得住的那两个不能因为这次改动坏掉。
  expect(params.get("name")).toBe("甲");
});

test("没有 item 时不会凭空写一个空的进去", async () => {
  await mount(stubFetch(), "/new.html");
  const row = document.querySelector(".dir-row") as unknown as HTMLElement | null;
  row?.click();
  await new Promise((r) => setTimeout(r, 60));
  expect(location.search).not.toContain("item=");
});

/**
 * 图标是运行时才炸的那一类改动。
 *
 * 页面文件不做类型检查（checkJs: false），而 `icon(...)` 少了 import 之后仍然是
 * 合法 JavaScript——tsc 看不到它，public-parses.test.ts 的 Bun.build 也看不到：
 * 缺的不是一个解析不了的模块，是一个不存在的全局。它只在浏览器真的走到那一行时
 * 才 ReferenceError。写这条测试的时候我已经踩过一次：new.js 的 import 就是漏的。
 *
 * CLAUDE.md 里"tr 被调用 25 次却没 import"是同一个坑的上一次发作。
 */
test("目录不存在时那行「新建」带图标，而不是运行时炸掉", async () => {
  const root = await mount();
  // happy-dom 的 Event 必须来自它自己那个 window：拿全局的那个构造出来的实例，
  // 它的 instanceof 检查不认。
  const view = (root as unknown as { ownerDocument: { defaultView: { Event: typeof Event } } })
    .ownerDocument.defaultView;
  const filter = root.querySelector(".field") as unknown as
    { value: string; dispatchEvent(e: Event): boolean };
  filter.value = "brand-new-dir";
  filter.dispatchEvent(new view.Event("input"));
  await new Promise((r) => setTimeout(r, 20));

  const make = root.querySelector(".dir-make");
  expect(make).not.toBeNull();
  expect(make!.querySelector("svg")).not.toBeNull();
  expect(make!.textContent).toContain("brand-new-dir");
});

// ---- 会话模板（Task 9） -----------------------------------------------------

test("带 ?item= 且有模板时，画出模板选择器", async () => {
  const doc = await mountNewPage({ search: "?item=it-1" });
  const chips = [...doc.querySelectorAll(".template-chip")].map((n) => n.textContent);
  expect(chips).toContain("不用模板");
  expect(chips).toContain("修 bug");
});

// 没有单就没有字段，每个占位符都会渲染成空——给一个必然产出空模板的选择器只是噪音。
test("没有 ?item= 时不画模板选择器", async () => {
  const doc = await mountNewPage({ search: "" });
  expect(doc.querySelector(".template-chip")).toBeNull();
});

test("选中一个模板，会话名和首条输入都被填上", async () => {
  const doc = await mountNewPage({ search: "?item=it-1" });
  const chip = [...doc.querySelectorAll(".template-chip")].find(
    (n) => n.textContent === "修 bug",
  ) as unknown as HTMLElement;
  chip.click();
  await Promise.resolve();
  await Promise.resolve();
  expect((doc.querySelector(".field.name-field") as unknown as HTMLInputElement).value).toBe("EXAMPLE-1");
  expect((doc.querySelector(".field.initial") as unknown as HTMLTextAreaElement).value).toBe("修 修登录页");
});

// 点模板 A、再点"不用模板"、A 的响应晚到：晚到的响应不能把已经清空、已经隐藏的
// 输入框重新填上——那样用户会在看不见首条输入框的情况下按下"创建"，一段他明确
// 拒绝过的文字就这样敲进了 agent 会话。见 pickTemplate 里 `chosenTemplate !== t.id`
// 那道守卫；这条测试专守它。
test("选模板后又选'不用模板'，晚到的模板响应不会把输入框重新填上", async () => {
  let resolveRender: (r: Response) => void = () => {};
  const renderPromise = new Promise<Response>((resolve) => { resolveRender = resolve; });
  const fetchImpl = (async (u: unknown) => {
    const url = String(u);
    if (url.includes("/render")) return renderPromise;
    if (url.includes("api/directories"))
      return new Response(JSON.stringify({ home: "/Users/x", recent: ["/tmp", "/srv"] }));
    if (url.includes("api/dirs")) return new Response(JSON.stringify(DIRS));
    if (url.includes("api/agents"))
      return new Response(JSON.stringify({
        agents: [{ id: "claude", label: "Claude Code", supportsSkipPermissions: true, available: true }],
      }));
    if (url.includes("api/language")) return new Response(JSON.stringify({ lang: "zh" }));
    if (url.includes("api/history")) return new Response(JSON.stringify({ conversations: [] }));
    if (url.includes("api/templates"))
      return new Response(JSON.stringify({
        templates: [{ id: "tpl-1", label: "修 bug", name: "{item.ref}", input: "修 {item.title}" }],
        fieldKeys: ["item.title", "item.ref"],
      }));
    return new Response("{}");
  }) as typeof fetch;

  const doc = await mountNewPage({ search: "?item=it-1", fetchImpl });

  const chipA = [...doc.querySelectorAll(".template-chip")].find(
    (n) => n.textContent === "修 bug",
  ) as unknown as HTMLElement;
  chipA.click(); // A 的请求已经发出，还没回来

  const chipNone = [...doc.querySelectorAll(".template-chip")].find(
    (n) => n.textContent === "不用模板",
  ) as unknown as HTMLElement;
  chipNone.click(); // 用户随即改主意，框应该已经清空并隐藏

  const initialField = doc.querySelector(".field.initial") as unknown as HTMLTextAreaElement;
  expect(initialField.value).toBe("");
  expect(initialField.style.display).toBe("none");

  // 现在放行 A 的响应
  resolveRender(new Response(JSON.stringify({ name: "EXAMPLE-1", input: "修 修登录页" })));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(initialField.value).toBe("");
  expect(initialField.style.display).toBe("none");
});

// ---- 插件声明的会话类型（"监察者搬到新建会话页"） --------------------------
//
// 内核不点名任何插件：这一组测试之所以能看到"监察者"这个选项，是因为
// plugins/supervisor/plugin.js 真的声明了 sessionKinds，而不是这里造了一份假
// 清单——跟 src/item-card.test.ts 用真实 registry.js 是同一个理由。

/** 让 stubFetch 的 api/plugins 答复启用了 supervisor 插件。 */
function withSupervisorEnabled(overrides: Record<string, unknown> = {}) {
  return stubFetch({ plugins: ["supervisor"], ...overrides });
}

test("已启用插件声明了会话类型时，画出「普通会话」加这一种类型", async () => {
  const root = await mount(withSupervisorEnabled());
  const chips = [...root.querySelectorAll(".kind-chip")].map((n) => n.textContent);
  expect(chips).toContain("普通会话");
  expect(chips).toContain("监察者");
});

test("没有插件声明会话类型时，不画这一组选择器", async () => {
  const root = await mount(stubFetch({ plugins: [] }));
  expect(root.querySelector(".kind-chip")).toBeNull();
});

test("插件被 TMUX_NEXT_DISABLE_PLUGINS 关掉时，它的会话类型也不出现", async () => {
  // /api/plugins 只答启用的 id；supervisor 不在里面就等于被关掉了。
  const root = await mount(stubFetch({ plugins: [] }));
  await new Promise((r) => setTimeout(r, 20));
  expect(root.querySelector(".kind-chip")).toBeNull();
});

test("选中一种插件会话类型后，普通会话才有意义的控件被隐藏，插件字段出现", async () => {
  const root = await mount(withSupervisorEnabled());
  await new Promise((r) => setTimeout(r, 20));

  const kindChip = [...root.querySelectorAll(".kind-chip")].find(
    (n) => n.textContent === "监察者",
  ) as unknown as HTMLElement;
  kindChip.click();

  // agentRow/skipRow/resumeEntry/templateRow 都嵌在同一个 .normal-fields 包裹
  // 里，选中一种插件类型时整包收起——单独查每个子元素自己的 style.display 测
  // 不出父级收起：子元素自己的内联样式没变，是被祖先的 display:none 连带隐藏的。
  const wrap = root.querySelector(".normal-fields") as unknown as HTMLElement;
  expect(wrap.style.display).toBe("none");
  expect(wrap.contains(root.querySelector(".agent-row") as unknown as Node)).toBe(true);
  expect(wrap.contains(root.querySelector(".skip-row") as unknown as Node)).toBe(true);
  expect(wrap.contains(root.querySelector(".resume-entry") as unknown as Node)).toBe(true);
  expect(wrap.contains(root.querySelector(".template-row") as unknown as Node)).toBe(true);

  // 插件字段：唯一一个 boolean 字段渲染成 checkbox。
  const fieldLabel = root.querySelector(".kind-fields label.check");
  expect(fieldLabel).not.toBeNull();
  expect(fieldLabel!.textContent).toContain("允许自动确认权限提示");
});

test("选回「普通会话」，隐藏掉的控件恢复", async () => {
  const root = await mount(withSupervisorEnabled());
  await new Promise((r) => setTimeout(r, 20));

  const chips = () => [...root.querySelectorAll(".kind-chip")];
  (chips().find((n) => n.textContent === "监察者") as unknown as HTMLElement).click();
  (chips().find((n) => n.textContent === "普通会话") as unknown as HTMLElement).click();

  expect((root.querySelector(".normal-fields") as unknown as HTMLElement).style.display).not.toBe("none");
  expect(root.querySelector(".kind-fields")!.childNodes.length).toBe(0);
});

test("选中插件会话类型后提交，POST 到该插件的 create-session 而不是 api/sessions", async () => {
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  const fetchImpl = (async (u: unknown, init?: RequestInit) => {
    const url = String(u);
    calls.push({ url, method: init?.method, body: init?.body as string | undefined });
    if (url.includes("api/supervisor/create-session")) {
      return new Response(JSON.stringify({ session: "supervisor-tmp" }), { status: 201 });
    }
    return withSupervisorEnabled()(u as string);
  }) as typeof fetch;

  const root = await mount(fetchImpl);
  await new Promise((r) => setTimeout(r, 20));

  const kindChip = [...root.querySelectorAll(".kind-chip")].find(
    (n) => n.textContent === "监察者",
  ) as unknown as HTMLElement;
  kindChip.click();

  const checkbox = root.querySelector(".kind-fields input[type=checkbox]") as unknown as HTMLInputElement;
  checkbox.checked = true;

  (root.querySelector(".btn.primary") as unknown as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 100));

  const call = calls.find((c) => c.url.includes("create-session"));
  expect(call).toBeTruthy();
  expect(call!.method).toBe("POST");
  const payload = JSON.parse(call!.body ?? "{}");
  expect(payload).toEqual({
    kind: "supervisor",
    dir: "/tmp",
    fields: { autoConfirmPermission: true },
  });
  expect(String((globalThis as { location: Location }).location.href)).toContain(
    "terminal.html?target=supervisor-tmp",
  );
});

test("插件会话类型提交遇到 409，展示「已经有一个了」而不是通用失败文案", async () => {
  const fetchImpl = (async (u: unknown, init?: RequestInit) => {
    const url = String(u);
    if (url.includes("api/supervisor/create-session") && init?.method === "POST") {
      return new Response(JSON.stringify({ error: "exists" }), { status: 409 });
    }
    return withSupervisorEnabled()(u as string);
  }) as typeof fetch;

  const root = await mount(fetchImpl);
  await new Promise((r) => setTimeout(r, 20));

  const kindChip = [...root.querySelectorAll(".kind-chip")].find(
    (n) => n.textContent === "监察者",
  ) as unknown as HTMLElement;
  kindChip.click();
  (root.querySelector(".btn.primary") as unknown as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 100));

  expect(root.querySelector(".sheet-error")?.textContent).toContain("已经有一个了");
});
