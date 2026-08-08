import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

/**
 * opencode keeps sessions in SQLite rather than JSONL.
 *
 * That turns out to be the easiest of the three to read: `session.title` is
 * already a short description of the conversation, so there is no transcript to
 * parse and no tail to bound — one indexed lookup instead. The row also carries
 * `directory`, so the working directory does not have to be encoded into a path
 * the way Claude Code and pi require.
 */

/**
 * The database is the user's live one, opened read-only.
 *
 * opencode is running against the same file, and this process has no business
 * writing to someone's conversation history — a stray write while another
 * writer holds the WAL is how histories get corrupted. Exported so the test can
 * pin it rather than trust the comment.
 */
export const OPENCODE_DB_READONLY = true;

/** Overridable so tests never touch the developer's own opencode database. */
function dbPath(): string {
  return (
    process.env.OPENCODE_DB_PATH ||
    join(homedir(), ".local", "share", "opencode", "opencode.db")
  );
}

/**
 * The title opencode gave a conversation, or null.
 *
 * `cwd` is accepted for symmetry with the other adapters and used to
 * disambiguate: opencode ids are unique, but matching on the directory as well
 * keeps a stale binding from another checkout out of the list.
 */
export async function readOpencodeTask(cwd: string, id: string): Promise<string | null> {
  let db: Database;
  try {
    db = new Database(dbPath(), { readonly: OPENCODE_DB_READONLY });
  } catch {
    // opencode not installed, database not created yet, or unreadable. A
    // missing task is a normal answer, never a reason to fail the list.
    return null;
  }
  try {
    const row = db
      .query<{ title: string | null }, [string, string]>(
        "SELECT title FROM session WHERE id = ? AND directory = ? LIMIT 1",
      )
      .get(id, cwd);
    const title = row?.title;
    if (typeof title !== "string") return null;
    const text = title.replace(/\s+/g, " ").trim();
    return text || null;
  } catch {
    // Schema drift in a tool we do not control must degrade, not crash.
    return null;
  } finally {
    db.close();
  }
}
