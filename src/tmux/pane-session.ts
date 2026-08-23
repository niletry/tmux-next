import { ControlClient } from "./control-client";
import { tmux } from "./run";
import { createWebSession, destroyWebSession } from "./session-manager";

/**
 * Width used when a caller does not supply one.
 *
 * No longer a hard lock: a wide browser window asks for more, and tmux
 * arbitrates between clients through `window-size latest` on its own.
 */
export const DEFAULT_COLUMNS = 80;

/** Claude Code can emit dozens of %output per repaint; batch them per frame. */
const FRAME_MS = 16;

/**
 * DECSET sequences that re-assert the mouse tracking a pane reports.
 *
 * capture-pane restores content, not terminal modes, and the seed clears them,
 * so a program using the mouse comes back with tracking off — and xterm only
 * binds its wheel-to-mouse handler while a mode is on, which is why scrolling
 * stayed dead until a keyboard toggle forced a repaint. Flags come straight
 * from tmux's `#{mouse_*_flag}`; all-motion (1003) supersedes button-only
 * (1000), and SGR (1006) is the encoding on top.
 */
export function mouseModeSeed(anyFlag: number, allFlag: number, sgrFlag: number): string {
  let modes = "";
  if (sgrFlag) modes += "\x1b[?1006h";
  if (allFlag) modes += "\x1b[?1003h";
  else if (anyFlag) modes += "\x1b[?1000h";
  return modes;
}

export type PaneSessionOptions = {
  target: string;
  rows: number;
  cols?: number;
  onData: (chunk: Uint8Array) => void;
  /**
   * The control client died without being asked to. The caller should drop the
   * connection rather than hold one that can no longer carry anything.
   */
  onExit?: () => void;
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
      await client.command(`refresh-client -C ${opts.cols ?? DEFAULT_COLUMNS},${opts.rows}`);
      const paneId = (
        await client.command(`display-message -p -t ${webSession} '#{pane_id}'`)
      )[0]!;

      const session = new PaneSession(client, webSession, paneId, opts.onData);

      // A control client that dies takes the session with it. Telling the
      // caller lets it close the socket, which is all the browser needs: its
      // onclose already drives a backoff reconnect, and a reconnect reseeds
      // from capture-pane. Without this the page keeps a live socket that will
      // never carry another byte.
      client.onExit(() => {
        if (session.#closed) return;
        session.#closed = true;
        opts.onExit?.();
      });
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
      // Cursor and mouse modes in one query. capture-pane restores content but
      // not terminal *modes*, and the seed's `\x1b[2J\x1b[H` clears them — so
      // without this, a program using the mouse (Claude Code enables tracking)
      // comes back with mouse reporting off, and xterm only binds its
      // wheel-to-mouse handler while a mode is on. That is the "can't scroll
      // until I toggle the keyboard" bug: the toggle forces a repaint that
      // re-asserts the mode. Restoring it here means scrolling works at once.
      const info = (
        await client.command(
          `display-message -p -t ${paneId} ` +
            `'#{cursor_y};#{cursor_x};#{mouse_any_flag};#{mouse_all_flag};#{mouse_sgr_flag}'`,
        )
      )[0]!;

      buffered.length = 0;
      seeded = true;

      const [row, col, mAny, mAll, mSgr] = info.split(";").map(Number) as number[];
      const seed =
        "\x1b[2J\x1b[H" +
        screen.join("\r\n") +
        `\x1b[${row! + 1};${col! + 1}H` +
        mouseModeSeed(mAny!, mAll!, mSgr!);
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

  /**
   * Runs a command, treating a close that lands mid-flight as a no-op.
   *
   * The `#closed` check above cannot cover this: the socket can drop after the
   * check and before the reply, and close() rejects every pending command. For
   * a keystroke or a resize there is nothing to report and nobody to report it
   * to — the pane is gone. Leaving the rejection unhandled crashed the process
   * and launchd restarted it, which is what served the 502s.
   */
  async #tell(command: string): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#client.command(command);
    } catch (e) {
      // A failure for any other reason is still worth knowing about.
      if (!this.#closed) throw e;
    }
  }

  async sendKeys(bytes: Uint8Array): Promise<void> {
    // Hex avoids the ambiguity of tmux key names for escape sequences.
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
    await this.#tell(`send-keys -t ${this.#paneId} -H ${hex}`);
  }

  async resize(rows: number, cols: number = DEFAULT_COLUMNS): Promise<void> {
    await this.#tell(`refresh-client -C ${cols},${rows}`);
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
   * without this the window would sit at whatever width the browser last asked
   * for — squeezing a desktop client that stayed attached the whole time.
   *
   * `resize-window -A` pins window-size to manual as a side effect, so the
   * option is unset immediately afterwards to restore automatic sizing.
   */
  async #restoreWindowSize(): Promise<void> {
    if (!this.#windowId) return;
    await tmux(["resize-window", "-A", "-t", this.#windowId]);
    await tmux(["set-window-option", "-t", this.#windowId, "-u", "window-size"]);
  }
}
