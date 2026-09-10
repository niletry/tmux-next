import { join } from "node:path";
import { pluginStateDir } from "../state";
import { readTailOf } from "../../src/agents/tail";

export function encodeCwd(cwd: string): string {
  return cwd.replace(/\/+$/, "").replace(/[/.]/g, "-");
}

export function logPathFor(cwd: string): string {
  return join(pluginStateDir("supervisor"), "logs", `${encodeCwd(cwd)}.jsonl`);
}

export type PatrolCheck = { session: string; turn: "waiting" | "working" | null; note: string };
export type PatrolAction = { session: string; type: "answered" | "notified" | "noop"; detail: string };
export type PatrolEntry = { ts: string; checked: PatrolCheck[]; actions: PatrolAction[] };

const TURNS = new Set(["waiting", "working", null]);
const ACTION_TYPES = new Set(["answered", "notified", "noop"]);

function checksFrom(value: unknown): PatrolCheck[] {
  if (!Array.isArray(value)) return [];
  const out: PatrolCheck[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const { session, turn, note } = raw as Record<string, unknown>;
    if (typeof session !== "string" || typeof note !== "string") continue;
    if (!TURNS.has(turn as string | null)) continue;
    out.push({ session, turn: turn as PatrolCheck["turn"], note });
  }
  return out;
}

function actionsFrom(value: unknown): PatrolAction[] {
  if (!Array.isArray(value)) return [];
  const out: PatrolAction[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const { session, type, detail } = raw as Record<string, unknown>;
    if (typeof session !== "string" || typeof detail !== "string") continue;
    if (typeof type !== "string" || !ACTION_TYPES.has(type)) continue;
    out.push({ session, type: type as PatrolAction["type"], detail });
  }
  return out;
}

/**
 * Tolerant by construction, same reasoning as `turnFrom`: a tail read starts
 * mid-record, so the first line is normally a fragment, and any line may be
 * malformed if a write was interrupted. Both are skipped rather than failed.
 */
export function patrolEntriesFrom(chunk: string): PatrolEntry[] {
  const out: PatrolEntry[] = [];
  for (const line of chunk.split("\n")) {
    const raw = line.trim();
    if (!raw.startsWith("{")) continue;
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const { ts, checked, actions } = record as Record<string, unknown>;
    if (typeof ts !== "string") continue;
    out.push({ ts, checked: checksFrom(checked), actions: actionsFrom(actions) });
  }
  return out;
}

export async function readPatrolLog(cwd: string, limit: number): Promise<PatrolEntry[]> {
  const chunk = await readTailOf(logPathFor(cwd));
  if (chunk === null) return [];
  const entries = patrolEntriesFrom(chunk);
  return entries.slice(Math.max(0, entries.length - limit));
}
