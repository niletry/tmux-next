import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { lastPromptFrom, readLastPrompt, TAIL_BYTES } from "./claude-activity";

/**
 * What a session is working on, taken from its transcript.
 *
 * Claude Code writes a `last-prompt` record carrying the latest thing it was
 * asked to do. That is a better answer to "what is this session doing" than the
 * screen, which is usually mid-scroll through tool output.
 *
 * Read from the tail: transcripts run to tens of megabytes, and a probe over
 * the 192 on this machine put a 32 KB tail at 94.8% coverage — the remainder
 * are old sessions that never wrote the record at all, so a larger read buys
 * nothing.
 */

const line = (o: unknown) => JSON.stringify(o) + "\n";

test("takes the last prompt when several are present", () => {
  const text =
    line({ type: "last-prompt", lastPrompt: "first" }) +
    line({ type: "assistant", message: { content: [] } }) +
    line({ type: "last-prompt", lastPrompt: "second" });
  expect(lastPromptFrom(text)).toBe("second");
});

test("ignores a truncated first line", () => {
  // A tail read almost always starts mid-record; that fragment must not throw
  // and must not be mistaken for data.
  const text =
    '{"type":"last-prompt","lastPro' + "\n" + line({ type: "last-prompt", lastPrompt: "intact" });
  expect(lastPromptFrom(text)).toBe("intact");
});

test("returns null when the transcript has no such record", () => {
  expect(lastPromptFrom(line({ type: "assistant", message: { content: [] } }))).toBeNull();
});

test("returns null for empty or malformed input", () => {
  expect(lastPromptFrom("")).toBeNull();
  expect(lastPromptFrom("not json at all\n{also not\n")).toBeNull();
});

test("ignores a record whose prompt is not a usable string", () => {
  const text =
    line({ type: "last-prompt", lastPrompt: "good" }) +
    line({ type: "last-prompt", lastPrompt: "" }) +
    line({ type: "last-prompt", lastPrompt: 42 });
  // Later records are junk, so the last *usable* one stands.
  expect(lastPromptFrom(text)).toBe("good");
});

test("collapses whitespace so a multi-line prompt fits one row", () => {
  const text = line({ type: "last-prompt", lastPrompt: "  fix\n\n  the   thing  " });
  expect(lastPromptFrom(text)).toBe("fix the thing");
});

test("reads only the tail of a large file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "activity-"));
  const path = join(dir, "big.jsonl");
  // A prompt near the start must NOT win: it is outside the tail window, which
  // is the whole point of reading from the end.
  const filler = line({ type: "assistant", message: { content: [] } }).repeat(1);
  writeFileSync(
    path,
    line({ type: "last-prompt", lastPrompt: "ancient" }) +
      "x".repeat(TAIL_BYTES * 2) + "\n" +
      line({ type: "last-prompt", lastPrompt: "recent" }) +
      filler,
  );
  expect(await readLastPrompt(path)).toBe("recent");
});

test("a missing file reads as null rather than throwing", async () => {
  expect(await readLastPrompt(join(tmpdir(), "no-such-" + Math.random() + ".jsonl"))).toBeNull();
});

test("transcriptPath lands on the file Claude actually writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "projects-"));
  process.env.CLAUDE_PROJECTS_DIR = root;
  const { transcriptPath } = await import("./claude-activity");

  // Claude turns every `/` and `.` in the cwd into `-` for the folder name.
  expect(transcriptPath("/Users/you/projects/tmux-next", "abc-123")).toBe(
    join(root, "-Users-you-projects-tmux-next", "abc-123.jsonl"),
  );
});

test("readLastPrompt finds a transcript placed where transcriptPath says", async () => {
  const root = mkdtempSync(join(tmpdir(), "projects-"));
  process.env.CLAUDE_PROJECTS_DIR = root;
  const { transcriptPath: tp } = await import("./claude-activity");

  const cwd = "/tmp/some.project";
  const id = "11111111-2222-3333-4444-555555555555";
  const path = tp(cwd, id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, line({ type: "last-prompt", lastPrompt: "wire it up" }));

  expect(await readLastPrompt(path)).toBe("wire it up");
});
