import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { AGENTS } from "./index";
import { piSessionDir, taskFromPiChunk } from "./pi";

const line = (o: unknown) => JSON.stringify(o) + "\n";

/**
 * Each agent stores "what was I asked to do" somewhere different, and the
 * differences are not incidental: Claude Code keeps a dedicated `last-prompt`
 * record, pi keeps ordinary messages and the answer is the newest user one, and
 * opencode keeps a title column in SQLite. The adapters exist to hide exactly
 * this.
 */

// --- pi ---------------------------------------------------------------------

test("pi encodes a working directory the way its own source does", () => {
  // Taken from pi's migrations.js: `--${cwd without leading separator, with
  // / \ : replaced by -}--`. Verified against a real directory on disk (with
  // the username swapped for a placeholder — the encoding logic doesn't care
  // whose home directory it is).
  expect(piSessionDir("/Users/x/.local")).toBe("--Users-x-.local--");
  expect(piSessionDir("/Volumes/work/orbit-spec")).toBe("--Volumes-life-orbit-spec--");
  // A drive colon and a separator are two characters, so they become two
  // dashes — matching pi's own encoding rather than what looks tidier.
  expect(piSessionDir("C:\\work\\proj")).toBe("--C--work-proj--");
});

test("pi takes the newest user message as the task", () => {
  const text =
    line({ type: "message", message: { role: "user", content: [{ type: "text", text: "first" }] } }) +
    line({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) +
    line({ type: "message", message: { role: "user", content: [{ type: "text", text: "second" }] } });
  expect(taskFromPiChunk(text)).toBe("second");
});

test("pi ignores assistant messages, fragments and junk", () => {
  expect(taskFromPiChunk('{"type":"message","mes')).toBeNull();
  expect(taskFromPiChunk(line({ type: "message", message: { role: "assistant", content: [] } }))).toBeNull();
  expect(taskFromPiChunk("")).toBeNull();
});

test("pi joins multi-part content and collapses whitespace", () => {
  const text = line({
    type: "message",
    message: {
      role: "user",
      content: [
        { type: "text", text: "  fix\n\n the " },
        { type: "text", text: " thing  " },
      ],
    },
  });
  expect(taskFromPiChunk(text)).toBe("fix the thing");
});

test("pi reads a task from a real transcript on disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sessions-"));
  const cwd = "/tmp/proj";
  const path = join(root, piSessionDir(cwd), "2026-01-01T00-00-00-000Z_abc.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    line({ type: "session", id: "abc", cwd }) +
      line({ type: "message", message: { role: "user", content: [{ type: "text", text: "wire pi up" }] } }),
  );

  process.env.PI_SESSION_ROOT = root;
  expect(await AGENTS.pi!.readTask!(cwd, "abc")).toBe("wire pi up");
});

// --- opencode ---------------------------------------------------------------

test("opencode resume and launch stay constant strings", () => {
  const oc = AGENTS.opencode!;
  expect(oc.resume!("ses_05d709e3cffehI0t7IvoOR0zjb", { skipPermissions: false }))
    .toContain("ses_05d709e3cffehI0t7IvoOR0zjb");
  // opencode session ids contain no shell metacharacters, and anything that
  // does must still be refused by the shared guard.
  expect(oc.resume!("ses_x; rm -rf ~", { skipPermissions: false })).toBeNull();
});

test("opencode reads a task from its database, and never writes to it", async () => {
  const { Database } = await import("bun:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "oc-db-"));
  const dbPath = join(dir, "opencode.db");

  const seed = new Database(dbPath);
  seed.run("CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_updated INTEGER)");
  seed.run(
    "INSERT INTO session VALUES ('ses_abc','/tmp/proj','把 batch size 调到 500',2), " +
      "('ses_old','/tmp/proj','旧任务',1)",
  );
  seed.close();

  process.env.OPENCODE_DB_PATH = dbPath;
  const { readOpencodeTask } = await import("./opencode");

  expect(await readOpencodeTask("/tmp/proj", "ses_abc")).toBe("把 batch size 调到 500");
  // An id that is not in the table is not an error — the session may predate
  // the database, or belong to another machine.
  expect(await readOpencodeTask("/tmp/proj", "ses_missing")).toBeNull();

  // Opening the user's live database read-only matters: opencode is running
  // against it at the same time, and a stray write would corrupt their history.
  const { OPENCODE_DB_READONLY } = await import("./opencode");
  expect(OPENCODE_DB_READONLY).toBe(true);
});

test("opencode survives a missing or unreadable database", async () => {
  process.env.OPENCODE_DB_PATH = join(tmpdir(), "no-such-" + Math.random() + ".db");
  const { readOpencodeTask } = await import("./opencode");
  expect(await readOpencodeTask("/tmp/proj", "ses_abc")).toBeNull();
});

test("slash commands are not tasks", () => {
  // Real data caught this: the newest user message in a finished pi session was
  // `/exit`. A slash command is an instruction to the TUI, not a description of
  // work, and showing it in the list says nothing about what the session did.
  const withExit =
    line({ type: "message", message: { role: "user", content: [{ type: "text", text: "调大 batch size" }] } }) +
    line({ type: "message", message: { role: "user", content: [{ type: "text", text: "/exit" }] } });
  expect(taskFromPiChunk(withExit)).toBe("调大 batch size");

  // A message that merely begins with a slash-like path is still a task.
  const path =
    line({ type: "message", message: { role: "user", content: [{ type: "text", text: "/tmp/foo 里的脚本跑不动" }] } });
  expect(taskFromPiChunk(path)).toBe("/tmp/foo 里的脚本跑不动");

  // Nothing but slash commands leaves no task rather than a misleading one.
  const onlyCommands =
    line({ type: "message", message: { role: "user", content: [{ type: "text", text: "/clear" }] } }) +
    line({ type: "message", message: { role: "user", content: [{ type: "text", text: "/exit" }] } });
  expect(taskFromPiChunk(onlyCommands)).toBeNull();
});
