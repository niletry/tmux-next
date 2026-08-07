import { open } from "node:fs/promises";
import { join } from "node:path";
import { encodeProjectDir, historyDir } from "./claude-history";

/**
 * What each session is currently working on, for the list.
 *
 * The screen preview answers "what is on screen", which mid-task is usually
 * tool output scrolling past. Claude Code separately records a `last-prompt`
 * entry in the transcript holding the latest thing it was asked to do, and that
 * is the better answer to "what is this session working on".
 *
 * A top-level field rather than the nested message content, so no walking of
 * content arrays and no exposure to how tool calls are shaped.
 */

/**
 * How much of the transcript tail to read.
 *
 * Measured, not guessed: across the 192 transcripts on the development machine
 * (median 259 KB, largest 68 MB) a 32 KB tail found the record in 94.8% of
 * them, and 128 KB found no more — the remainder are old sessions that never
 * wrote one. Reading the tail is what keeps the session list cheap; the same
 * probe put tool-call extraction at 66% even here, which is why this module
 * deliberately does not attempt it.
 */
export const TAIL_BYTES = 32 * 1024;

/**
 * The most recent usable `last-prompt` in a chunk of transcript.
 *
 * Tolerant by construction: a tail read starts mid-record, so the first line is
 * normally a fragment, and any line may be malformed if a write was interrupted.
 * Both are skipped rather than treated as failure.
 */
export function lastPromptFrom(chunk: string): string | null {
  let found: string | null = null;
  for (const line of chunk.split("\n")) {
    if (!line.startsWith("{")) continue;
    let record: { type?: unknown; lastPrompt?: unknown };
    try {
      record = JSON.parse(line);
    } catch {
      continue; // truncated or interleaved write
    }
    if (record.type !== "last-prompt") continue;
    if (typeof record.lastPrompt !== "string") continue;
    // Newlines and runs of spaces would break the single-row layout the list
    // gives each session.
    const text = record.lastPrompt.replace(/\s+/g, " ").trim();
    if (text) found = text;
  }
  return found;
}

/** The last prompt in a transcript file, or null if there is none to read. */
export async function readLastPrompt(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return null; // no transcript: not every session is a Claude session
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, size - length));
    return lastPromptFrom(buffer.toString("utf8"));
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Locates a conversation's transcript from its id and working directory.
 *
 * Claude Code files transcripts under a directory named after the cwd, so both
 * are needed; the binding record written by the SessionStart hook carries them.
 */
export function transcriptPath(cwd: string, id: string): string {
  return join(historyDir(), encodeProjectDir(cwd), `${id}.jsonl`);
}
