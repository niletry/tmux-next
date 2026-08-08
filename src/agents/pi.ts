import { homedir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { readTailOf } from "./tail";

/**
 * pi's on-disk session layout.
 *
 * Close enough to Claude Code's that the tail-reading machinery is shared: one
 * JSONL file per session, under a directory named after the working directory.
 * What differs is the encoding of that directory name, and that pi has no
 * dedicated "last prompt" record — the answer is the newest user message.
 */

/** Overridable so tests never read the developer's own ~/.pi. */
function sessionRoot(): string {
  return process.env.PI_SESSION_ROOT || join(homedir(), ".pi", "agent", "sessions");
}

/**
 * The directory pi stores a working directory's sessions in.
 *
 * Lifted from pi's own `migrations.js`, which computes it as
 * `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--` and notes that
 * session-manager.ts is the authority. Reimplemented rather than guessed: an
 * earlier read of a single real directory would have suggested several rules
 * that all fit one sample.
 */
export function piSessionDir(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * A bare slash command — `/exit`, `/clear`, `/model sonnet`.
 *
 * These are instructions to the TUI, not descriptions of work, and the newest
 * user message in a finished session is very often one of them. Requiring a
 * space-free first token keeps `/tmp/foo 里的脚本跑不动` recognised as a task.
 */
const SLASH_COMMAND = /^\/[A-Za-z][\w-]*(\s|$)/;

/** Text of the newest user message in a chunk of transcript, if any. */
export function taskFromPiChunk(chunk: string): string | null {
  let found: string | null = null;
  for (const line of chunk.split("\n")) {
    if (!line.startsWith("{")) continue;
    let record: { type?: unknown; message?: { role?: unknown; content?: unknown } };
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a tail read opens mid-record
    }
    if (record.type !== "message") continue;
    const message = record.message;
    if (!message || message.role !== "user") continue;

    const parts = Array.isArray(message.content) ? message.content : [];
    const text = parts
      .filter((p): p is { text: string } => !!p && typeof p.text === "string")
      .map((p) => p.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text && !SLASH_COMMAND.test(text)) found = text;
  }
  return found;
}

/**
 * The task for a pi conversation.
 *
 * pi names its files `<timestamp>_<uuid>.jsonl`, so the id is a suffix rather
 * than the whole name and the directory has to be scanned. The scan is over one
 * working directory's sessions, not the whole store.
 */
export async function readPiTask(cwd: string, id: string): Promise<string | null> {
  const dir = join(sessionRoot(), piSessionDir(cwd));
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const match = names.find((n) => n.endsWith(`${id}.jsonl`) || n.includes(id));
  if (!match) return null;
  const chunk = await readTailOf(join(dir, match));
  return chunk === null ? null : taskFromPiChunk(chunk);
}
