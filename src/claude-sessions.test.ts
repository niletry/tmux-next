import { test, expect } from "bun:test";
import { dedupeBySession, restorable, type SessionRecord } from "./claude-sessions";

const rec = (session: string, id: string, mtime: number): SessionRecord => ({
  session,
  id,
  mtime,
  file: `/x/${id}.json`,
});

test("dedupe keeps the newest record per session name", () => {
  const out = dedupeBySession([rec("work", "old", 100), rec("work", "new", 200), rec("docs", "d", 50)]);
  const byName = Object.fromEntries(out.map((r) => [r.session, r.id]));
  expect(byName["work"]).toBe("new");
  expect(byName["docs"]).toBe("d");
  expect(out.length).toBe(2);
});

test("restorable = deduped records whose session is not currently alive", () => {
  const records = [rec("work", "w", 1), rec("docs", "d", 1), rec("gone", "g", 1)];
  const names = restorable(records, new Set(["work"]))
    .map((r) => r.session)
    .sort();
  expect(names).toEqual(["docs", "gone"]);
});

test("a live session with a stale reused record is not offered for restore", () => {
  const records = [rec("work", "old", 100), rec("work", "new", 200)];
  // "work" is alive, so neither record is restorable — even the stale one.
  expect(restorable(records, new Set(["work"]))).toEqual([]);
});
