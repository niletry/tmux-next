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
// checkout's copy instead. `list-annotations.test.ts` already resolves this
// way; this file just hadn't been touched since before worktrees were in use.
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
let posted: { url: string; body: string }[] = [];

function stubFetch(sessions: unknown[], restorable: unknown[] = [], items: unknown[] = []) {
  return (async (u: unknown, init?: RequestInit) => {
    const url = String(u);
    if (init?.method === "POST") {
      posted.push({ url, body: String(init.body ?? "") });
      if (url.includes("api/restore")) return new Response(JSON.stringify({ restored: 1 }));
    }
    // 新形状：{ sessions, items, annotations }。裸数组那条兼容分支留在 list.js 里，
    // 因为装成 PWA 的旧页面会打到新服务器，反过来也会。
    if (url.includes("api/sessions"))
      return new Response(JSON.stringify({ sessions, items, annotations: {} }));
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

afterEach(() => {
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
  for (const key of PATCHED) {
    if (key in globalThis) saved.set(key, (globalThis as Record<string, unknown>)[key]);
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

test("an idle session says how long it has been waiting on you", async () => {
  const root = await mount([
    session({ idle: true, lastAction: { kind: "run", target: "bun", epoch: NOW - 600 } }),
  ]);
  const text = timeText(root);
  expect(text).toContain("waiting");
  expect(text).toContain("10");
  // Not the "ran bun" phrasing: idle is the one state that asks for action.
  expect(text).not.toContain("ran");
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
