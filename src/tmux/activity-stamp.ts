/**
 * "Last updated" for a session, derived from when its visible screen last
 * *changed* — not tmux's window_activity, which advances on any repaint (a
 * spinner, a status line, a cursor) and so reads "just now" for every live
 * Claude session. The list already captures each session's screen every poll;
 * comparing that capture to the previous one is the honest signal for whether
 * anything a human would see actually moved.
 *
 * Kept pure and stateless: the caller owns the store (a per-name Map in the
 * server process) and the clock, so this decision can be unit-tested without
 * either.
 */

export type ActivityEntry = {
  /** Hash of the last observed visible screen. */
  hash: string;
  /** Epoch seconds we attribute the last visible change to. */
  epoch: number;
};

/**
 * The entry to store for a session this poll.
 *
 * - First sight (no prior entry): trust `seedEpoch` — tmux's window_activity —
 *   rather than stamping "now". Otherwise every session would read "just now"
 *   immediately after the server restarts, which is exactly the bug this
 *   replaces.
 * - Content changed since last poll: stamp `nowEpoch`.
 * - Content unchanged: keep the prior stamp, so an idle session's time freezes
 *   at when its last output actually landed.
 */
export function nextStamp(
  prev: ActivityEntry | undefined,
  hash: string,
  seedEpoch: number,
  nowEpoch: number,
): ActivityEntry {
  if (!prev) return { hash, epoch: seedEpoch };
  if (prev.hash !== hash) return { hash, epoch: nowEpoch };
  return prev;
}
