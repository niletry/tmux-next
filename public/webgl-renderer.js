// @ts-check
/**
 * Keeps the terminal on the WebGL renderer across a lost GPU context.
 *
 * `@xterm/addon-webgl` handles the easy half itself: on `webglcontextlost` it
 * calls preventDefault and waits 3s for `webglcontextrestored`. `onContextLoss`
 * fires only when that window expires — the context is gone for good — and the
 * addon does *not* dispose itself at that point. Left alone the terminal keeps
 * drawing through a dead context instead of falling back, which is what a phone
 * hits after being backgrounded or squeezed for memory: output slows to a crawl
 * and only a page reload fixes it.
 *
 * So: dispose the dead addon at once (that is what drops xterm back to the DOM
 * renderer and keeps the session usable), then try to climb back onto WebGL.
 * The retry budget matters — a device that has taken the context away for good
 * will take it away again, and rebuilding forever would burn battery to no end.
 * Running out of retries is not a failure, it is settling for the slower
 * renderer that still works.
 */

/**
 * @typedef {{ onContextLoss: (cb: () => void) => void, dispose: () => void }} Addon
 */

/**
 * @param {object} opts
 * @param {{ loadAddon: (addon: any) => void }} opts.term
 * @param {() => Addon} opts.makeAddon  builds a fresh addon; may throw
 * @param {number} [opts.maxRetries]  rebuild attempts after a loss
 * @param {number} [opts.retryDelay]  ms to wait before rebuilding
 * @param {(fn: () => void, ms: number) => unknown} [opts.schedule]
 * @param {(msg: string, err?: unknown) => void} [opts.log]
 */
export function createWebglRenderer(opts) {
  const {
    term,
    makeAddon,
    maxRetries = 2,
    retryDelay = 500,
    schedule = setTimeout,
    log = () => {},
  } = opts;

  /** @type {Addon | null} */
  let current = null;
  let retries = 0;
  let active = false;

  function build() {
    let addon;
    try {
      addon = makeAddon();
    } catch (e) {
      // No WebGL at all, or the driver refused a fresh context. The DOM
      // renderer is already what xterm is using, so there is nothing to undo.
      log("webgl renderer unavailable", e);
      current = null;
      active = false;
      return false;
    }
    // Arm before loading: a context that dies during activate must not slip
    // through unhandled.
    addon.onContextLoss(() => onLoss(addon));
    try {
      term.loadAddon(addon);
    } catch (e) {
      log("webgl addon failed to load", e);
      try {
        addon.dispose();
      } catch {}
      current = null;
      active = false;
      return false;
    }
    current = addon;
    active = true;
    return true;
  }

  /** @param {Addon} addon */
  function onLoss(addon) {
    // Only the addon currently in use can lose its context; a stale one firing
    // late must not dispose its replacement or spend the retry budget.
    if (addon !== current) return;
    current = null;
    active = false;
    try {
      addon.dispose();
    } catch (e) {
      log("webgl addon dispose failed", e);
    }
    if (retries >= maxRetries) {
      log("webgl context lost for good; staying on the DOM renderer");
      return;
    }
    retries++;
    schedule(() => build(), retryDelay);
  }

  return {
    /** @returns {boolean} whether WebGL is in use */
    start() {
      return build();
    },
    /** Whether the WebGL renderer is currently live. */
    get active() {
      return active;
    },
  };
}
