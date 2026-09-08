import { test, expect, afterEach, beforeAll } from "bun:test";
import { Window } from "happy-dom";

/**
 * 监察者页面在真实 DOM 里渲染的最小验证——bundling（public-parses.test.ts）只证明
 * 文件能被解析，证明不了它画出了东西。这里跟着 src/new-page.test.ts 已经立好的
 * 套路走：用 happy-dom 的 Window 类，把 window/document/fetch 等全局换成假的，
 * 跑完就还原，而不是引入仓库里没装的 @happy-dom/global-registrator。
 */

const PAGE = new URL("./public/supervisor.js", import.meta.url).pathname;
const PUBLIC_DIR = new URL("../../public/", import.meta.url).pathname;
const SUPERVISOR_PUBLIC_DIR = new URL("./public/", import.meta.url).pathname;

/**
 * supervisor.js 里的 `../../i18n-apply.js` 是按它被浏览器加载的地址
 * （`/p/supervisor/supervisor.js`，两层）写的，不是它在磁盘上的位置
 * （`plugins/supervisor/public/supervisor.js`，三层）——跟
 * src/public-parses.test.ts 里那条注释解释的原因一样。动态 import() 走的是
 * Bun 运行时解析而不是 Bun.build，所以这里注册一个运行时插件把同一条映射
 * 规则搬过来，而不是新造一条。
 *
 * Bun 插件是进程级的，整个 suite 共用一个进程：不按 importer 过滤会让任何
 * 别的测试文件里以 `../../` 开头的动态 import() 都被悄悄改道——跟这仓库里
 * 那次 fetch 被整体换掉、拖垮 38 个无关测试是同一类跨文件污染。只在
 * importer 确实是这个插件页面自己时才接管，其余一律返回 undefined 交回默认
 * 解析。
 */
Bun.plugin({
  name: "resolve supervisor page like its served url",
  setup(build) {
    build.onResolve({ filter: /^\.\.\/\.\.\// }, (args) => {
      if (!args.importer.startsWith(SUPERVISOR_PUBLIC_DIR)) return undefined;
      return { path: PUBLIC_DIR + args.path.replace(/^\.\.\/\.\.\//, "") };
    });
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

  // 语言钉死在 en：i18n-apply.js 的当前语言是模块级状态，同一个进程里别的页面
  // 测试可能把它设成 zh，而 import 缓存让那份状态跨文件活着——现在只是碰巧落在
  // 默认值上。不显式设一次，这里的断言就取决于哪个文件先跑，参见
  // src/item-card.test.ts / src/items-page.test.ts 的同一处理。
  const { applyLang } = await import(`${PUBLIC_DIR}i18n-apply.js`);
  applyLang("en");

  const mod = await import(`${PAGE}?t=${Math.random()}`);
  return { mod, doc };
}

// IMPORTANT 4 的回归测试：/api/supervisor 200 但 body 形状不对（没有
// supervisors，或不是数组）曾经会让 load() 里 supervisors.length 的读取抛出，
// 使整个 Promise 链 reject、replaceChildren 永远不跑——页面（包括创建表单）
// 整体空白。现在应该退化成"创建表单 + 空列表"。
test("supervisors 接口返回形状不对时，页面仍然渲染创建表单和空状态", async () => {
  const fetchImpl = (async (input: unknown) => {
    if (String(input).includes("/api/supervisor/log")) {
      return new Response(JSON.stringify({ entries: [] }));
    }
    return new Response(JSON.stringify({})); // 200，但没有 supervisors 字段
  }) as typeof fetch;

  const { mod, doc } = await mount(fetchImpl);
  await mod.load();

  expect(doc.querySelector("form.supervisor-create")).not.toBeNull();
  expect(doc.getElementById("list")!.textContent).toContain("No supervisors yet");
});

test("空列表时渲染 empty 状态", async () => {
  const fetchImpl = (async (input: unknown) => {
    if (String(input).includes("/api/supervisor/log")) {
      return new Response(JSON.stringify({ entries: [] }));
    }
    return new Response(JSON.stringify({ supervisors: [] }));
  }) as typeof fetch;

  const { mod, doc } = await mount(fetchImpl);
  await mod.load();

  expect(doc.getElementById("list")!.textContent).toContain("No supervisors yet");
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

// CRITICAL 1 的回归测试：log 路由 200 但body 形状不对（没有 entries，或值不是
// 数组）不能让 supervisorCard 抛出——那会让 Promise.all 整体 reject，
// load() 里的 replaceChildren 就永远不会跑，整页空白，而不是这一张卡退化成
// 空巡检状态。同一次 load 里还有一个正常的监察者，用来证明一张坏卡片不会
// 拖垮其他卡片的渲染。
test("巡检记录接口返回形状不对时，这张卡退化为空状态，其他卡不受影响", async () => {
  const fetchImpl = (async (input: unknown) => {
    const u = String(input);
    if (u.includes("cwd=%2Ftmp%2Fbad")) {
      return new Response(JSON.stringify({ error: "boom" })); // 200，但没有 entries
    }
    if (u.includes("/api/supervisor/log")) {
      return new Response(JSON.stringify({ entries: [] }));
    }
    return new Response(
      JSON.stringify({
        supervisors: [
          { cwd: "/tmp/bad", session: "supervisor-bad", startedAt: 1000, autoConfirmPermission: false },
          { cwd: "/tmp/good", session: "supervisor-good", startedAt: 2000, autoConfirmPermission: false },
        ],
      }),
    );
  }) as typeof fetch;

  const { mod, doc } = await mount(fetchImpl);
  await mod.load();

  const cards = doc.querySelectorAll(".card");
  expect(cards.length).toBe(2);
  const text = doc.getElementById("list")!.textContent ?? "";
  expect(text).toContain("/tmp/bad");
  expect(text).toContain("supervisor-bad");
  expect(text).toContain("/tmp/good");
  expect(text).toContain("supervisor-good");
  expect(doc.querySelectorAll(".empty").length).toBeGreaterThan(0);
});
