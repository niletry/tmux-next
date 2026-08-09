// @ts-check
/**
 * Recording, as a state machine with nothing in it that needs a browser.
 *
 * MediaRecorder only exists in a page, and what it does differs across iOS
 * versions — but the part that has bugs in it is the sequencing: what a second
 * tap does, what happens when stop arrives before any data, whether a cancelled
 * take can still be sent. So the recorder arrives through a factory, and all of
 * that is testable headlessly. See src/voice-recorder.test.ts.
 */

/** @typedef {"idle"|"recording"} RecorderState */

/**
 * @typedef {Object} RecorderDeps
 * @property {(stream: any) => any} makeRecorder returns a MediaRecorder-shaped object
 * @property {() => number} [now] millisecond clock; defaults to Date.now
 */

/**
 * @param {RecorderDeps} deps
 */
export function createVoiceRecorder(deps) {
  const now = deps.now || (() => Date.now());

  /** @type {RecorderState} */
  let state = "idle";
  /** @type {any} */
  let recorder = null;
  /** @type {any[]} */
  let chunks = [];
  let startedAt = 0;
  let discarding = false;
  /** @type {((blob: any) => void) | null} */
  let settle = null;

  function finish() {
    const done = settle;
    const parts = chunks;
    const type = (recorder && recorder.mimeType) || "audio/webm";
    const drop = discarding;
    state = "idle";
    recorder = null;
    chunks = [];
    settle = null;
    discarding = false;
    if (done) done(drop || !parts.length ? null : new Blob(parts, { type }));
  }

  /** @param {boolean} drop */
  function end(drop) {
    if (state !== "recording") return Promise.resolve(null);
    discarding = drop;
    return new Promise((resolve) => {
      settle = resolve;
      recorder.stop();
    });
  }

  return {
    get state() {
      return state;
    },

    elapsedMs() {
      return state === "recording" ? now() - startedAt : 0;
    },

    /**
     * @param {any} stream
     * @returns {boolean} whether this call actually started a recording
     */
    start(stream) {
      if (state === "recording") return false;
      recorder = deps.makeRecorder(stream);
      chunks = [];
      discarding = false;
      recorder.ondataavailable = (/** @type {any} */ e) => {
        if (e && e.data && e.data.size) chunks.push(e.data);
      };
      recorder.onstop = finish;
      recorder.start();
      startedAt = now();
      state = "recording";
      return true;
    },

    /** @returns {Promise<any>} the recording, or null if there was nothing */
    stop() {
      return end(false);
    },

    /** @returns {Promise<any>} always null; the take is thrown away */
    cancel() {
      return end(true);
    },
  };
}
