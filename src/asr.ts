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
