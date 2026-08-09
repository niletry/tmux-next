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

const PAGE = "/Users/lau/projects/tmux-next/public/new.js";

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
async function mount(fetchImpl = stubFetch()) {
  const win = new Window({ url: "http://127.0.0.1:7682/new.html" });
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
  for (const key of PATCHED) {
    if (key in globalThis) saved.set(key, (globalThis as Record<string, unknown>)[key]);
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
