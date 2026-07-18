import { ControlParser } from "./control-parser";

type Pending = { resolve: (lines: string[]) => void; reject: (e: Error) => void };

/**
 * A tmux control mode client.
 *
 * tmux returns command output blocks in the order the commands were sent, so
 * a FIFO queue is enough to match responses to requests.
 */
export class ControlClient {
  #proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  #parser = new ControlParser();
  #pending: Pending[] = [];
  #outputListeners = new Map<string, Set<(data: Uint8Array) => void>>();
  #notificationListeners = new Set<(name: string, args: string[]) => void>();
  #closed = false;

  private constructor(proc: Bun.Subprocess<"pipe", "pipe", "pipe">) {
    this.#proc = proc;
  }

  static async attach(target: string): Promise<ControlClient> {
    const proc = Bun.spawn(["tmux", "-C", "attach", "-t", target], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // Same reason as in run.ts: without a UTF-8 locale tmux sanitises
      // non-ASCII bytes, which would mangle CJK in %output and send-keys.
      // launchd gives the service an empty environment.
      env: {
        ...process.env,
        LANG: process.env.LANG ?? "en_US.UTF-8",
        LC_CTYPE: process.env.LC_CTYPE ?? "en_US.UTF-8",
      },
    });

    const client = new ControlClient(proc);
    void client.#pump();

    // A failed attach makes tmux exit almost immediately.
    const exitedEarly = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(300).then(() => false),
    ]);
    if (exitedEarly) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`tmux attach failed for ${target}: ${err.trim()}`);
    }
    return client;
  }

  async #pump(): Promise<void> {
    try {
      for await (const chunk of this.#proc.stdout) {
        for (const event of this.#parser.push(chunk)) {
          if (event.type === "block") {
            const pending = this.#pending.shift();
            if (!pending) continue;
            if (event.ok) pending.resolve(event.lines);
            else pending.reject(new Error(event.lines.join("\n") || "tmux command failed"));
          } else if (event.type === "output") {
            const listeners = this.#outputListeners.get(event.paneId);
            if (listeners) for (const fn of listeners) fn(event.data);
          } else {
            for (const fn of this.#notificationListeners) fn(event.name, event.args);
          }
        }
      }
    } catch {
      // Stream torn down by close(); handled below.
    }
    this.#failAllPending(new Error("tmux control client closed"));
  }

  #failAllPending(error: Error): void {
    const pending = this.#pending;
    this.#pending = [];
    for (const p of pending) p.reject(error);
  }

  command(cmd: string): Promise<string[]> {
    if (this.#closed) return Promise.reject(new Error("client is closed"));
    return new Promise((resolve, reject) => {
      this.#pending.push({ resolve, reject });
      this.#proc.stdin.write(cmd + "\n");
      this.#proc.stdin.flush();
    });
  }

  onOutput(paneId: string, fn: (data: Uint8Array) => void): () => void {
    let listeners = this.#outputListeners.get(paneId);
    if (!listeners) {
      listeners = new Set();
      this.#outputListeners.set(paneId, listeners);
    }
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }

  onNotification(fn: (name: string, args: string[]) => void): () => void {
    this.#notificationListeners.add(fn);
    return () => {
      this.#notificationListeners.delete(fn);
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#proc.kill();
    this.#failAllPending(new Error("tmux control client closed"));
  }
}
