import { test, expect } from "bun:test";
import { lastActionFrom, type ActionKind } from "./last-action";

/** One assistant record as Claude Code writes it, with a single tool call. */
function assistant(ts: string, name: string, input: Record<string, unknown>) {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: { content: [{ type: "tool_use", name, input }] },
  });
}

const T1 = "2026-08-23T04:00:50.920Z";
const T2 = "2026-08-23T04:00:59.022Z";

test("the last tool call in the tail is the one reported", () => {
  const chunk = [
    assistant(T1, "Read", { file_path: "/Users/x/projects/app/server.ts" }),
    assistant(T2, "Edit", { file_path: "/Users/x/projects/app/list.js" }),
  ].join("\n");

  expect(lastActionFrom(chunk)).toEqual({
    kind: "edit",
    target: "list.js",
    epoch: Math.floor(Date.parse(T2) / 1000),
  });
});

test("a file path is reduced to its basename", () => {
  const chunk = assistant(T1, "Read", { file_path: "/very/deep/tree/paths.ts" });
  expect(lastActionFrom(chunk)?.target).toBe("paths.ts");
});

test("a command is reduced to the program being run", () => {
  const chunk = assistant(T1, "Bash", { command: "bun test src/paths.test.ts" });
  expect(lastActionFrom(chunk)).toMatchObject({ kind: "run", target: "bun" });
});

test("tool names map onto the handful of kinds the card can show", () => {
  const cases: [string, Record<string, unknown>, ActionKind][] = [
    ["Write", { file_path: "/a/new.ts" }, "edit"],
    ["NotebookEdit", { notebook_path: "/a/nb.ipynb" }, "edit"],
    ["Read", { file_path: "/a/x.ts" }, "read"],
    ["Bash", { command: "ls" }, "run"],
    ["Grep", { pattern: "TODO" }, "search"],
    ["Glob", { pattern: "**/*.ts" }, "search"],
    ["WebFetch", { url: "https://example.com/a/b" }, "web"],
    ["Task", { description: "hunt the bug" }, "task"],
  ];
  for (const [name, input, kind] of cases) {
    expect(lastActionFrom(assistant(T1, name, input))?.kind).toBe(kind);
  }
});

test("an unknown tool still reports, under its own name", () => {
  const chunk = assistant(T1, "mcp__weather__forecast", { city: "Osaka" });
  expect(lastActionFrom(chunk)).toMatchObject({ kind: "other", target: "forecast" });
});

/**
 * A tail read starts mid-record, so the first line is normally a fragment, and
 * any line may be half-written if the read caught a flush. Both are skipped
 * rather than treated as failure — the same tolerance readLastPrompt needs.
 */
test("a truncated first line and malformed lines are skipped", () => {
  const chunk = [
    '_path":"/a/b.ts"}}]}}',
    "{not json at all",
    assistant(T1, "Bash", { command: "git status" }),
  ].join("\n");
  expect(lastActionFrom(chunk)).toMatchObject({ kind: "run", target: "git" });
});

test("a tail with no tool call at all reports nothing", () => {
  const chunk = [
    JSON.stringify({ type: "user", message: { content: "hello" } }),
    JSON.stringify({ type: "assistant", timestamp: T1, message: { content: [{ type: "text" }] } }),
  ].join("\n");
  expect(lastActionFrom(chunk)).toBeNull();
});

test("a record with no usable timestamp is not reported", () => {
  const chunk = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
  });
  expect(lastActionFrom(chunk)).toBeNull();
});

/** The card gives this one line; a pasted heredoc must not blow the row open. */
test("an overlong target is truncated", () => {
  const chunk = assistant(T1, "Grep", { pattern: "x".repeat(200) });
  const action = lastActionFrom(chunk)!;
  expect(action.target!.length).toBeLessThanOrEqual(32);
});

test("newlines in a target are flattened", () => {
  const chunk = assistant(T1, "Task", { description: "first line\nsecond   line" });
  expect(lastActionFrom(chunk)?.target).toBe("first line second line");
});

test("a tool call with nothing recognisable in its input still reports its kind", () => {
  const chunk = assistant(T1, "Bash", {});
  expect(lastActionFrom(chunk)).toMatchObject({ kind: "run", target: null });
});

/**
 * Real commands are rarely one word. `cd <dir> && …` and `VAR=x …` prefixes are
 * how a shell command gets somewhere before doing the thing worth naming, and
 * taking the literal first word reported "ran cd" and "ran export" for most of
 * the transcript — a label that says nothing about what the session is doing.
 */
test("a command's setup prefix is skipped in favour of the real program", () => {
  const cases: [string, string][] = [
    ["cd /srv/app && bun test", "bun"],
    ["cd /srv/app; git status", "git"],
    ['export PATH="$HOME/.bun/bin:$PATH"; bun run typecheck', "bun"],
    ["LANG=C sort -u names.txt", "sort"],
    ["cd /srv && LANG=C make build", "make"],
    ["ls -la", "ls"],
  ];
  for (const [command, expected] of cases) {
    expect(lastActionFrom(assistant(T1, "Bash", { command }))?.target).toBe(expected);
  }
});

test("a command that is nothing but setup still names something", () => {
  expect(lastActionFrom(assistant(T1, "Bash", { command: "cd /srv/app" }))?.target).toBe("cd");
});
