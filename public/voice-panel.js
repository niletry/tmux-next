import { createVoiceRecorder } from "./voice-recorder.js";

/**
 * The voice input panel.
 *
 * It takes the soft keyboard's place rather than sitting above it: on a phone
 * there is only ever room for one of them, and the two are the same kind of
 * thing — whatever fills the bottom of the screen.
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

export function createVoicePanel(deps) {
  const { getStream, makeRecorder, transcribe, onInsert, onClose, tr } = deps;

  const root = el("div", "voice-panel");
  const rec = createVoiceRecorder({ makeRecorder });

  let stream = null;
  let mode = "working";
  let text = "";
  let note = "";
  let ticker = 0;

  function stopTicker() {
    if (ticker) clearInterval(ticker);
    ticker = 0;
  }

  function again() {
    const btn = el("button", "btn", tr("voice.again"));
    btn.dataset.role = "again";
    btn.addEventListener("click", () => {
      mode = "idle";
      render();
    });
    return btn;
  }

  function render() {
    root.dataset.mode = mode;

    if (mode === "error") {
      const kids = [el("p", "voice-note", note)];
      // Only offer another take when there is still a microphone to use.
      if (stream) kids.push(again());
      root.replaceChildren(...kids);
      return;
    }

    if (mode === "working") {
      root.replaceChildren(el("p", "voice-note", tr("voice.working")));
      return;
    }

    if (mode === "review") {
      const box = el("textarea", "voice-text");
      box.value = text;
      box.setAttribute("aria-label", tr("voice.reviewLabel"));

      const insert = el("button", "btn primary", tr("voice.insert"));
      insert.dataset.role = "insert";
      insert.addEventListener("click", () => {
        // No Enter: the text lands at the prompt and the user sends it, the
        // same contract as an uploaded image path.
        onInsert(box.value);
        // Back to ready rather than closed. Dictation comes in bursts — say a
        // sentence, look at what landed, say the next — and closing here would
        // charge a reopen and a fresh glance for every one of them.
        text = "";
        mode = "idle";
        render();
      });

      const actions = el("div", "voice-actions");
      actions.append(again(), insert);
      root.replaceChildren(box, actions);
      return;
    }

    // idle and recording share one button that changes state, so the finger
    // lands in the same place both times.
    const recording = mode === "recording";
    const btn = el("button", "voice-rec", recording ? "■" : "●");
    btn.dataset.role = "record";
    btn.dataset.state = mode;
    btn.setAttribute("aria-label", tr(recording ? "voice.stop" : "voice.start"));
    btn.addEventListener("click", toggle);

    const hint = el("span", "voice-hint", recording ? clock(0) : tr("voice.hint"));
    hint.dataset.role = "hint";

    const kids = [btn, hint];
    if (recording) {
      const cancel = el("button", "btn", tr("voice.cancel"));
      cancel.dataset.role = "cancel";
      cancel.addEventListener("click", async () => {
        stopTicker();
        await rec.cancel();
        mode = "idle";
        render();
      });
      kids.push(cancel);
    }
    root.replaceChildren(...kids);

    stopTicker();
    if (recording) {
      ticker = setInterval(() => {
        hint.textContent = clock(rec.elapsedMs());
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
      try {
        text = await transcribe(blob);
      } catch {
        note = tr("voice.failed");
        mode = "error";
        render();
        return;
      }
      if (!text) {
        note = tr("voice.empty");
        mode = "error";
        render();
        return;
      }
      mode = "review";
      render();
      return;
    }

    if (!stream) return;
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
      note = tr("voice.denied");
      mode = "error";
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
