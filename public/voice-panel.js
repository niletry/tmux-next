import { createVoiceRecorder } from "./voice-recorder.js";

/**
 * The voice input panel.
 *
 * It takes the soft keyboard's place rather than sitting above it: on a phone
 * there is only ever room for one of them, and the two are the same kind of
 * thing — whatever fills the bottom of the screen.
 *
 * Takes accumulate into a draft instead of going to the terminal one at a time.
 * Speech arrives in bursts and recognisers get names and jargon wrong, so the
 * draft is where you say the next sentence, fix the last one, and only then
 * send — once, with Enter.
 *
 * The microphone, the recorder and the network all arrive as dependencies.
 * That is what lets src/voice-panel.test.ts mount this in happy-dom and drive
 * every state without a browser, a device, or a paid API call.
 */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clock(ms) {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Appends one take to the draft.
 *
 * Chinese needs no separator — the recogniser already supplies punctuation, and
 * a space between clauses would be wrong. English run together would produce
 * one unreadable word. So the join is decided by the characters that actually
 * meet: a space only where an ASCII word follows something ASCII.
 */
export function joinTakes(draft, take) {
  if (!draft) return take;
  if (!take) return draft;
  const needsSpace = /[\x21-\x7e]$/.test(draft) && /^[A-Za-z0-9]/.test(take);
  return draft + (needsSpace ? " " : "") + take;
}

export function createVoicePanel(deps) {
  const { getStream, makeRecorder, transcribe, onSend, onClose, tr } = deps;

  const root = el("div", "voice-panel");
  const rec = createVoiceRecorder({ makeRecorder });

  let stream = null;
  let mode = "working";
  let draft = "";
  /** Transient: a failed or silent take. Never replaces the draft. */
  let note = "";
  let ticker = 0;

  function stopTicker() {
    if (ticker) clearInterval(ticker);
    ticker = 0;
  }

  function render() {
    root.dataset.mode = mode;

    // No microphone at all: there is nothing to draft, so say why and stop.
    if (mode === "denied") {
      root.replaceChildren(el("p", "voice-note", tr("voice.denied")));
      return;
    }

    const recording = mode === "recording";
    const busy = mode === "working";

    const box = el("textarea", "voice-text");
    box.value = draft;
    box.dataset.role = "draft";
    box.setAttribute("aria-label", tr("voice.draftLabel"));
    box.setAttribute("placeholder", tr("voice.hint"));
    // Typed edits are the source of truth for the draft; re-rendering on every
    // keystroke would throw the caret to the start of the box.
    box.addEventListener("input", () => {
      draft = box.value;
      refreshSend();
    });

    // One button that changes state, so the finger lands in the same place
    // whether it is starting or stopping.
    const btn = el("button", "voice-rec", recording ? "■" : "●");
    btn.dataset.role = "record";
    btn.dataset.state = mode;
    btn.disabled = busy;
    btn.setAttribute("aria-label", tr(recording ? "voice.stop" : "voice.start"));
    btn.addEventListener("click", toggle);

    const status = el("span", "voice-hint", recording ? clock(0) : busy ? tr("voice.working") : note);
    status.dataset.role = "status";

    // Cancel sits beside the record button rather than under it. On its own row
    // it cost more height than the button it qualifies, which is backwards for
    // the one control here that is an afterthought.
    const row = el("div", "voice-row");
    row.append(btn);
    if (recording) {
      const cancel = el("button", "btn", tr("voice.cancel"));
      cancel.dataset.role = "cancel";
      cancel.addEventListener("click", async () => {
        stopTicker();
        await rec.cancel();
        mode = "idle";
        render();
      });
      row.append(cancel);
    }
    row.append(status);

    const send = el("button", "btn primary", tr("voice.send"));
    send.dataset.role = "send";
    // Sending is what presses Enter, so an empty draft must not be tappable —
    // a bare newline would go to whatever is running.
    send.disabled = !draft.trim();
    send.addEventListener("click", () => {
      if (!draft.trim()) return;
      onSend(draft);
      draft = "";
      note = "";
      render();
    });
    row.append(send);

    function refreshSend() {
      send.disabled = !draft.trim();
    }

    root.replaceChildren(box, row);

    stopTicker();
    if (recording) {
      ticker = setInterval(() => {
        status.textContent = clock(rec.elapsedMs());
      }, 1000);
    }
  }

  async function toggle() {
    if (mode === "recording") {
      stopTicker();
      const blob = await rec.stop();
      if (!blob) {
        mode = "idle";
        render();
        return;
      }
      mode = "working";
      render();

      let take = "";
      try {
        take = await transcribe(blob);
      } catch {
        note = tr("voice.failed");
        mode = "idle";
        render();
        return;
      }
      // A failed or silent take must not take the sentences already collected
      // with it, so the draft is only ever added to.
      if (!take) {
        note = tr("voice.empty");
        mode = "idle";
        render();
        return;
      }
      draft = joinTakes(draft, take);
      note = "";
      mode = "idle";
      render();
      return;
    }

    if (!stream) return;
    note = "";
    rec.start(stream);
    mode = "recording";
    render();
  }

  /**
   * Asks for the microphone when the panel opens, not when recording starts.
   *
   * The permission prompt on first use takes as long as the user takes to
   * answer it, and the opening syllable would be lost behind it.
   */
  async function open() {
    mode = "working";
    render();
    try {
      stream = await getStream();
      mode = "idle";
    } catch {
      stream = null;
      mode = "denied";
    }
    render();
  }

  /**
   * Releases the microphone.
   *
   * iOS shows a system-wide recording indicator for as long as a track is live.
   * Tying the tracks to the panel's lifetime makes that indicator mean exactly
   * "this panel is open", which is honest.
   */
  function close() {
    stopTicker();
    rec.cancel();
    if (stream) {
      for (const t of stream.getTracks()) t.stop();
      stream = null;
    }
    root.remove();
    onClose();
  }

  return { element: root, open, close };
}
