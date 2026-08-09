import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, unlink, mkdir } from "node:fs/promises";
import {
  generateVapidKeys,
  sendPush,
  type VapidKeys,
  type PushSubscription,
  type Fetch,
} from "./web-push";
import { recordNotification } from "./notifications";
import { t } from "../public/i18n.js";
import { readLanguage, DEFAULT_LANG } from "./language";

/**
 * Push notifications for Claude events: stores the VAPID identity and the
 * browser subscriptions on disk, maps events to notification text, rate-limits
 * the chatty ones, and fans a notification out to every subscription.
 */

/** RFC 8292 `sub`: a stable contact URI identifying this sender. */
const VAPID_SUBJECT = "https://github.com/niletry/tmux-next";

export type PushEvent = "waiting" | "ended" | "attention";

function vapidPath(): string {
  return process.env.TMUX_NEXT_VAPID_PATH || join(homedir(), ".tmux-next", "vapid.json");
}

function subscriptionsDir(): string {
  return process.env.TMUX_NEXT_PUSH_DIR || join(homedir(), ".tmux-next", "push-subscriptions");
}

// --- VAPID identity ---------------------------------------------------------

let cachedVapid: VapidKeys | null = null;

/** The VAPID keypair, generated and persisted on first use, then cached. */
export async function getVapid(): Promise<VapidKeys> {
  if (cachedVapid) return cachedVapid;
  const path = vapidPath();
  const file = Bun.file(path);
  if (await file.exists()) {
    cachedVapid = (await file.json()) as VapidKeys;
    return cachedVapid;
  }
  const keys = await generateVapidKeys();
  await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
  await Bun.write(path, JSON.stringify(keys));
  cachedVapid = keys;
  return keys;
}

// --- subscriptions ----------------------------------------------------------

/** A subscription is well-formed if it carries an https endpoint and both keys. */
export function validSubscription(v: unknown): v is PushSubscription {
  const s = v as PushSubscription;
  return (
    !!s &&
    typeof s.endpoint === "string" &&
    s.endpoint.startsWith("https://") &&
    !!s.keys &&
    typeof s.keys.p256dh === "string" &&
    typeof s.keys.auth === "string"
  );
}

/** One file per subscription, named by a hash of its endpoint (stable, safe). */
function subscriptionFile(endpoint: string): string {
  return join(subscriptionsDir(), `${Bun.hash(endpoint).toString(16)}.json`);
}

export async function saveSubscription(sub: PushSubscription): Promise<void> {
  await mkdir(subscriptionsDir(), { recursive: true }).catch(() => {});
  await Bun.write(subscriptionFile(sub.endpoint), JSON.stringify(sub));
}

type StoredSubscription = { sub: PushSubscription; file: string };

async function readSubscriptions(): Promise<StoredSubscription[]> {
  let names: string[];
  try {
    names = await readdir(subscriptionsDir());
  } catch {
    return [];
  }
  const out: StoredSubscription[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(subscriptionsDir(), name);
    try {
      const sub = (await Bun.file(file).json()) as unknown;
      if (validSubscription(sub)) out.push({ sub, file });
    } catch {
      // skip an unreadable / half-written file
    }
  }
  return out;
}

// --- rate limit -------------------------------------------------------------

/** The chatty events can't push more than once per session per this window. */
export const RATE_LIMIT_MS = 30_000;

/**
 * Whether a notification for `session` may go out now.
 *
 * `ended` is terminal and always allowed; `waiting`/`attention` are throttled
 * per session. Pure over a caller-owned `last` map so it is testable; the state
 * lives in the module for real use.
 */
export function allowNotify(
  event: PushEvent,
  session: string,
  nowMs: number,
  last: Map<string, number>,
): boolean {
  if (event === "ended") return true;
  const prev = last.get(session);
  if (prev !== undefined && nowMs - prev < RATE_LIMIT_MS) return false;
  last.set(session, nowMs);
  return true;
}

const lastNotify = new Map<string, number>();

// --- event text -------------------------------------------------------------

/** The notification a given event becomes: session name as title, event as body. */
export function eventText(
  event: PushEvent,
  session: string,
  message?: string,
  lang: string = DEFAULT_LANG,
): { title: string; body: string } {
  // The agent's own message wins when it sent one: it is more specific than
  // anything here, and it is already in whatever language the agent speaks.
  const body =
    event === "attention"
      ? message?.trim() || t("push.attention", lang)
      : t(event === "ended" ? "push.ended" : "push.waiting", lang);
  return { title: session, body };
}

/** The interface language, for text that leaves the browser entirely. */
async function notifyLang(): Promise<string> {
  return (await readLanguage()) ?? DEFAULT_LANG;
}

// --- notify -----------------------------------------------------------------

export type NotifyResult = { skipped: boolean; sent: number };

/**
 * Sends one event to every subscription, dropping any that the push service
 * reports as gone (404/410). `send` and `nowMs` are injectable for tests.
 */
export async function notify(
  event: PushEvent,
  session: string,
  opts: { message?: string; nowMs?: number; send?: Fetch } = {},
): Promise<NotifyResult> {
  const nowMs = opts.nowMs ?? Date.now();
  if (!allowNotify(event, session, nowMs, lastNotify)) return { skipped: true, sent: 0 };

  // Log it before delivery, so the history holds what happened even if there is
  // no subscription or the push fails — that is the whole point of the log.
  const { title, body } = eventText(event, session, opts.message, await notifyLang());
  await recordNotification({ ts: Math.floor(nowMs / 1000), event, session, title, body });

  const subs = await readSubscriptions();
  if (!subs.length) return { skipped: false, sent: 0 };

  const keys = await getVapid();
  const payload = { title, body, session, event };

  let sent = 0;
  for (const { sub, file } of subs) {
    try {
      const res = await sendPush(sub, keys, payload, VAPID_SUBJECT, nowMs, opts.send);
      if (res.status === 404 || res.status === 410) {
        await unlink(file).catch(() => {});
      } else {
        sent++;
      }
    } catch {
      // A single failed endpoint should not stop the others.
    }
  }
  return { skipped: false, sent };
}
