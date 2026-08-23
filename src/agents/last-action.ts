import { basename } from "node:path";
import { readTailOf } from "./tail";
import { transcriptPath } from "../claude-activity";

/**
 * What a session did most recently, for the "last updated" line on its card.
 *
 * The list used to show a relative time stamped by content diffing, which is
 * honest but nearly contentless: a working session repaints constantly, so it
 * read "just now" forever, and the number only carried information for an idle
 * one. What someone scanning the list actually wants is the pair — when, and
 * what — so this reads the pair out of the transcript instead of the screen.
 *
 * Anchoring to a tool call rather than a repaint also makes the timestamp
 * steady: a thirty-second `bun test` is one action, not thirty frames.
 */

/** The kinds a card can label. Deliberately few — this is a glanceable line. */
export type ActionKind = "edit" | "read" | "run" | "search" | "web" | "task" | "other";

export type LastAction = {
  kind: ActionKind;
  /** The one short thing the action was pointed at, or null when unknowable. */
  target: string | null;
  epoch: number;
};

/**
 * Tool name to kind.
 *
 * Names not listed fall to "other" and carry the tool's own name as the target,
 * which is what keeps MCP tools — whose names this table cannot know ahead of
 * time — from vanishing off the card.
 */
const KINDS: Record<string, ActionKind> = {
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Read: "read",
  Bash: "run",
  BashOutput: "run",
  Grep: "search",
  Glob: "search",
  WebFetch: "web",
  WebSearch: "web",
  Task: "task",
  Agent: "task",
};

/** Long enough to recognise a filename, short enough to share the meta row. */
const MAX_TARGET = 32;

function tidy(value: string): string | null {
  // A card gives this one row; a pasted heredoc or a multi-line description
  // would otherwise break the layout open.
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > MAX_TARGET ? flat.slice(0, MAX_TARGET - 1) + "…" : flat;
}

/** Words that get a command somewhere rather than being the thing it does. */
const SETUP = /^(cd|export|source|\.)$/;
/** A leading `VAR=value` — an environment assignment, not the program. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The program a shell command is actually about.
 *
 * Commands here routinely open with `cd <dir> &&` or `export PATH=…;` before
 * reaching the point, and naming the literal first word labelled most of the
 * transcript "ran cd". Each `&&`/`;`/`|` segment is tried in turn, skipping
 * setup words and environment assignments, and the first real program wins.
 *
 * If every segment is setup — `cd /srv/app` on its own — the first word is
 * still returned: an honest "cd" beats an empty cell.
 */
function programIn(command: string): string | null {
  const segments = command.trim().split(/&&|\|\||[;|]/);
  for (const segment of segments) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && (SETUP.test(words[i]!) || ASSIGNMENT.test(words[i]!))) {
      // A setup word swallows its argument; an assignment is one word.
      i += SETUP.test(words[i]!) ? 2 : 1;
    }
    if (i < words.length) return words[i]!;
  }
  return command.trim().split(/\s+/)[0] ?? null;
}

/**
 * The one short string worth showing for a tool call.
 *
 * Each branch picks the field a person would name the action by: the file, the
 * program, the pattern. A command is cut to its first word because "bun" is
 * what you recognise; the rest of the line is noise at this size.
 */
function targetOf(name: string, input: Record<string, unknown>): string | null {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : null);

  const path = str("file_path") ?? str("notebook_path");
  if (path) return tidy(basename(path));

  const command = str("command");
  if (command) {
    const program = programIn(command);
    return program ? tidy(program) : null;
  }

  const pattern = str("pattern") ?? str("query");
  if (pattern) return tidy(pattern);

  const url = str("url");
  if (url) {
    try {
      return tidy(new URL(url).hostname);
    } catch {
      return tidy(url);
    }
  }

  const description = str("description") ?? str("prompt");
  if (description) return tidy(description);

  // An unrecognised tool is still worth naming. MCP tools arrive as
  // `mcp__server__tool`; the last segment is the part that means something.
  if (!(name in KINDS)) {
    const segments = name.split("__");
    return tidy(segments[segments.length - 1] ?? name);
  }
  return null;
}

/** The last `tool_use` block in a record's content, if it has one. */
function toolUseIn(record: { message?: unknown }): { name: string; input: Record<string, unknown> } | null {
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return null;
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i] as { type?: unknown; name?: unknown; input?: unknown };
    if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
    const input = block.input;
    return {
      name: block.name,
      input: input && typeof input === "object" ? (input as Record<string, unknown>) : {},
    };
  }
  return null;
}

/**
 * The most recent tool call in a chunk of transcript.
 *
 * Tolerant by construction, exactly as `lastPromptFrom` is: a tail read starts
 * mid-record so the first line is normally a fragment, and any line may be
 * half-written if the read caught a flush. Both are skipped, never fatal.
 */
export function lastActionFrom(chunk: string): LastAction | null {
  let found: LastAction | null = null;
  for (const line of chunk.split("\n")) {
    if (!line.startsWith("{")) continue;
    let record: { type?: unknown; timestamp?: unknown; message?: unknown };
    try {
      record = JSON.parse(line);
    } catch {
      continue; // truncated or interleaved write
    }
    if (record.type !== "assistant") continue;
    if (typeof record.timestamp !== "string") continue;
    const parsed = Date.parse(record.timestamp);
    if (Number.isNaN(parsed)) continue;

    const call = toolUseIn(record);
    if (!call) continue;

    found = {
      kind: KINDS[call.name] ?? "other",
      target: targetOf(call.name, call.input),
      epoch: Math.floor(parsed / 1000),
    };
  }
  return found;
}

/** The last action in a session's transcript, or null if there is none to read. */
export async function readLastAction(cwd: string, id: string): Promise<LastAction | null> {
  const chunk = await readTailOf(transcriptPath(cwd, id));
  return chunk === null ? null : lastActionFrom(chunk);
}
