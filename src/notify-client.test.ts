import { test, expect } from "bun:test";
import { buildNotifyBody, buildRecordBody, notifyUrl } from "./notify-client";

/**
 * The logic every in-process extension shares.
 *
 * Claude Code's hooks are external shell scripts; opencode's and pi's are JS
 * modules running inside the agent. What they must agree on is the wire format
 * and the URL, so that lives here — one place, tested — instead of being
 * rewritten in each extension where a typo would fail silently.
 */

test("the notify URL honours the port override", () => {
  expect(notifyUrl(undefined)).toBe("http://127.0.0.1:7682/api/notify");
  expect(notifyUrl("9001")).toBe("http://127.0.0.1:9001/api/notify");
  // A junk value must not produce a URL pointing somewhere unintended.
  expect(notifyUrl("evil.com/x")).toBe("http://127.0.0.1:7682/api/notify");
  expect(notifyUrl("0")).toBe("http://127.0.0.1:7682/api/notify");
  expect(notifyUrl("70000")).toBe("http://127.0.0.1:7682/api/notify");
});

test("a notify body carries the event, session and optional message", () => {
  expect(buildNotifyBody("waiting", "ENG-1", undefined)).toEqual({
    event: "waiting",
    session: "ENG-1",
  });
  expect(buildNotifyBody("attention", "ENG-1", "needs approval")).toEqual({
    event: "attention",
    session: "ENG-1",
    message: "needs approval",
  });
  // Blank text is omitted rather than sent as an empty string, so the server's
  // "message is a non-empty string" check stays the only rule.
  expect(buildNotifyBody("waiting", "ENG-1", "   ")).toEqual({
    event: "waiting",
    session: "ENG-1",
  });
});

test("an unknown event or empty session yields nothing to send", () => {
  expect(buildNotifyBody("exploded", "ENG-1", undefined)).toBeNull();
  expect(buildNotifyBody("waiting", "", undefined)).toBeNull();
  expect(buildNotifyBody("waiting", "   ", undefined)).toBeNull();
});

test("a binding record names the agent that wrote it", () => {
  const body = buildRecordBody("pi", "abc-123", "sess", "/tmp/x");
  expect(body).toEqual({ agent: "pi", id: "abc-123", session: "sess", cwd: "/tmp/x" });
  // Without an id there is nothing to resume, so there is nothing worth writing.
  expect(buildRecordBody("pi", "", "sess", "/tmp/x")).toBeNull();
  expect(buildRecordBody("pi", "abc", "", "/tmp/x")).toBeNull();
});

test("web-* is never treated as a user session", () => {
  // The same trap the shell hooks fell into: tmux resolves a shared pane to the
  // mount point tmux-next created. An extension seeing that name must skip.
  expect(buildNotifyBody("waiting", "web-123-abcd", undefined)).toBeNull();
  expect(buildRecordBody("pi", "abc", "web-123-abcd", "/tmp")).toBeNull();
});
