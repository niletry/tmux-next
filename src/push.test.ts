import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowNotify,
  eventText,
  saveSubscription,
  notify,
  notifyLifecycle,
  validSubscription,
  RATE_LIMIT_MS,
  type PushEvent,
} from "./push";
import { bytesToB64url, type PushSubscription } from "./web-push";

test("allowNotify throttles chatty events but never the terminal one", () => {
  const last = new Map<string, number>();
  expect(allowNotify("waiting", "s", 1000, last)).toBe(true);
  expect(allowNotify("waiting", "s", 1000 + RATE_LIMIT_MS - 1, last)).toBe(false);
  expect(allowNotify("waiting", "s", 1000 + RATE_LIMIT_MS, last)).toBe(true);
  // A different session is independent.
  expect(allowNotify("attention", "other", 1000, last)).toBe(true);
  // "ended" is always allowed, and does not disturb the throttle window.
  expect(allowNotify("ended", "s", 1000 + RATE_LIMIT_MS, last)).toBe(true);
});

test("eventText names the session and describes the event", () => {
  // English is the default, matching the interface a new install serves.
  expect(eventText("waiting", "PROJ-1042")).toEqual({
    title: "PROJ-1042",
    body: "Finished — waiting on you",
  });
  expect(eventText("ended", "ES-7685").body).toBe("Session ended");
  expect(eventText("attention", "billing-ci").body).toBe("Needs your confirmation");
});

test("eventText follows the interface language", () => {
  // A push is the one piece of text that appears away from the interface, so a
  // Chinese interface with an English lock screen would be the odd one out.
  expect(eventText("waiting", "PROJ-1042", undefined, "zh").body).toBe("聊完了，在等你");
  expect(eventText("ended", "ES-7685", undefined, "zh").body).toBe("会话已结束");
  expect(eventText("attention", "billing-ci", undefined, "zh").body).toBe("需要你确认");
});

test("an agent's own message outranks the canned text in any language", () => {
  // Whatever the agent sent is more specific, and is already in the language it
  // chose to speak — translating around it would be worse, not better.
  for (const lang of ["en", "zh"]) {
    expect(eventText("attention", "billing-ci", "确认删除?", lang).body).toBe("确认删除?");
  }
});

test("validSubscription requires an https endpoint and both keys", () => {
  expect(validSubscription({ endpoint: "https://x/y", keys: { p256dh: "a", auth: "b" } })).toBe(true);
  expect(validSubscription({ endpoint: "http://x/y", keys: { p256dh: "a", auth: "b" } })).toBe(false);
  expect(validSubscription({ endpoint: "https://x", keys: { p256dh: "a" } })).toBe(false);
  expect(validSubscription(null)).toBe(false);
});

// --- notify against temp storage --------------------------------------------

let root: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "push-"));
  for (const k of ["TMUX_NEXT_PUSH_DIR", "TMUX_NEXT_VAPID_PATH", "TMUX_NEXT_NOTIFICATIONS_PATH"]) {
    saved[k] = process.env[k];
  }
  process.env.TMUX_NEXT_PUSH_DIR = join(root, "subs");
  process.env.TMUX_NEXT_VAPID_PATH = join(root, "vapid.json");
  process.env.TMUX_NEXT_NOTIFICATIONS_PATH = join(root, "notifications.jsonl");
});

afterEach(async () => {
  for (const k of ["TMUX_NEXT_PUSH_DIR", "TMUX_NEXT_VAPID_PATH", "TMUX_NEXT_NOTIFICATIONS_PATH"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(root, { recursive: true, force: true });
});

// A real subscription — encryptPayload does ECDH against p256dh, so it must be
// a genuine P-256 public key.
async function realSubscription(endpoint: string): Promise<PushSubscription> {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const p256dh = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { endpoint, keys: { p256dh: bytesToB64url(p256dh), auth: bytesToB64url(auth) } };
}

test("notify encrypts and sends to every stored subscription", async () => {
  await saveSubscription(await realSubscription("https://push.example.com/one"));

  const calls: { url: string; init: RequestInit }[] = [];
  const send = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(null, { status: 201 });
  };

  const res = await notify("ended", "sess-A", { nowMs: 1000, send });
  expect(res).toEqual({ skipped: false, sent: 1 });
  expect(calls[0]!.url).toBe("https://push.example.com/one");
  const headers = calls[0]!.init.headers as Record<string, string>;
  expect(headers["Content-Encoding"]).toBe("aes128gcm");
  expect(headers.Authorization).toStartWith("vapid t=");
});

test("notify drops a subscription the push service reports as gone", async () => {
  await saveSubscription(await realSubscription("https://push.example.com/dead"));
  const send = async () => new Response(null, { status: 410 });

  const res = await notify("ended", "sess-B", { nowMs: 2000, send });
  expect(res.sent).toBe(0);
  expect(await readdir(process.env.TMUX_NEXT_PUSH_DIR!)).toEqual([]); // file removed
});

test("notify reports skipped when rate-limited", async () => {
  await saveSubscription(await realSubscription("https://push.example.com/rl"));
  const send = async () => new Response(null, { status: 201 });

  const first = await notify("waiting", "sess-C", { nowMs: 5000, send });
  const second = await notify("waiting", "sess-C", { nowMs: 5001, send });
  expect(first.sent).toBe(1);
  expect(second).toEqual({ skipped: true, sent: 0 });
});

// --- notifyLifecycle ---------------------------------------------------------

test("notifyLifecycle titles the item, not any session", async () => {
  await saveSubscription(await realSubscription("https://push.example.com/item"));
  const send = async () => new Response(null, { status: 201 });

  const res = await notifyLifecycle("it-1", "修登录页", "in_review", { nowMs: 9000, send });
  expect(res).toEqual({ skipped: false, sent: 1 });
});

test("notifyLifecycle fires once per (item, target status) — no time window, just a seen-set", async () => {
  await saveSubscription(await realSubscription("https://push.example.com/item2"));
  const send = async () => new Response(null, { status: 201 });

  const first = await notifyLifecycle("it-2", "修登录页", "in_review", { nowMs: 1000, send });
  // A much later timestamp does not resurrect it — unlike allowNotify's window,
  // this dedup has no expiry: the state machine cannot re-enter the same
  // transition, so there is nothing to re-arm.
  const second = await notifyLifecycle("it-2", "修登录页", "in_review", { nowMs: 999_999, send });
  expect(first.sent).toBe(1);
  expect(second).toEqual({ skipped: true, sent: 0 });
});

test("notifyLifecycle treats each target status as its own event, and each item independently", async () => {
  await saveSubscription(await realSubscription("https://push.example.com/item3"));
  const send = async () => new Response(null, { status: 201 });

  const sameItemNextStatus = await notifyLifecycle("it-3", "修登录页", "in_merge", {
    nowMs: 1000,
    send,
  });
  const otherItemSameStatus = await notifyLifecycle("it-4", "别的单", "in_merge", {
    nowMs: 1000,
    send,
  });
  expect(sameItemNextStatus.sent).toBe(1);
  expect(otherItemSameStatus.sent).toBe(1);
});
