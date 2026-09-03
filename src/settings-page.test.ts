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
        // PUT api/templates 学服务端的净化规则：label 为空的条目直接丢掉不存，
        // 回净化后的那一份——这是"保存后拿响应重画列表"这条修复要验的行为。
        if (href.includes("api/templates")) {
          const sent = JSON.parse(String(init.body ?? "{}")).templates ?? [];
          const clean = sent.filter((t: { label?: string }) => (t.label ?? "").trim() !== "");
          return new Response(JSON.stringify({ templates: clean }));
        }
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
      if (href.includes("api/templates")) {
        return new Response(JSON.stringify({
          templates: [{ id: "t1", label: "修 bug", name: "fix-{item.title}", input: "看看 {jira.summary}" }],
          fieldKeys: ["item.title", "item.id", "item.source", "item.agent", "item.sessions", "item.tag"],
        }));
      }
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
  // 内核四节（语言、终端配色、界面配色、虚拟按键），加上声明了 settings 的那个插件，
  // 再加上模板一节（它也要问服务端，跟插件几节一起晚一步到）。
  expect(heads.length).toBe(6);
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
  // 内核四节 + 模板一节（它跟 jira 设置是两条独立的请求，jira 答不上来不连累它）。
  expect(root.querySelectorAll(".settings-head").length).toBe(5);
  expect(root.querySelector(".settings-form")).toBeNull();
});

/**
 * 会话模板一节。
 *
 * 可用字段分两半：内核那几个由服务端跟模板一起下发（fetch 垫片里的 fieldKeys），
 * 插件那几个从 jira 清单自己声明的 fieldKeys 里来——这里没有断言任何一个插件名，
 * 断言的只是"两半都出现了"。
 */

test("模板一节列出已有模板", async () => {
  const doc = await mount();
  const labels = [...doc.querySelectorAll(".template-item input.settings-input")].map(
    (n) => (n as unknown as HTMLInputElement).value,
  );
  expect(labels).toContain("修 bug");
});

test("可用字段既有内核的也有插件的", async () => {
  const doc = await mount();
  const keys = [...doc.querySelectorAll(".template-key")].map((n) => n.textContent);
  expect(keys).toContain("{item.title}");   // 服务端下发的
  expect(keys).toContain("{jira.summary}"); // 插件清单里声明的
});

test("新建按钮多加一条", async () => {
  const doc = await mount();
  const before = doc.querySelectorAll(".template-item").length;
  (doc.querySelector(".template-new") as unknown as HTMLElement).click();
  expect(doc.querySelectorAll(".template-item").length).toBe(before + 1);
});

test("删除按钮少一条", async () => {
  const doc = await mount();
  const before = doc.querySelectorAll(".template-item").length;
  (doc.querySelector(".template-item .template-del") as unknown as HTMLElement).click();
  expect(doc.querySelectorAll(".template-item").length).toBe(before - 1);
});

// 服务端 sanitise() 会把 label 为空的条目直接丢掉不存（fetch 垫片照这条规则模拟）。
// 保存按钮以前只看 res.ok 就说"已保存"，那一行原样留在屏幕上——磁盘上其实已经
// 没有它了，界面在撒谎。修完之后保存要拿服务端吐回来的净化结果重画列表。
test("保存后，label 是空的那一行被服务端丢掉，界面跟着消失", async () => {
  const doc = await mount();
  (doc.querySelector(".template-new") as unknown as HTMLElement).click();
  const rows = [...doc.querySelectorAll(".template-item")];
  expect(rows.length).toBe(2);
  // 新加的第二行：只填会话名，故意不填模板名（label）。
  const secondInputs = rows[1]!.querySelectorAll("input.settings-input, textarea.settings-input");
  (secondInputs[1] as unknown as HTMLInputElement).value = "no-label-session";

  // 模板一节永远排在最后一节，它的保存按钮是文档里最后一个 .btn.primary——
  // jira 插件配置那一节的保存按钮也叫这个类名，不能靠类名单独选。
  const save = [...doc.querySelectorAll(".btn.primary")].at(-1) as unknown as HTMLElement;
  save.click();
  await new Promise((r) => setTimeout(r, 60));

  expect(doc.querySelectorAll(".template-item").length).toBe(1);
  const remaining = doc.querySelector(".template-item input.settings-input") as unknown as HTMLInputElement;
  expect(remaining.value).toBe("修 bug");
});

// 删除的那一行如果正握着"chip 插到哪"的焦点记忆，得放掉——不然点 chip 会在一个
// 已经脱离文档树的输入框上写 .value，既不报错也不生效，用户看到的就是"点了没
// 反应"，而且这个 bug 不会体现在任何一个既有断言里（都是数 DOM 节点数）。
test("删除正被记着焦点的那一行之后，点可用字段不会静默写到已经消失的输入框上", async () => {
  const doc = await mount();
  (doc.querySelector(".template-new") as unknown as HTMLElement).click();
  const rows = [...doc.querySelectorAll(".template-item")];
  const row2 = rows[1]!;
  const input2 = row2.querySelector("textarea.settings-input") as unknown as HTMLTextAreaElement;
  const before = input2.value;

  input2.dispatchEvent(new (globalThis as any).window.Event("focus", { bubbles: true }));
  (row2.querySelector(".template-del") as unknown as HTMLElement).click();

  // row2 连同它的输入框已经从文档里移走，点任意一个字段 chip 不该再改到它。
  (doc.querySelector(".template-key") as unknown as HTMLElement).click();
  expect(input2.value).toBe(before);
});

// 删光之后要把"还没有模板"那句放回来，否则这一节就剩一个空标题，看不出是
// "没有模板"还是"没画出来"。
test("删光所有模板，占位文案回来", async () => {
  const doc = await mount();
  (doc.querySelector(".template-item .template-del") as unknown as HTMLElement).click();
  expect(doc.querySelectorAll(".template-item").length).toBe(0);
  const notes = [...doc.querySelectorAll(".template-list .settings-note")];
  expect(notes.length).toBe(1);
  expect(notes[0]!.textContent).toBe("还没有模板");
});

// readers 数组跟 DOM 行的同步是这一节最容易出错的地方：把 readers.splice 那行
// 整个删掉，前面几条只数 DOM 节点数的测试也不会红一条。这条断言实际发出去的
// body——删掉中间一行之后，PUT 里既不带被删的那条，其余顺序也不受影响。
test("删掉中间一行再保存，PUT 的 body 不含被删的那条，其余顺序不变", async () => {
  const doc = await mount();
  (doc.querySelector(".template-new") as unknown as HTMLElement).click();
  (doc.querySelector(".template-new") as unknown as HTMLElement).click();
  const rows = [...doc.querySelectorAll(".template-item")];
  expect(rows.length).toBe(3);

  const setLabel = (row: any, val: string) => {
    (row.querySelector("input.settings-input") as unknown as HTMLInputElement).value = val;
  };
  setLabel(rows[1]!, "row-b");
  setLabel(rows[2]!, "row-c");

  (rows[1]!.querySelector(".template-del") as unknown as HTMLElement).click();

  const save = [...doc.querySelectorAll(".btn.primary")].at(-1) as unknown as HTMLElement;
  save.click();
  await new Promise((r) => setTimeout(r, 60));

  const req = posted.filter((p) => p.url.includes("api/templates")).at(-1)!;
  const labels = (JSON.parse(req.body).templates as Array<{ label: string }>).map((t) => t.label);
  expect(labels).toEqual(["修 bug", "row-c"]);
});
