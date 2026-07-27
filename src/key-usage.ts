import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Tallies of how often each toolbar key is tapped, kept so the button order can
 * be driven by evidence rather than guesswork.
 *
 * A single JSON file next to the uploads, not a database: this is one number
 * per button for one user, and it only ever needs to be added to and read back.
 */
export function keyUsagePath(): string {
  return process.env.TMUX_NEXT_KEY_USAGE_PATH || join(homedir(), ".tmux-next", "key-usage.json");
}

/** A key label the client is allowed to report. Kept short and boring on purpose. */
const LABEL = /^[a-z0-9-]{1,40}$/;
const MAX_LABELS = 64;

/**
 * Cleans a batch of counts posted by a client into something safe to store.
 *
 * The body is untrusted JSON, so nothing is taken on faith: only well-formed
 * labels survive, counts are coerced to whole non-negative numbers, absurd
 * values are dropped, and the number of distinct labels is capped. The result
 * is a plain delta to add onto the running totals.
 */
export function sanitiseCounts(raw: unknown): Record<string, number> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, number> = {};
  let seen = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (seen >= MAX_LABELS) break;
    if (!LABEL.test(key)) continue;
    const n = typeof value === "number" ? Math.floor(value) : NaN;
    if (!Number.isFinite(n) || n <= 0) continue;
    out[key] = Math.min(n, 100_000);
    seen++;
  }
  return out;
}

/** Adds a per-label delta onto a running total, returning the new total. */
export function mergeCounts(
  total: Record<string, number>,
  delta: Record<string, number>,
): Record<string, number> {
  const merged: Record<string, number> = { ...total };
  for (const [key, n] of Object.entries(delta)) {
    merged[key] = (merged[key] ?? 0) + n;
  }
  return merged;
}

// The running totals live in memory as the single source of truth: increments
// happen synchronously here, so concurrent writes can never lose one, and each
// write persists the whole object. Loaded once, lazily, from disk.
let totals: Record<string, number> | null = null;

async function load(): Promise<Record<string, number>> {
  if (totals) return totals;
  try {
    totals = sanitiseCounts(await Bun.file(keyUsagePath()).json());
  } catch {
    totals = {};
  }
  return totals;
}

/** Folds a client's batch into the stored totals and persists them. */
export async function recordUsage(delta: Record<string, number>): Promise<void> {
  const clean = sanitiseCounts(delta);
  if (Object.keys(clean).length === 0) return;
  totals = mergeCounts(await load(), clean);
  await Bun.write(keyUsagePath(), JSON.stringify(totals));
}

/** The current totals, highest first, for the user to inspect. */
export async function readUsage(): Promise<{ key: string; count: number }[]> {
  const t = await load();
  return Object.entries(t)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}
