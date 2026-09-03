import { test, expect, afterEach } from "bun:test";
import { Window } from "happy-dom";

/**
 * The session list, driven in a real DOM.
 *
 * The time cell is the reason this file exists. It has three readings — waiting
 * on you, what it last did, and a bare fallback — chosen from two nullable
 * fields, and none of that is type-checked (list.js is not in checkJs). A
 * missing dictionary key or a null dereference here shows up as a blank cell in
 * the one place someone looks to decide which session to open, and every other
 * test in the suite would stay green.
 */

// Worktree-relative on purpose: a hardcoded absolute path here silently tests
// whatever checkout happens to sit at that path rather than this one — proven
// by editing public/list.js in this worktree into a syntax error and watching
// every test in this file still pass, because it was importing the main
// checkout's copy instead.
const PAGE = new URL("../public/list.js", import.meta.url).pathname;

const NOW = Math.floor(Date.now() / 1000);

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
    itemId: null,
    ...over,
  };
}

/** Bodies the page POSTed, so a test can assert on what it asked the server for. */
let posted: { url: string; body: string; method: string }[] = [];

function stubFetch(sessions: unknown[], restorable: unknown[] = [], items: unknown[] = []) {
  return (async (u: unknown, init?: RequestInit) => {
    const url = String(u);
    if (init?.method && init.method !== "GET") {
      posted.push({ url, body: String(init.body ?? ""), method: init.method });
      if (url.includes("api/restore")) return new Response(JSON.stringify({ restored: 1 }));
      if (url.includes("/bind")) return new Response(JSON.stringify({ ok: true }));
    }
    // 新形状：{ sessions, items }。裸数组那条兼容分支留在 list.js 里，因为装成 PWA
    // 的旧页面会打到新服务器，反过来也会。
    if (url.includes("api/sessions"))
      return new Response(JSON.stringify({ sessions, items }));
    // 会话卡上的单标记点开时问的那条：{item, sessions, facets}，跟
    // /api/items/:id 与 /api/items/by-session 的响应同一个形状。
    if (url.includes("api/items/"))
      return new Response(JSON.stringify({
        item: items[0] ?? null,
        sessions: [],
        facets: [{ dim: "jira.status", value: "In Review" }],
      }));
    if (url.includes("api/restorable")) return new Response(JSON.stringify(restorable));
    if (url.includes("api/language")) return new Response(JSON.stringify({ lang: "en" }));
    if (url.includes("api/version"))
      return new Response(JSON.stringify({ version: "0.0.0", build: "test" }));
    return new Response("{}");
  }) as typeof fetch;
}

const PATCHED = ["window", "document", "location", "history", "URLSearchParams",
  "localStorage", "fetch", "setInterval"] as const;
const saved = new Map<string, unknown>();
// Only the tests that call mount() touch globalThis at all — the source-only
// test at the bottom of this file (list.js 不出现插件 id) never does. Without
// this flag, afterEach would still run its restore loop for that test, find
// `saved` empty (nothing was patched this round) and — since every PATCHED key
// not in `saved` is treated as "didn't exist before, delete it" — delete real
// globals like `fetch` and `URLSearchParams` that were never touched, breaking
// every other test file sharing this process.
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

async function mount(
  sessions: unknown[],
  store: Record<string, string> = {},
  restorable: unknown[] = [],
  items: unknown[] = [],
) {
  posted = [];
  const win = new Window({ url: "http://127.0.0.1:7682/index.html" });
  const doc = win.document;
  doc.body.innerHTML = '<header id="header"></header><main id="list"></main>';

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
    fetch: stubFetch(sessions, restorable, items),
    // The page polls every five seconds; a live timer would outlast the test
    // and keep the process from exiting.
    setInterval: () => 0,
  };
  // 一个测试里 mount 两次时，globalThis 上放着的是**上一层 shim**；把它存进 saved
  // 就等于让 afterEach 把假 fetch 当原值还原，之后整个进程里所有文件的 fetch 都是
  // 假的。只有第一层才记录原值。（items-page.test.ts 踩过这个坑，全量红 97 个而
  // 单文件全绿。）
  const first = !patched;
  patched = true;
  for (const key of PATCHED) {
    if (first && key in globalThis) saved.set(key, (globalThis as Record<string, unknown>)[key]);
    Object.defineProperty(globalThis, key, {
      value: shims[key], writable: true, configurable: true,
    });
  }

  await import(`${PAGE}?t=${Math.random()}`);
  await new Promise((r) => setTimeout(r, 250));
  return doc.getElementById("list")!;
}

/**
 * Structural rather than `Element`: happy-dom's Element is its own type and is
 * not assignable to the DOM lib's, so naming the global here fails to compile
 * for a reason that has nothing to do with the test.
 */
type Queryable = { querySelector(selector: string): { textContent: string | null } | null };

const timeText = (root: Queryable) => root.querySelector(".time")?.textContent ?? "";

test("a card renders at all", async () => {
  const root = await mount([session()]);
  expect(root.querySelector(".name")?.textContent).toBe("orbit");
});

test("the time cell names what the session last did", async () => {
  const root = await mount([
    session({ lastAction: { kind: "edit", target: "list.js", epoch: NOW - 180 } }),
  ]);
  const text = timeText(root);
  expect(text).toContain("list.js");
  expect(text).toContain("changed");
  // The when is still there alongside the what.
  expect(text).toContain("3");
});

/**
 * 等你回话的会话：状态格里一个沙漏加一个数字，而不是"等待你的回复"加右边一格
 * "等你 10 分钟"——两格说同一件事，加起来吃掉半行。
 */
test("an idle session says how long it has been waiting on you", async () => {
  const root = await mount([
    session({ idle: true, lastAction: { kind: "run", target: "bun", epoch: NOW - 600 } }),
  ]);
  const state = root.querySelector(".state") as unknown as HTMLElement;
  expect(state).toBeTruthy();
  expect(state.querySelector("svg")).toBeTruthy();
  expect(state.textContent).toContain("10");
  // 词没消失，进了 title / aria-label。
  expect(state.getAttribute("title")).toContain("waiting");
  expect(state.getAttribute("aria-label")).toBe(state.getAttribute("title"));
  // 右边那一格整个不画了，而不是画一个空的——它带 margin-left:auto，空着也占位。
  expect(root.querySelector(".time")).toBeNull();
  // Not the "ran bun" phrasing: idle is the one state that asks for action.
  expect(state.textContent).not.toContain("ran");
});

// 干活中和有未发送输入：只有图标，词在 title 里；右边那格照旧说它在干什么。
// Claude 会话 UUID 的前缀也不画了：它长得像 git sha，实际是 transcript 文件名，
// 扫列表时没人读它。数据仍在（恢复挑选器要用），只是卡片这一行不画。
test("the card no longer prints the claude session id", async () => {
  const root = await mount([session({ claudeId: "10c14050-c895-477c-8625-f7d1d30b3a62" })]);
  expect(root.querySelector(".sid")).toBeNull();
  expect(root.textContent ?? "").not.toContain("10c14050");
});

// 版本号每张卡片都一样、一个月变不了两次，却占着 agent 名旁边最显眼的位置。
// 数据还在（后端照常给 session.version），只是这一行不再画它。
test("the agent badge no longer prints the version", async () => {
  const root = await mount([session({ agentLabel: "Claude Code", version: "2.1.258" })]);
  expect(root.querySelector(".agent")?.textContent).toBe("Claude Code");
  expect(root.querySelector(".agent-ver")).toBeNull();
  expect(root.textContent ?? "").not.toContain("2.1.258");
});

test("a working session shows an icon, not the word", async () => {
  const root = await mount([
    session({ lastAction: { kind: "edit", target: "list.js", epoch: NOW - 180 } }),
  ]);
  const state = root.querySelector(".state") as unknown as HTMLElement;
  expect(state.querySelector("svg")).toBeTruthy();
  expect((state.textContent ?? "").trim()).toBe("");
  expect(state.getAttribute("title")).toBe("Working");
  expect(timeText(root)).toContain("list.js");
});

test("a session holding unsent input says so in the title", async () => {
  const root = await mount([session({ pendingInput: "post 一下" })]);
  const state = root.querySelector(".state") as unknown as HTMLElement;
  expect(state.getAttribute("title")).toBe("unsent");
});

test("a session with no transcript falls back to a bare timestamp", async () => {
  const root = await mount([session({ lastAction: null, lastActivityEpoch: NOW - 7200 })]);
  const text = timeText(root);
  expect(text.length).toBeGreaterThan(0);
  expect(text).not.toContain("·");
});

test("an action with no nameable target does not print a dangling verb", async () => {
  const root = await mount([
    session({ lastAction: { kind: "run", target: null, epoch: NOW - 60 } }),
  ]);
  expect(timeText(root)).not.toContain("·");
});

test("an unknown tool keeps its own name in the cell", async () => {
  const root = await mount([
    session({ lastAction: { kind: "other", target: "AskUserQuestion", epoch: NOW - 60 } }),
  ]);
  expect(timeText(root)).toContain("AskUserQuestion");
});

/**
 * Grouping by project.
 *
 * The list is scanned to answer "which of my projects needs me", and a flat
 * run of session names does not answer it — two sessions on the same repo look
 * no more related than two on different machines. The directory is the only
 * thing that reliably says which project a session belongs to, and it now
 * arrives from tmux for every session rather than only the ones with a Claude
 * binding record.
 */

const headers = (root: Element) =>
  [...root.querySelectorAll(".group-name")].map((e) => e.textContent);

test("sessions in the same directory share one group", async () => {
  const root = await mount([
    session({ name: "a", path: "/srv/spec" }),
    session({ name: "b", path: "/srv/spec" }),
  ]);
  expect(headers(root as unknown as Element)).toEqual(["spec"]);
  expect(root.querySelectorAll(".card").length).toBe(2);
});

test("a group header names the directory and carries the full path", async () => {
  const root = await mount([session({ path: "/Volumes/work/orbit/orbit-spec" })]);
  const header = root.querySelector(".group-name")!;
  expect(header.textContent).toBe("orbit-spec");
  expect(header.getAttribute("title")).toBe("/Volumes/work/orbit/orbit-spec");
});

test("every project gets a header, including one holding a single session", async () => {
  const root = await mount([
    session({ name: "a", path: "/srv/one" }),
    session({ name: "b", path: "/srv/two" }),
  ]);
  expect(headers(root as unknown as Element).length).toBe(2);
});

test("pinned sessions are lifted out into their own section at the top", async () => {
  const root = await mount([
    session({ name: "pinned-one", path: "/srv/spec", pinned: true }),
    session({ name: "plain", path: "/srv/spec" }),
  ]);
  // Pinned leads, and the project group still exists for what stays behind.
  expect(headers(root as unknown as Element)).toEqual(["Pinned", "spec"]);

  const [pinnedSection, projectSection] = [...root.querySelectorAll(".group")];
  expect(pinnedSection!.textContent).toContain("pinned-one");
  expect(pinnedSection!.textContent).not.toContain("plain");
  // Lifted, not copied: the pinned session appears once on the page.
  expect(projectSection!.textContent).not.toContain("pinned-one");
  expect(root.querySelectorAll(".card").length).toBe(2);
});

test("groups are ordered by their most recent activity", async () => {
  const root = await mount([
    session({ name: "old", path: "/srv/stale", lastActivityEpoch: NOW - 9000 }),
    session({ name: "new", path: "/srv/live", lastActivityEpoch: NOW - 10 }),
  ]);
  expect(headers(root as unknown as Element)).toEqual(["live", "stale"]);
});

/**
 * Collapsing.
 *
 * With a project per group the page grows a heading for every checkout someone
 * has ever opened, and on a phone the one project being worked on ends up below
 * the fold. Collapsing is per device rather than per machine, for the same
 * reason font size is: it is a statement about this screen, not about the host.
 */

const COLLAPSE_KEY = "tmux-next.collapsed";

test("clicking a group heading collapses it", async () => {
  const root = await mount([session({ name: "a", path: "/srv/spec" })]);
  expect(root.querySelectorAll(".card").length).toBe(1);

  (root.querySelector(".group-head") as unknown as HTMLElement).click();
  // The toggle re-renders, which replaces the subtree — the old nodes are
  // detached, so the assertion has to look at the page again.
  await new Promise((r) => setTimeout(r, 100));
  expect(root.querySelectorAll(".card").length).toBe(0);
  expect(root.querySelector(".group-name")?.textContent).toBe("spec");
});

test("a collapsed group is remembered for the next render", async () => {
  const store: Record<string, string> = {};
  const root = await mount([session({ name: "a", path: "/srv/spec" })], store);
  (root.querySelector(".group-head") as unknown as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 100));
  expect(JSON.parse(store[COLLAPSE_KEY]!)).toContain("/srv/spec");
});

test("a group collapsed on a previous visit starts collapsed", async () => {
  const root = await mount([session({ name: "a", path: "/srv/spec" })], {
    [COLLAPSE_KEY]: JSON.stringify(["/srv/spec"]),
  });
  expect(root.querySelectorAll(".card").length).toBe(0);
  // The heading is still there — collapsed, not gone.
  expect(root.querySelector(".group-name")?.textContent).toBe("spec");
});

test("a collapsed heading says how many sessions it is hiding", async () => {
  const root = await mount(
    [session({ name: "a", path: "/srv/spec" }), session({ name: "b", path: "/srv/spec" })],
    { [COLLAPSE_KEY]: JSON.stringify(["/srv/spec"]) },
  );
  expect(root.querySelector(".group-count")?.textContent).toContain("2");
});

test("the heading reports its state to a screen reader", async () => {
  const root = await mount([session({ path: "/srv/spec" })], {
    [COLLAPSE_KEY]: JSON.stringify(["/srv/spec"]),
  });
  expect(root.querySelector(".group-head")?.getAttribute("aria-expanded")).toBe("false");
});

test("unreadable stored state does not stop the list rendering", async () => {
  const root = await mount([session({ name: "a", path: "/srv/spec" })], {
    [COLLAPSE_KEY]: "{{{ not json",
  });
  expect(root.querySelectorAll(".card").length).toBe(1);
});

/**
 * Picking what to restore.
 *
 * Restoring a session starts an agent process, so "restore" on 43 records is 43
 * processes at once. The banner used to be exactly that: one button, no way to
 * see what it would do or to want only some of it. The picker exists so the
 * expensive action has to be aimed.
 */

const RESTORABLE = [
  { session: "spec-a", id: "1", cwd: "/srv/spec" },
  { session: "spec-b", id: "2", cwd: "/srv/spec" },
  { session: "app-a", id: "3", cwd: "/srv/app" },
];

const openPicker = async (root: Element) => {
  (root.querySelector(".restore-btn") as unknown as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 50));
};

test("the restore banner offers a picker rather than restoring outright", async () => {
  const root = await mount([session()], {}, RESTORABLE);
  expect(root.querySelector(".restore-banner")).toBeTruthy();

  await openPicker(root as unknown as Element);
  expect(document.querySelector(".restore-sheet")).toBeTruthy();
  // Opening the picker must not have restored anything by itself.
  expect(posted.filter((p) => p.url.includes("api/restore"))).toHaveLength(0);
});

test("the restore banner sits below the sessions, not above them", async () => {
  // Restorable records are dead sessions from a past boot; the live ones are
  // what the page is for. Putting the banner first pushed the actual work
  // down the screen for a count that is only ever informational.
  const root = await mount([session()], {}, RESTORABLE);
  const classes = [...root.children].map((e) => e.className);
  expect(classes.filter((c) => c.includes("restore-banner"))).toHaveLength(1);
  expect(classes[classes.length - 1]).toContain("restore-banner");
});

test("the picker lists every restorable session, grouped by directory", async () => {
  const root = await mount([session()], {}, RESTORABLE);
  await openPicker(root as unknown as Element);

  const rows = [...document.querySelectorAll(".restore-row")].map((e) => e.textContent);
  expect(rows.join(" ")).toContain("spec-a");
  expect(rows.join(" ")).toContain("app-a");
  expect(rows).toHaveLength(3);

  const groups = [...document.querySelectorAll(".restore-group-name")].map((e) => e.textContent);
  expect(groups).toEqual(["spec", "app"]);
});

test("nothing is selected until you say so", async () => {
  const root = await mount([session()], {}, RESTORABLE);
  await openPicker(root as unknown as Element);

  const boxes = [...document.querySelectorAll<HTMLInputElement>(".restore-row input")];
  expect(boxes.every((b) => !b.checked)).toBe(true);
  // With nothing chosen there is nothing to do, and the button says so.
  expect(document.querySelector<HTMLButtonElement>(".restore-go")?.disabled).toBe(true);
});

test("restoring sends only the chosen sessions", async () => {
  const root = await mount([session()], {}, RESTORABLE);
  await openPicker(root as unknown as Element);

  const boxes = [...document.querySelectorAll<HTMLInputElement>(".restore-row input")];
  boxes[2]!.click(); // app-a
  await new Promise((r) => setTimeout(r, 20));

  const go = document.querySelector<HTMLButtonElement>(".restore-go")!;
  expect(go.disabled).toBe(false);
  go.click();
  await new Promise((r) => setTimeout(r, 100));

  const call = posted.find((p) => p.url.includes("api/restore"))!;
  expect(JSON.parse(call.body)).toEqual({ sessions: ["app-a"] });
});

test("a group's toggle selects that group and no other", async () => {
  const root = await mount([session()], {}, RESTORABLE);
  await openPicker(root as unknown as Element);

  (document.querySelectorAll(".restore-group-head")[0] as unknown as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 20));

  const boxes = [...document.querySelectorAll<HTMLInputElement>(".restore-row input")];
  expect(boxes.map((b) => b.checked)).toEqual([true, true, false]);
});

/**
 * The item a session is bound to.
 *
 * The kernel now knows which work item a session belongs to; this is the one
 * place that binding becomes visible to a person deciding which row to open.
 */

const ITEM = {
  id: "it-1",
  title: "把登录页的报错文案改掉",
  cwd: "/Users/x/projects/app",
  source: { provider: "jira", ref: "EXAMPLE-1" },
  tags: [],
  createdAt: NOW - 3600,
  closedAt: null,
};

test("绑了单的会话行上显示单标题", async () => {
  const root = await mount([session({ name: "orbit", itemId: "it-1" })], {}, [], [ITEM]);
  expect(root.querySelector(".item-chip")?.textContent).toContain("把登录页的报错文案改掉");
});

// 反向那一半：一条会话通往它那张单的入口。卡片主链接里塞不下一个按钮（button
// 嵌在 anchor 里既不合法，点它还会顺带把人送进终端页），所以它跟置顶、改挂、结束
// 一样是一个具名动作，两个入口都画——宽屏露动作行，窄屏露 ⋯，由 CSS 决定。
test("绑了单的会话，动作行和 ⋯ 里都有「查看这张单」", async () => {
  const root = await mount([session({ name: "orbit", itemId: "it-1" })], {}, [], [ITEM]);
  const inRow = [...root.querySelectorAll(".card-actions .card-act")]
    .map((b) => b.textContent);
  expect(inRow.some((text) => text?.includes("View the work item"))).toBe(true);

  (root.querySelector(".more") as unknown as HTMLElement).click();
  const inSheet = [...document.querySelectorAll(".sheet-menu .btn")].map((b) => b.textContent);
  expect(inSheet).toContain("View the work item");
});

test("没绑单的会话不给这个入口", async () => {
  const root = await mount([session({ name: "orbit", itemId: null })], {}, [], [ITEM]);
  const labels = [...root.querySelectorAll(".card-actions .card-act")].map((b) => b.textContent);
  expect(labels.some((text) => text?.includes("View the work item"))).toBe(false);
});

test("点「查看这张单」开出那张单的浮层", async () => {
  const root = await mount([session({ name: "orbit", itemId: "it-1" })], {}, [], [ITEM]);
  const view = [...root.querySelectorAll(".card-actions .card-act")]
    .find((b) => b.textContent?.includes("View the work item")) as unknown as HTMLElement;
  view.click();
  await new Promise((r) => setTimeout(r, 50));
  const panel = document.querySelector(".panel-backdrop")!;
  expect(panel).toBeTruthy();
  expect(panel.textContent).toContain("把登录页的报错文案改掉");
  expect(panel.textContent).toContain("In Review");
});

test("没绑单的会话不画标记，也不炸", async () => {
  const root = await mount([session({ name: "orbit", itemId: null })], {}, [], [ITEM]);
  expect(root.querySelector(".name")?.textContent).toBe("orbit");
  expect(root.querySelector(".item-chip")).toBeNull();
});

// 绑定指向一张已经归档并被清掉的单时，渲染不能抛——抛了会吞掉整页，而不是少一个标记。
test("itemId 指向一张不在 items 里的单时，当作没绑", async () => {
  const root = await mount([session({ name: "orbit", itemId: "it-gone" })], {}, [], [ITEM]);
  expect(root.querySelector(".name")?.textContent).toBe("orbit");
  expect(root.querySelector(".item-chip")).toBeNull();
});

// 内核不认识具体插件——这是接缝的方向，值得由测试守着而不是靠自觉。原先这条断言
// 挂在 list-annotations.test.ts（连同标注渲染一起），标注那条路径整条被 facet 接缝
// 取代后搬到这里：list.js 的源码里不能出现任何具体插件的 id。
test("list.js 的源码里不出现任何具体插件的 id", async () => {
  const source = await Bun.file(new URL("../public/list.js", import.meta.url).pathname).text();
  expect(source).not.toContain("jira");
  expect(source).not.toContain("gallery");
});

/**
 * 方向二：把一个会话挂到某张单下。
 *
 * 反方向在首页（src/items-page.test.ts 的「卡片上的关联按钮」几条），两边打的是
 * 同一个接口——所以这里盯的是**这一页有没有入口、请求的形状对不对**。
 */

const clickIt = (n: unknown) =>
  (n as { dispatchEvent: (e: unknown) => void } | null)?.dispatchEvent(
    new (globalThis as any).window.Event("click", { bubbles: true }),
  );

const workItem = (over: Record<string, unknown> = {}) => ({
  id: "it-1",
  title: "修登录页",
  source: null,
  tags: [],
  createdAt: NOW,
  closedAt: null,
  ...over,
});

async function openMenu(root: { querySelector(s: string): unknown }) {
  clickIt(root.querySelector(".more"));
  await new Promise((r) => setTimeout(r, 20));
}

test("⋯ 菜单里有挂到单下", async () => {
  const root = await mount([session()], {}, [], [workItem()]);
  await openMenu(root as never);
  const labels = [...document.querySelectorAll(".sheet-menu .btn")].map((b) => b.textContent);
  expect(labels).toContain("Link to a work item");
});

test("选一张单就 POST 到那张单的 bind 上，带的是这个会话名", async () => {
  const root = await mount([session({ name: "orbit" })], {}, [], [workItem()]);
  await openMenu(root as never);
  clickIt(document.querySelector(".sheet-menu .btn:nth-child(2)"));
  await new Promise((r) => setTimeout(r, 20));

  clickIt(document.querySelector(".pick-row"));
  await new Promise((r) => setTimeout(r, 60));

  const req = posted.find((p) => p.url.includes("/bind"));
  expect(req?.method).toBe("POST");
  expect(req?.url).toContain("api/items/it-1/bind");
  expect(JSON.parse(req!.body)).toEqual({ session: "orbit" });
});

/**
 * 菜单里按文字找那一格。
 *
 * 原先是 `.btn:nth-child(2)`——菜单里多一格（比如「查看这张单」只在挂着单时才画）
 * 就会指到别的动作上，而那种错位不会报错，只会让测试悄悄测了另一个按钮。
 */
function menuItem(text: string) {
  return [...document.querySelectorAll(".sheet-menu .btn")].find((b) => b.textContent === text);
}

// 已经挂着的会话，菜单上的字要变——「挂到单下」在这时候是句错话。
test("已经挂着时菜单说的是改挂，并且给解除", async () => {
  const root = await mount([session({ itemId: "it-1" })], {}, [], [workItem()]);
  await openMenu(root as never);
  const labels = [...document.querySelectorAll(".sheet-menu .btn")].map((b) => b.textContent);
  expect(labels).toContain("Move to another item");

  clickIt(menuItem("Move to another item"));
  await new Promise((r) => setTimeout(r, 20));
  expect(document.querySelector(".pick-row")?.className).toContain("current");
  expect(document.querySelector(".btn.danger")?.textContent).toBe("Unlink");
});

test("解除关联走 DELETE，按会话名", async () => {
  const root = await mount([session({ name: "orbit", itemId: "it-1" })], {}, [], [workItem()]);
  await openMenu(root as never);
  clickIt(menuItem("Move to another item"));
  await new Promise((r) => setTimeout(r, 20));
  clickIt(document.querySelector(".btn.danger"));
  await new Promise((r) => setTimeout(r, 60));

  const req = posted.find((p) => p.method === "DELETE");
  expect(req?.url).toContain("api/items/bind?session=orbit");
});

// 没挂东西的时候画一个"解除"按钮，等于让人怀疑自己是不是记错了。
test("没挂着的时候不画解除", async () => {
  const root = await mount([session()], {}, [], [workItem()]);
  await openMenu(root as never);
  clickIt(menuItem("Link to a work item"));
  await new Promise((r) => setTimeout(r, 20));
  expect(document.querySelector(".btn.danger")).toBeNull();
});

// 归档的单不该出现在候选里——挂上去等于把活会话塞进一个已经收起来的抽屉。
test("归档的单不列为候选", async () => {
  const root = await mount([session()], {}, [], [
    workItem(),
    workItem({ id: "it-2", title: "旧的", closedAt: NOW }),
  ]);
  await openMenu(root as never);
  clickIt(document.querySelector(".sheet-menu .btn:nth-child(2)"));
  await new Promise((r) => setTimeout(r, 20));
  const labels = [...document.querySelectorAll(".pick-label")].map((n) => n.textContent);
  expect(labels).toEqual(["修登录页"]);
});

test("一张单都没有时说清楚，而不是给一张空白纸", async () => {
  const root = await mount([session()], {}, [], []);
  await openMenu(root as never);
  clickIt(document.querySelector(".sheet-menu .btn:nth-child(2)"));
  await new Promise((r) => setTimeout(r, 20));
  expect(document.querySelector(".sheet-warn")?.textContent).toBe("No work items yet");
});

/**
 * 挑单的时候认的是单号。
 *
 * 标题是人话（"Gate the remaining ungated queries"），单号才是在 Jira、分支名、
 * PR 标题里到处出现的那个标识。
 */
test("候选单上带出 jira 单号", async () => {
  const root = await mount([session()], {}, [], [
    workItem({ id: "it-1", title: "Gate the queries", source: { provider: "jira", ref: "EXAMPLE-45943" } }),
    workItem({ id: "it-2", title: "本地随手记", source: null }),
  ]);
  await openMenu(root as never);
  clickIt(document.querySelector(".sheet-menu .btn:nth-child(2)"));
  await new Promise((r) => setTimeout(r, 20));

  const rows = [...document.querySelectorAll(".pick-row")];
  expect(rows[0]!.querySelector(".pick-note")?.textContent).toBe("EXAMPLE-45943");
  // 本地单没有来源，不该硬挤一个空的出来。
  expect(rows[1]!.querySelector(".pick-note")).toBeNull();
});

// 标题本身就以单号开头时再画一遍是噪音。
test("标题里已经含单号就不重复显示", async () => {
  const root = await mount([session()], {}, [], [
    workItem({ title: "[EXAMPLE-45943] Gate the queries", source: { provider: "jira", ref: "EXAMPLE-45943" } }),
  ]);
  await openMenu(root as never);
  clickIt(document.querySelector(".sheet-menu .btn:nth-child(2)"));
  await new Promise((r) => setTimeout(r, 20));
  expect(document.querySelector(".pick-note")).toBeNull();
});

/**
 * 卡片底部的动作行。
 *
 * CSS 决定它在窄屏藏起来、宽屏露出来，而 CSS 在无头环境里不排版——所以这里断言
 * 的是**它被画进了 DOM、内容是对的、点下去打的是对的接口**，宽度那一半交给
 * src/responsive.test.ts 盯断点。两边合起来才覆盖得住：只测 DOM 会漏掉"手机上
 * 也冒出来了"，只测断点会漏掉"按钮画错了"。
 *
 * ⋯ 必须同时还在。它是窄屏唯一的入口，而加动作行的时候最容易顺手把它删掉——
 * 删掉之后桌面上一切正常，手机上所有动作全部消失，且没有任何测试会红。
 */
test("卡片上有动作行，四个动作都在，⋯ 也还在", async () => {
  const root = await mount([session()], {}, [], []);
  const labels = [...root.querySelectorAll(".card-actions .card-act")].map((b) => b.textContent);
  expect(labels).toEqual(["Open", "Pin to top", "Link to a work item", "End session"]);
  expect(root.querySelector(".more")).not.toBeNull();
});

test("动作行的「打开」指向这个会话的终端", async () => {
  const root = await mount([session({ name: "orbit" })]);
  const open = root.querySelector(".card-act.primary") as unknown as { href: string };
  expect(open.href).toContain("terminal.html?target=orbit");
});

// 破坏性动作要跟另外三个分得开，靠的是它自己的 class——样式表按这个 class 把它
// 顶到右端并染红。class 掉了的话，「结束」会安静地混进安全动作里排在中间。
test("结束会话带 danger 标记", async () => {
  const root = await mount([session()]);
  const end = root.querySelector(".card-actions .card-act.danger");
  expect(end?.textContent).toBe("End session");
});

test("已置顶的会话，动作行说的是取消置顶", async () => {
  const root = await mount([session({ pinned: true })]);
  const labels = [...root.querySelectorAll(".card-actions .card-act")].map((b) => b.textContent);
  expect(labels).toContain("Unpin");
});

test("已挂单的会话，动作行说的是改挂", async () => {
  const root = await mount([session({ itemId: "it-1" })], {}, [], [workItem()]);
  const labels = [...root.querySelectorAll(".card-actions .card-act")].map((b) => b.textContent);
  expect(labels).toContain("Move to another item");
});

test("动作行的置顶打的是这个会话的 pin 接口", async () => {
  const root = await mount([session({ name: "orbit", pinned: false })]);
  clickIt(root.querySelector(".card-actions .card-act:nth-child(2)"));
  await new Promise((r) => setTimeout(r, 60));

  const req = posted.find((p) => p.url.includes("/pin"));
  expect(req?.method).toBe("POST");
  expect(req?.url).toContain("api/sessions/orbit/pin");
  expect(JSON.parse(req!.body)).toEqual({ pinned: true });
});

// 两个入口共用一份逻辑，所以浮层那边也得继续能用——抽函数最容易在这里断。
test("⋯ 浮层里的置顶仍然打同一个接口", async () => {
  const root = await mount([session({ name: "orbit" })]);
  await openMenu(root as never);
  clickIt(document.querySelector(".sheet-menu .btn"));
  await new Promise((r) => setTimeout(r, 60));

  const req = posted.find((p) => p.url.includes("/pin"));
  expect(req?.url).toContain("api/sessions/orbit/pin");
});

/**
 * 图标缺 import 是运行时才炸的一类错——页面文件不做类型检查，Bun.build 看到的
 * 也只是一个合法的全局引用。所以每个画图标的地方都要有一条真的去数 <svg> 的
 * 断言。（写这批的时候 new.js 就漏了一次 import。）
 */
test("分组标题有折叠箭头和文件夹两个图标", async () => {
  const root = await mount([session()]);
  expect(root.querySelector(".group-chevron svg")).not.toBeNull();
  expect(root.querySelector(".group-icon svg")).not.toBeNull();
});

test("动作行每个按钮都带图标，文字也还在", async () => {
  const root = await mount([session()]);
  const acts = [...root.querySelectorAll(".card-actions .card-act")];
  expect(acts.map((a) => Boolean(a.querySelector("svg")))).toEqual([true, true, true, true]);
  // 图标不替代文字：只留图标就是让人靠猜，而这一行四个动作里三个会改状态。
  expect(acts.map((a) => a.textContent?.trim())).toEqual([
    "Open", "Pin to top", "Link to a work item", "End session",
  ]);
});

test("⋯ 是图标而不是字形", async () => {
  const root = await mount([session()]);
  const more = root.querySelector(".more");
  expect(more?.querySelector("svg")).not.toBeNull();
  expect(more?.textContent?.trim()).toBe("");
});
