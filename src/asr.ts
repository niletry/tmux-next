import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, chmod } from "node:fs/promises";

/**
 * The speech-recognition credential, and nothing else.
 *
 * Voice input is optional: with no file here the microphone button is never
 * rendered, because a button that could only ever fail is worse than no button.
 *
 * The resource id is stored alongside the key rather than hard-coded at the
 * call site, so that pointing the same key at a newer model is a config edit
 * rather than a release.
 */
export const DEFAULT_RESOURCE_ID = "volc.bigasr.auc_turbo";

export type AsrConfig = { key: string; resourceId: string };

export function asrPath(): string {
  return process.env.TMUX_NEXT_ASR_PATH || join(homedir(), ".tmux-next", "asr.json");
}

/**
 * The stored credential, or null.
 *
 * Total: a missing file (the common case — most installs have no key), bad
 * JSON, or a file without a usable key all mean "voice input is off". None of
 * them is worth failing a page load over.
 */
export async function readAsrConfig(): Promise<AsrConfig | null> {
  try {
    const data = (await Bun.file(asrPath()).json()) as {
      key?: unknown;
      resourceId?: unknown;
    };
    const key = typeof data?.key === "string" ? data.key.trim() : "";
    if (!key) return null;
    const resourceId =
      typeof data?.resourceId === "string" && data.resourceId.trim()
        ? data.resourceId.trim()
        : DEFAULT_RESOURCE_ID;
    return { key, resourceId };
  } catch {
    return null;
  }
}

/** Stores a key; returns false for anything that could not be one. */
export async function writeAsrConfig(key: unknown): Promise<boolean> {
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (!trimmed) return false;
  const path = asrPath();
  // The directory exists in any real install, but a fresh machine may reach
  // this before anything else has written to ~/.tmux-next.
  await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
  await Bun.write(path, JSON.stringify({ key: trimmed, resourceId: DEFAULT_RESOURCE_ID }));
  // Unlike the rest of ~/.tmux-next, this file is a credential.
  await chmod(path, 0o600).catch(() => {});
  return true;
}

// --- forwarding to the recogniser -------------------------------------------

/**
 * The one-shot recognition endpoint: audio in, text out, no submit/query
 * polling. Measured at roughly a second of round trip for a couple of seconds
 * of speech.
 *
 * The browser cannot call this itself. Authentication with a single key only
 * works as the `X-Api-Key` header, and that header is not in the endpoint's
 * CORS allow-list — only the `X-Api-App-Key`/`X-Api-Access-Key` pair is. So the
 * audio comes here first. That turns out to be the better shape anyway: the key
 * never reaches a page, and there is one credential to configure instead of two.
 */
export const ASR_ENDPOINT =
  "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";

/** Injectable so tests assert what would be sent without a network. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type TranscribeResult =
  | { ok: true; text: string }
  | { ok: false; status: number; error: string };

/** The upstream code for a credential that is not accepted. */
const BAD_CREDENTIAL = "45000010";

/**
 * Sends one recording upstream and returns what was said.
 *
 * The audio is passed through untouched: the endpoint sniffs the container, so
 * whatever MediaRecorder produced on the phone (mp4/aac on older Safari,
 * webm/opus since 18.4) is accepted as-is and nothing needs transcoding.
 *
 * Failure is a return value rather than a throw, because every caller has to
 * turn it into an HTTP response anyway — and because "your key is wrong" and
 * "the service is unhappy" have completely different fixes, so they are worth
 * keeping apart.
 */
export async function transcribe(
  audio: ArrayBuffer,
  config: AsrConfig,
  requestId: string,
  fetchImpl: Fetch = fetch,
): Promise<TranscribeResult> {
  if (audio.byteLength === 0) return { ok: false, status: 400, error: "empty" };

  let res: Response;
  try {
    res = await fetchImpl(ASR_ENDPOINT, {
      method: "POST",
      headers: {
        "X-Api-Key": config.key,
        "X-Api-Resource-Id": config.resourceId,
        "X-Api-Request-Id": requestId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        user: { uid: "tmux-next" },
        audio: { data: Buffer.from(audio).toString("base64") },
        request: { model_name: "bigmodel" },
      }),
    });
  } catch {
    return { ok: false, status: 502, error: "network" };
  }

  const code = res.headers.get("x-api-status-code") ?? String(res.status);
  const message = res.headers.get("x-api-message") ?? "";

  // The endpoint answers 200 with the failure in a header, so the body is what
  // decides: text present means it worked, whatever the status line said.
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* a non-JSON body is simply an absent result */
  }
  const text = (body as { result?: { text?: unknown } } | null)?.result?.text;
  if (typeof text === "string") return { ok: true, text };

  if (code === BAD_CREDENTIAL) return { ok: false, status: 502, error: "credential" };
  return { ok: false, status: 502, error: message || code };
}
