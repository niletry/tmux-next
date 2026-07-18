import { ControlClient } from "./control-client";
import { createWebSession, destroyWebSession } from "./session-manager";

export const TERMINAL_COLUMNS = 80;

/** Claude Code can emit dozens of %output per repaint; batch them per frame. */
const FRAME_MS = 16;

export type PaneSessionOptions = {
  target: string;
  rows: number;
  onData: (chunk: Uint8Array) => void;
};

/**
 * One browser connection's view of one tmux pane.
 *
 * Owns a grouped session as a disposable attach point, seeds the current
 * screen with capture-pane, then forwards live output.
 */
export class PaneSession {
  #client: ControlClient;
  #webSession: string;
  #paneId: string;
  #windowId = "";
  #onData: (chunk: Uint8Array) => void;
  #frame: Uint8Array[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  private constructor(
    client: ControlClient,
    webSession: string,
    paneId: string,
    onData: (chunk: Uint8Array) => void,
  ) {
    this.#client = client;
    this.#webSession = webSession;
    this.#paneId = paneId;
    this.#onData = onData;
  }

  static async open(opts: PaneSessionOptions): Promise<PaneSession> {
    const webSession = await createWebSession(opts.target);

    let client: ControlClient;
    try {
      client = await ControlClient.attach(webSession);
    } catch (e) {
      await destroyWebSession(webSession);
      throw e;
    }

    try {
      // refresh-client, not resize-window: participating as a client keeps
      // `window-size latest` able to hand the size back to the desktop.
      await client.command(`refresh-client -C ${TERMINAL_COLUMNS},${opts.rows}`);
      const paneId = (
        await client.command(`display-message -p -t ${webSession} '#{pane_id}'`)
      )[0]!;

      const session = new PaneSession(client, webSession, paneId, opts.onData);
      session.#windowId = (
        await client.command(`display-message -p -t ${webSession} '#{window_id}'`)
      )[0]!;

      // Output produced before the capture command runs is already reflected in
      // the captured screen, so buffer and drop it; apply only what follows.
      let seeded = false;
      const buffered: Uint8Array[] = [];
      client.onOutput(paneId, (data) => {
        if (seeded) session.#enqueue(data);
        else buffered.push(data);
      });

      const screen = await client.command(`capture-pane -p -e -J -t ${paneId}`);
      const cursor = (
        await client.command(`display-message -p -t ${paneId} '#{cursor_y};#{cursor_x}'`)
      )[0]!;

      buffered.length = 0;
      seeded = true;

      const [row, col] = cursor.split(";").map(Number) as [number, number];
      const seed =
        "\x1b[2J\x1b[H" + screen.join("\r\n") + `\x1b[${row + 1};${col + 1}H`;
      opts.onData(new TextEncoder().encode(seed));

      return session;
    } catch (e) {
      client.close();
      await destroyWebSession(webSession);
      throw e;
    }
  }

  #enqueue(data: Uint8Array): void {
    this.#frame.push(data);
    if (this.#timer) return;

    this.#timer = setTimeout(() => {
      this.#timer = null;
      const total = this.#frame.reduce((n, c) => n + c.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of this.#frame) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      this.#frame = [];
      if (!this.#closed) this.#onData(merged);
    }, FRAME_MS);
  }

  async sendKeys(bytes: Uint8Array): Promise<void> {
    if (this.#closed) return;
    // Hex avoids the ambiguity of tmux key names for escape sequences.
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
    await this.#client.command(`send-keys -t ${this.#paneId} -H ${hex}`);
  }

  async resize(rows: number): Promise<void> {
    if (this.#closed) return;
    await this.#client.command(`refresh-client -C ${TERMINAL_COLUMNS},${rows}`);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#client.close();
    await destroyWebSession(this.#webSession);
    await this.#restoreWindowSize();
  }

  /**
   * Hands the window back to whatever clients remain.
   *
   * `window-size latest` only recomputes when a client attaches or resizes, so
   * without this the window would sit at the phone's 80 columns — squeezing a
   * desktop client that stayed attached the whole time.
   *
   * `resize-window -A` pins window-size to manual as a side effect, so the
   * option is unset immediately afterwards to restore automatic sizing.
   */
  async #restoreWindowSize(): Promise<void> {
    if (!this.#windowId) return;
    await Bun.$`tmux resize-window -A -t ${this.#windowId}`.quiet().nothrow();
    await Bun.$`tmux set-window-option -t ${this.#windowId} -u window-size`.quiet().nothrow();
  }
}
