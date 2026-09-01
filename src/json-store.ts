import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * 一份 JSON 状态文件的读与写。
 *
 * 两件事各防一件，缺一不可：
 *
 * - 临时文件 + rename 在同一文件系统内是原子的，防的是**另一个 bun 进程**读到
 *   写了一半的 JSON。
 * - 下面那条序列化队列防的是本进程内并发的读-改-写互相覆盖：三个写者各自先读
 *   全表再各自写全表，后写的会拿着自己那份"旧"全表盖掉前面写进去的记录。
 *
 * 队列**只在本进程内有效**。两个 bun 进程同时写同一份文件不在它的保护范围内，
 * 那时仍然只有 rename 的原子性兜底——这里不作任何相反的宣称。
 */

/** 全函数：文件不存在、JSON 坏了、形状不对，一律读成 fallback，绝不抛。 */
export async function readJson<T>(
  path: string,
  fallback: T,
  sanitise?: (raw: unknown) => T,
): Promise<T> {
  try {
    const raw = await Bun.file(path).json();
    return sanitise ? sanitise(raw) : (raw as T);
  } catch {
    return fallback;
  }
}

/** 先写同目录下的临时文件，再 rename——同一文件系统内是原子的。 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * 进程内串行化。
 *
 * 一份文件的**每一次**读-改-写都要整段进来，不能只把写包进来：在队列外面读、
 * 进队列写，中间那道缝跟没排队一样。
 *
 * 注意队列是模块级的、跨文件共享的：本仓库的状态文件都很小、写得很稀，一条队
 * 列足够，且省掉了"每份文件一条队列"的簿记。
 */
export function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}
