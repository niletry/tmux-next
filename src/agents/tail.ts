import { open } from "node:fs/promises";

/**
 * How much of a transcript's tail to read.
 *
 * Measured on the development machine's 192 Claude transcripts (median 259 KB,
 * largest 68 MB): a 32 KB tail carried the record in 94.8% of them and 128 KB
 * found no more. The same bound is used for pi, whose files are the same shape.
 */
export const TAIL_BYTES = 32 * 1024;

/**
 * The last TAIL_BYTES of a file as text, or null if it cannot be read.
 *
 * Reading the tail rather than the file is what keeps the session list cheap
 * enough to do for every session on every refresh. Callers must tolerate the
 * first line being a fragment.
 */
export async function readTailOf(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, size - length));
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}
