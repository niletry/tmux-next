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

const PAGE = "/Users/lau/projects/tmux-next/public/list.js";

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
    agent: "claude",
    agentLabel: "Claude Code",
    version: null,
    idle: false,
    pendingInput: null,
    preview: [],
    ...over,
  };
}

function stubFetch(sessions: unknown[]) {
  return (async (u: unknown) => {
    const url = String(u);
    if (url.includes("api/sessions")) return new Response(JSON.stringify(sessions));
    if (url.includes("api/restorable")) return new Response("[]");
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

async function mount(sessions: unknown[]) {
  const win = new Window({ url: "http://127.0.0.1:7682/index.html" });
  const doc = win.document;
  doc.body.innerHTML = '<header id="header"></header><main id="list"></main>';

  const shims: Record<string, unknown> = {
    window: win,
    document: doc,
    location: win.location,
    history: win.history,
    URLSearchParams: win.URLSearchParams,
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: stubFetch(sessions),
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
