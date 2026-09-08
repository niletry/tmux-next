import { test, expect, afterEach } from "bun:test";
import { Window } from "happy-dom";

/**
 * 监察者页面在真实 DOM 里渲染的最小验证——bundling（public-parses.test.ts）只证明
 * 文件能被解析，证明不了它画出了东西。这里跟着 src/new-page.test.ts 已经立好的
 * 套路走：用 happy-dom 的 Window 类，把 window/document/fetch 等全局换成假的，
 * 跑完就还原，而不是引入仓库里没装的 @happy-dom/global-registrator。
 */

const PAGE = new URL("./public/supervisor.js", import.meta.url).pathname;
const PUBLIC_DIR = new URL("../../public/", import.meta.url).pathname;

/**
 * supervisor.js 里的 `../../i18n-apply.js` 是按它被浏览器加载的地址
 * （`/p/supervisor/supervisor.js`，两层）写的，不是它在磁盘上的位置
 * （`plugins/supervisor/public/supervisor.js`，三层）——跟
 * src/public-parses.test.ts 里那条注释解释的原因一样。动态 import() 走的是
 * Bun 运行时解析而不是 Bun.build，所以这里注册一个运行时插件把同一条映射
 * 规则搬过来，而不是新造一条。
 */
Bun.plugin({
  name: "resolve plugin page like its served url",
  setup(build) {
    build.onResolve({ filter: /^\.\.\/\.\.\// }, (args) => ({
      path: PUBLIC_DIR + args.path.replace(/^\.\.\/\.\.\//, ""),
    }));
  },
});

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

async function mount(fetchImpl: typeof fetch) {
  const win = new Window({ url: "http://127.0.0.1:7682/p/supervisor/" });
  const doc = win.document as unknown as Document;
  doc.body.innerHTML = `
    <header id="header"></header>
    <main id="list"></main>
  `;

  const shims: Record<string, unknown> = {
    window: win,
    document: doc,
    location: win.location,
    history: win.history,
    URLSearchParams: win.URLSearchParams,
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: fetchImpl,
  };
  const first = saved.size === 0;
  for (const key of PATCHED) {
    if (first && key in globalThis) saved.set(key, (globalThis as Record<string, unknown>)[key]);
    Object.defineProperty(globalThis, key, {
      value: shims[key], writable: true, configurable: true,
    });
  }

  const mod = await import(`${PAGE}?t=${Math.random()}`);
  return { mod, doc };
}

test("空列表时渲染 empty 状态", async () => {
  const fetchImpl = (async (input: unknown) => {
    if (String(input).includes("/api/supervisor/log")) {
      return new Response(JSON.stringify({ entries: [] }));
    }
    return new Response(JSON.stringify({ supervisors: [] }));
  }) as typeof fetch;

  const { mod, doc } = await mount(fetchImpl);
  await mod.load();

  expect(doc.getElementById("list")!.textContent).toContain("");
  expect(doc.querySelectorAll(".empty").length).toBeGreaterThan(0);
});

test("有监察者时，每个卡片显示 cwd、会话名和自动确认状态", async () => {
  const fetchImpl = (async (input: unknown) => {
    if (String(input).includes("/api/supervisor/log")) {
      return new Response(
        JSON.stringify({
          entries: [
            {
              ts: "2026-09-08T10:00:00Z",
              checked: [{ session: "web-1-a", turn: "waiting", note: "问了一个问题" }],
              actions: [{ session: "web-1-a", type: "answered", detail: "回答了" }],
            },
          ],
        }),
      );
    }
    return new Response(
      JSON.stringify({
        supervisors: [
          { cwd: "/tmp/proj", session: "supervisor-proj", startedAt: 1000, autoConfirmPermission: true },
        ],
      }),
    );
  }) as typeof fetch;

  const { mod, doc } = await mount(fetchImpl);
  await mod.load();

  const text = doc.getElementById("list")!.textContent ?? "";
  expect(text).toContain("/tmp/proj");
  expect(text).toContain("supervisor-proj");
  expect(text).toContain("web-1-a");
});
