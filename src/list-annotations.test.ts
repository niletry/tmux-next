import { test, expect, afterEach } from "bun:test";
import { Window } from "happy-dom";

/**
 * 会话列表渲染插件贴上来的标注。
 *
 * 两件事必须成立：list.js **不认识 "jira" 这个词**（认识了，接缝就白划了），
 * 以及标注文本永远走 textContent —— 插件不能往内核的列表里塞标记。
 */

const PAGE = "/Users/lau/projects/tmux-next/.claude/worktrees/jira-plugin/public/list.js";

const NOW = Math.floor(Date.now() / 1000);

// 照抄 src/list-page.test.ts 里的 session() 工厂，不重写一份。
function session(over: Record<string, unknown> = {}) {
  return {
    name: "orbit",
    windowWidth: 80,
    windowHeight: 24,
    lastActivityEpoch: NOW - 30,
    attached: false,
    pinned: false,
    claudeId: null,
    task: null,
    lastAction: null,
    path: "/Users/x/projects/app",
    agent: "claude",
    agentLabel: "Claude Code",
    version: null,
    idle: false,
    pendingInput: null,
    preview: [],
    ...over,
  };
}

function stubFetch(sessions: unknown[], annotations: unknown) {
  return (async (u: unknown) => {
    const url = String(u);
    if (url.includes("api/sessions")) {
      const body =
        annotations === undefined ? sessions : { sessions, annotations };
      return new Response(JSON.stringify(body));
    }
    if (url.includes("api/restorable")) return new Response(JSON.stringify([]));
    if (url.includes("api/language")) return new Response(JSON.stringify({ lang: "en" }));
    if (url.includes("api/version"))
      return new Response(JSON.stringify({ version: "0.0.0", build: "test" }));
    return new Response("{}");
  }) as typeof fetch;
}

const PATCHED = ["window", "document", "location", "history", "URLSearchParams",
  "localStorage", "fetch", "setInterval"] as const;
const saved = new Map<string, unknown>();
// Only the tests that call mount() touch globalThis at all — "list.js 的源码里
// 不出现任何具体插件的 id" reads the file straight off disk and never mounts.
// Without this flag, afterEach would still run its restore loop for that test,
// find `saved` empty (nothing was patched this round) and — since every
// PATCHED key not in `saved` is treated as "didn't exist before, delete it" —
// delete real globals like `fetch` and `URLSearchParams` that were never
// touched, breaking every other test file sharing this process.
let patched = false;

afterEach(() => {
  // 覆盖全局却不还原，曾经一次弄红了别的文件里 38 个测试——Bun 一个进程跑全部。
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

async function mount(sessions: unknown[], annotations: unknown) {
  const win = new Window({ url: "http://127.0.0.1:7682/index.html" });
  const doc = win.document;
  doc.body.innerHTML = '<header id="header"></header><main id="list"></main>';

  const store: Record<string, string> = {};
  const shims: Record<string, unknown> = {
    window: win,
    document: doc,
    location: win.location,
    history: win.history,
    URLSearchParams: win.URLSearchParams,
    localStorage: {
      getItem: (k: string) => (k in store ? store[k]! : null),
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    },
    fetch: stubFetch(sessions, annotations),
    // The page polls every five seconds; a live timer would outlast the test.
    setInterval: () => 0,
  };
  patched = true;
  for (const key of PATCHED) {
    if (key in globalThis) saved.set(key, (globalThis as Record<string, unknown>)[key]);
    Object.defineProperty(globalThis, key, {
      value: shims[key], writable: true, configurable: true,
    });
  }

  await import(`${PAGE}?t=${Math.random()}`);
  await new Promise((r) => setTimeout(r, 250));
  return doc as unknown as Document;
}

test("有标注的行显示标注文本", async () => {
  const doc = await mount(
    [session({ name: "修登录页" })],
    { jira: { 修登录页: { text: "EXAMPLE-1", detail: "登录页在窄屏下换行" } } },
  );
  const row = doc.querySelector(".card");
  expect(row?.textContent).toContain("EXAMPLE-1");
});

test("没有标注的行照常渲染", async () => {
  const doc = await mount([session({ name: "随便一个会话" })], {});
  expect(doc.querySelectorAll(".card").length).toBe(1);
});

test("annotations 整个缺失也不炸", async () => {
  // 插件全被禁用、或者服务端旧版本，都会走到这里。
  const doc = await mount([session({ name: "随便一个会话" })], undefined);
  expect(doc.querySelectorAll(".card").length).toBe(1);
});

test("标注里的标记被当成文字，不被解释", async () => {
  const doc = await mount(
    [session({ name: "修登录页" })],
    { jira: { 修登录页: { text: "<img src=x onerror=alert(1)>" } } },
  );
  expect(doc.querySelector(".card")?.innerHTML).not.toContain("<img");
  expect(doc.querySelector(".card")?.textContent).toContain("<img");
});

test("list.js 的源码里不出现任何具体插件的 id", async () => {
  // 内核不认识具体插件——这是接缝的方向，值得由测试守着而不是靠自觉。
  const source = await Bun.file(new URL("../public/list.js", import.meta.url).pathname).text();
  expect(source).not.toContain("jira");
  expect(source).not.toContain("gallery");
});
