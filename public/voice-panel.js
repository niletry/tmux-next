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
 * Joins two pieces of dictated text.
 *
 * Chinese needs no separator — the recogniser already supplies punctuation, and
 * a space between clauses would be wrong. English run together would produce
 * one unreadable word. So the join is decided by the characters that actually
 * meet: a space only where an ASCII word follows something ASCII.
 */
export function joinTakes(left, right) {
  if (!left) return right;
  if (!right) return left;
  const needsSpace = /[\x21-\x7e]$/.test(left) && /^[A-Za-z0-9]/.test(right);
  return left + (needsSpace ? " " : "") + right;
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

  // --- the draft box --------------------------------------------------------
  //
  // Built once and never replaced. Re-creating it on each render threw the
  // caret away, and the caret is the whole mechanism for saying where the next
  // sentence should go.

  const box = el("textarea", "voice-text");
  box.dataset.role = "draft";

  /**
   * Where the next take goes.
   *
   * Read back from the element while it has focus, and remembered here for when
   * it does not — tapping the record button blurs the box, and the answer to
   * "where were you?" has to survive that.
   */
  let caret = 0;
  /** The far end of a selection, so speaking over a passage still replaces it. */
  let caretEnd = 0;

  for (const evt of ["input", "select", "keyup", "click", "focus", "blur"]) {
    box.addEventListener(evt, () => {
      if (typeof box.selectionStart !== "number") return;
      caret = box.selectionStart;
      caretEnd = typeof box.selectionEnd === "number" ? box.selectionEnd : caret;
    });
  }
  box.addEventListener("input", () => {
    draft = box.value;
    syncSend();
  });

  /** The caret, or the selection it sits in, clamped to the current draft. */
  function selection() {
    const live = typeof document !== "undefined" && document.activeElement === box;
    const rawStart = live ? box.selectionStart : caret;
    const rawEnd = live ? box.selectionEnd : caretEnd;
    const start = Math.max(0, Math.min(rawStart ?? draft.length, draft.length));
    const end = Math.max(start, Math.min(rawEnd ?? start, draft.length));
    return [start, end];
  }

  /**
   * Splices a take into the draft where the caret is.
   *
   * Speaking over a selected passage replaces it, the same as typing would, and
   * the caret ends up after the new words so the following take continues from
   * there rather than jumping back to the end.
   */
  function absorb(take) {
    const [start, end] = selection();
    const head = joinTakes(draft.slice(0, start), take);
    draft = joinTakes(head, draft.slice(end));
    caret = caretEnd = head.length;
  }

  function applyCaret() {
    try {
      box.setSelectionRange(caret, caret);
    } catch {
      // Not every environment implements selection on a detached textarea.
    }
  }

  // --- the control row ------------------------------------------------------

  const noteEl = el("p", "voice-note");
  const row = el("div", "voice-row");
  let sendBtn = null;
  root.append(noteEl, box, row);

  function syncSend() {
    if (sendBtn) sendBtn.disabled = !draft.trim();
  }

  function render() {
    root.dataset.mode = mode;

    // No microphone at all: there is nothing to draft, so say why and stop.
    if (mode === "denied") {
      noteEl.textContent = tr("voice.denied");
      noteEl.hidden = false;
      box.hidden = true;
      row.hidden = true;
      // Emptied, not just hidden: a hidden button is still a button anything
      // walking the DOM can find and act on.
      row.replaceChildren();
      sendBtn = null;
      stopTicker();
      return;
    }
    noteEl.hidden = true;
    box.hidden = false;
    row.hidden = false;

    const recording = mode === "recording";
    const busy = mode === "working";

    box.setAttribute("aria-label", tr("voice.draftLabel"));
    box.setAttribute("placeholder", tr("voice.hint"));
    if (box.value !== draft) {
      box.value = draft;
      applyCaret();
    }

    // One button that changes state, so the finger lands in the same place
    // whether it is starting or stopping.
    const btn = el("button", "voice-rec", recording ? "■" : "●");
    btn.dataset.role = "record";
    btn.dataset.state = mode;
    btn.disabled = busy;
    btn.setAttribute("aria-label", tr(recording ? "voice.stop" : "voice.start"));
    btn.addEventListener("click", toggle);

    const status = el(
      "span",
      "voice-hint",
      recording
        ? clock(0)
        : busy
          ? tr("voice.working")
          : note || (draft ? tr("voice.caretHint") : ""),
    );
    status.dataset.role = "status";

    // Cancel sits beside the record button rather than under it. On its own row
    // it cost more height than the button it qualifies, which is backwards for
    // the one control here that is an afterthought.
    row.replaceChildren(btn);
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

    sendBtn = el("button", "btn primary", tr("voice.send"));
    sendBtn.dataset.role = "send";
    // Sending is what presses Enter, so an empty draft must not be tappable —
    // a bare newline would go to whatever is running.
    sendBtn.disabled = !draft.trim();
    sendBtn.addEventListener("click", () => {
      if (!draft.trim()) return;
      // The draft is only cleared once the send has actually happened. If the
      // host cannot take it — a stale cached module leaving onSend undefined is
      // the realistic case — losing the sentences would be the worst outcome,
      // and saying nothing about it is what makes such a failure hard to place.
      try {
        onSend(draft);
      } catch {
        note = tr("voice.sendFailed");
        render();
        return;
      }
      draft = "";
      caret = caretEnd = 0;
      note = "";
      box.value = "";
      render();
    });
    row.append(sendBtn);

    stopTicker();
    if (recording) {
      ticker = setInterval(() => {
        status.textContent = clock(rec.elapsedMs());
      }, 1000);
    }
  }

  function stopTicker() {
    if (ticker) clearInterval(ticker);
    ticker = 0;
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
      absorb(take);
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
