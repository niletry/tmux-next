import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";

/**
 * Reads Claude Code's own conversation history so a new session can resume a
 * past conversation instead of starting fresh.
 *
 * Claude stores one JSONL per conversation under
 * `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl`, grouped by the working
 * directory it ran in. `claude --resume <id>` is bound to that directory, so
 * candidates are always scoped to a chosen directory — never global.
 *
 * The files are append-only transcripts and can reach tens of megabytes, so
 * nothing here ever reads one whole: only a bounded head, and only for the few
 * most-recent conversations that will actually be shown.
 */

export function historyDir(): string {
  return process.env.CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects");
}

/**
 * The project-folder name Claude derives from a working directory: every `/`
 * and `.` becomes `-`. Verified against real folders (`/Users/you/projects/
 * tmux-next` ↔ `-Users-you-projects-tmux-next`).
 */
export function encodeProjectDir(dir: string): string {
  return dir.replace(/\/+$/, "").replace(/[/.]/g, "-");
}

/** `mtime` is epoch seconds, matching the list's relative-time convention. */
export type HistoryEntry = { id: string; title: string | null; mtime: number };

/** Only the head of a transcript is ever read — enough to reach the title. */
const MAX_HEAD_BYTES = 256 * 1024;

/** How many conversations the list offers, most recently touched first. */
const MAX_ENTRIES = 20;

/**
 * Pulls a display title and the recorded cwd out of a transcript's head.
 *
 * Title prefers the `ai-title` line (Claude's own summary of the conversation)
 * and falls back to the first real user message. The cwd is read from the first
 * record that carries one; it is the authoritative directory the conversation
 * belongs to, used to confirm the folder-name encoding actually matched.
 *
 * Pure over a already-bounded string so it can be tested without the disk.
 */
export function parseHistoryHead(text: string): { title: string | null; cwd: string | null } {
  let aiTitle: string | null = null;
  let firstUser: string | null = null;
  let cwd: string | null = null;

  for (const line of text.split("\n")) {
    if (!line) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      // A truncated last line from the byte cap, or a malformed row — skip it.
      continue;
    }

    if (cwd === null && typeof rec?.cwd === "string" && rec.cwd) cwd = rec.cwd;

    if (aiTitle === null && rec?.type === "ai-title" && typeof rec.aiTitle === "string") {
      const t = rec.aiTitle.trim();
      if (t) aiTitle = t;
    }

    if (firstUser === null && rec?.type === "user" && rec?.message?.role === "user") {
      const text = userText(rec.message.content);
      if (text) firstUser = text;
    }
  }

  return { title: aiTitle ?? firstUser, cwd };
}

/** Message content is either a plain string or an array of blocks. */
function userText(content: unknown): string | null {
  if (typeof content === "string") {
    const t = content.trim();
    return t || null;
  }
  if (Array.isArray(content)) {
    const t = content
      .filter((b): b is { type: string; text: string } => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join(" ")
      .trim();
    return t || null;
  }
  return null;
}

/** Reads at most the first MAX_HEAD_BYTES of a file as text. */
async function readHead(path: string): Promise<string> {
  return await Bun.file(path).slice(0, MAX_HEAD_BYTES).text();
}

/**
 * The most recent resumable conversations for a directory, newest first.
 *
 * Cheap first: stat every transcript and keep only the newest MAX_ENTRIES, then
 * read a head for just those — an old project with hundreds of conversations
 * never pays to parse the ones it won't show. A recorded cwd that disagrees
 * with the requested directory is dropped; a head too large to contain the cwd
 * is trusted to the folder it sits in rather than discarded.
 */
export async function listHistory(dir: string): Promise<HistoryEntry[]> {
  const folder = join(historyDir(), encodeProjectDir(dir));

  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return [];
  }

  const stated: { id: string; path: string; mtime: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(folder, name);
    try {
      const { mtimeMs } = await stat(path);
      stated.push({ id: name.slice(0, -".jsonl".length), path, mtime: Math.floor(mtimeMs / 1000) });
    } catch {
      // Vanished between readdir and stat — skip it.
    }
  }

  stated.sort((a, b) => b.mtime - a.mtime);
  const recent = stated.slice(0, MAX_ENTRIES);

  const entries = await Promise.all(
    recent.map(async ({ id, path, mtime }): Promise<HistoryEntry | null> => {
      let head: string;
      try {
        head = await readHead(path);
      } catch {
        return null;
      }
      const { title, cwd } = parseHistoryHead(head);
      if (cwd !== null && cwd !== dir) return null; // belongs to a different cwd
      return { id, title, mtime };
    }),
  );

  return entries.filter((e): e is HistoryEntry => e !== null);
}
