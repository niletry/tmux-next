import { test, expect } from "bun:test";
// A browser module, but a `// @ts-check`ed one — its JSDoc types are real.
import { targetUrl, openTarget } from "../public/notification-target.js";

const SCOPE = "https://tmux.example.com/";
const SESSION_URL = SCOPE + "terminal.html?target=web-1";

/**
 * A fake WindowClient. `navigate` and `focus` are the two calls the real
 * handler makes, and both are the ones that fail on a backgrounded tab.
 */
function fakeWindow(
  url: string,
  opts: { navigateThrows?: boolean; focusReturnsNull?: boolean } = {},
) {
  const calls: string[] = [];
  const win = {
    url,
    calls,
    async navigate(next: string) {
      calls.push("navigate:" + next);
      if (opts.navigateThrows) throw new TypeError("client is not controlled");
      win.url = next;
      return win;
    },
    async focus() {
      calls.push("focus");
      return opts.focusReturnsNull ? null : win;
    },
  };
  return win;
}

function fakeClients(wins: unknown[]) {
  const opened: string[] = [];
  return {
    opened,
    async matchAll() {
      return wins;
    },
    async openWindow(url: string) {
      opened.push(url);
      return fakeWindow(url);
    },
  };
}

test("builds the terminal url for a session against the worker scope", () => {
  expect(targetUrl("web-1", SCOPE)).toBe(SESSION_URL);
});

test("escapes a session name that is not url-safe", () => {
  expect(targetUrl("a b&c", SCOPE)).toBe(SCOPE + "terminal.html?target=a%20b%26c");
});

test("falls back to the session list when the push carried no session", () => {
  expect(targetUrl(undefined, SCOPE)).toBe(SCOPE);
});

test("opens a new window when nothing is open", async () => {
  const clients = fakeClients([]);
  await openTarget(clients, SESSION_URL);
  expect(clients.opened).toEqual([SESSION_URL]);
});

test("focuses a window already showing the session without navigating it", async () => {
  const win = fakeWindow(SESSION_URL);
  const clients = fakeClients([win]);

  await openTarget(clients, SESSION_URL);

  expect(win.calls).toEqual(["focus"]);
  expect(clients.opened).toEqual([]);
});

test("navigates an open window that is showing something else", async () => {
  const win = fakeWindow(SCOPE);
  const clients = fakeClients([win]);

  await openTarget(clients, SESSION_URL);

  expect(win.calls).toEqual(["navigate:" + SESSION_URL, "focus"]);
  expect(clients.opened).toEqual([]);
});

// The bug this module exists for: the browser is in the background, its tab is
// frozen, and navigate() rejects. The old handler swallowed that, focused the
// dead client anyway and returned — so openWindow was unreachable and the tap
// did nothing at all.
test("opens a new window when the only open one refuses to navigate", async () => {
  const win = fakeWindow(SCOPE, { navigateThrows: true });
  const clients = fakeClients([win]);

  await openTarget(clients, SESSION_URL);

  expect(clients.opened).toEqual([SESSION_URL]);
});

test("opens a new window when focusing the open one does nothing", async () => {
  const win = fakeWindow(SCOPE, { focusReturnsNull: true });
  const clients = fakeClients([win]);

  await openTarget(clients, SESSION_URL);

  expect(clients.opened).toEqual([SESSION_URL]);
});

test("tries the next window before giving up on the whole list", async () => {
  const dead = fakeWindow(SCOPE, { navigateThrows: true });
  const live = fakeWindow(SCOPE);
  const clients = fakeClients([dead, live]);

  await openTarget(clients, SESSION_URL);

  expect(live.calls).toEqual(["navigate:" + SESSION_URL, "focus"]);
  expect(clients.opened).toEqual([]);
});

test("survives a worker with no openWindow at all", async () => {
  const clients = { async matchAll() { return []; } };
  await openTarget(clients, SESSION_URL);
});
