import { test, expect, afterEach } from "bun:test";
import { Window } from "happy-dom";

/**
 * The voice panel, driven in a real DOM.
 *
 * Bundling proves a browser module parses; only mounting proves it draws.
 * Everything that would need a browser — the microphone, the recorder, the
 * network — is injected, so this runs headlessly and deterministically.
 */

/**
 * Globals this file replaces, so they can be put back.
 *
 * Bun runs every test file in one process; a shim that does not clean up after
 * itself stops being a test and becomes a hazard for every other file.
 */
const PATCHED = ["window", "document", "Blob"] as const;
const saved = new Map<string, unknown>();

function mountDom() {
  const win = new Window({ url: "https://localhost/terminal.html" });
  for (const key of PATCHED) {
    if (key in globalThis) saved.set(key, (globalThis as Record<string, unknown>)[key]);
    Object.defineProperty(globalThis, key, {
      value: (win as unknown as Record<string, unknown>)[key],
      writable: true,
      configurable: true,
    });
  }
}

afterEach(() => {
  for (const key of PATCHED) {
    if (saved.has(key)) {
      Object.defineProperty(globalThis, key, {
        value: saved.get(key),
        writable: true,
        configurable: true,
      });
    } else {
      delete (globalThis as Record<string, unknown>)[key];
    }
  }
  saved.clear();
});

/**
 * Lets the panel's async chain settle.
 *
 * A click handler here awaits the recorder and then the transcription, so one
 * microtask tick is not enough to reach the rendered result.
 */
async function flush() {
  for (let i = 0; i < 10; i++) await Bun.sleep(0);
}

class FakeRecorder {
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: unknown }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {}
  stop() {
    this.ondataavailable?.({ data: new Blob(["audio"]) });
    this.onstop?.();
  }
}

const track = () => ({
  stopped: false,
  stop(this: { stopped: boolean }) {
    this.stopped = true;
  },
});

async function panelWith(over: Record<string, unknown> = {}) {
  mountDom();
  const { createVoicePanel } = await import("../public/voice-panel.js");
  const tracks = [track()];
  const calls = { transcribed: 0, sent: [] as string[], closed: 0 };
  const said = ["这是第一句。", "这是第二句。", "这是第三句。"];
  const panel = createVoicePanel({
    getStream: async () => ({ getTracks: () => tracks }),
    makeRecorder: () => new FakeRecorder(),
    transcribe: async () => said[calls.transcribed++] ?? "又一句。",
    onSend: (t: string) => calls.sent.push(t),
    onClose: () => {
      calls.closed++;
    },
    tr: (k: string) => k,
    ...over,
  });
  document.body.append(panel.element);
  await panel.open();
  return { panel, calls, tracks };
}

const role = (el: HTMLElement, name: string) =>
  el.querySelector(`[data-role="${name}"]`) as HTMLElement | null;

const draftOf = (el: HTMLElement) =>
  (el.querySelector("textarea") as HTMLTextAreaElement).value;

/** One full take: start, stop, wait for the transcription to land. */
async function dictate(el: HTMLElement) {
  role(el, "record")!.click();
  role(el, "record")!.click();
  await flush();
}

test("an opened panel offers the record button and an empty draft", async () => {
  const { panel } = await panelWith();
  expect(panel.element.dataset.mode).toBe("idle");
  expect(role(panel.element, "record")).not.toBeNull();
  expect(draftOf(panel.element)).toBe("");
});

test("the one state button switches to recording, and cancel appears with it", async () => {
  const { panel } = await panelWith();
  role(panel.element, "record")!.click();
  expect(panel.element.dataset.mode).toBe("recording");
  // Still one button, not a second control appearing beside the first.
  expect(panel.element.querySelectorAll('[data-role="record"]')).toHaveLength(1);
  expect(role(panel.element, "cancel")).not.toBeNull();
});

test("a take lands in the draft rather than going straight to the terminal", async () => {
  const { panel, calls } = await panelWith();
  await dictate(panel.element);
  expect(calls.transcribed).toBe(1);
  expect(draftOf(panel.element)).toBe("这是第一句。");
  // Nothing reaches the terminal until the user says so.
  expect(calls.sent).toEqual([]);
});

// The reason the draft exists: dictation comes in bursts, and each burst should
// add to what is already there instead of replacing it or firing off on its own.
test("further takes append to the draft", async () => {
  const { panel } = await panelWith();
  await dictate(panel.element);
  await dictate(panel.element);
  await dictate(panel.element);
  expect(draftOf(panel.element)).toBe("这是第一句。这是第二句。这是第三句。");
});

// Re-creating the textarea on every render threw the caret away, which is what
// made "insert before what I already said" impossible.
test("the draft box is the same element across takes", async () => {
  const { panel } = await panelWith();
  const before = panel.element.querySelector("textarea");
  await dictate(panel.element);
  await dictate(panel.element);
  expect(panel.element.querySelector("textarea")).toBe(before);
});

test("a take lands at the caret, not always at the end", async () => {
  const { panel } = await panelWith();
  await dictate(panel.element);
  await dictate(panel.element);
  expect(draftOf(panel.element)).toBe("这是第一句。这是第二句。");

  // Put the caret at the very start, the way tapping there would.
  const box = panel.element.querySelector("textarea") as HTMLTextAreaElement;
  box.selectionStart = 0;
  box.selectionEnd = 0;
  box.dispatchEvent(new window.Event("select", { bubbles: true }));

  await dictate(panel.element);
  expect(draftOf(panel.element)).toBe("这是第三句。这是第一句。这是第二句。");
});

test("the caret follows the inserted take, so the next one continues from it", async () => {
  const { panel } = await panelWith();
  await dictate(panel.element);
  await dictate(panel.element);
  const box = panel.element.querySelector("textarea") as HTMLTextAreaElement;
  box.selectionStart = 0;
  box.selectionEnd = 0;
  box.dispatchEvent(new window.Event("select", { bubbles: true }));

  await dictate(panel.element); // 第三句 goes to the front
  await dictate(panel.element); // and the fourth follows it, not the whole draft
  expect(draftOf(panel.element)).toBe("这是第三句。又一句。这是第一句。这是第二句。");
});

// Speaking over a selected passage should replace it, the same as typing would.
test("a take replaces the selected passage", async () => {
  const { panel } = await panelWith();
  await dictate(panel.element);
  const box = panel.element.querySelector("textarea") as HTMLTextAreaElement;
  box.selectionStart = 0;
  box.selectionEnd = "这是第一句。".length;
  box.dispatchEvent(new window.Event("select", { bubbles: true }));

  await dictate(panel.element);
  expect(draftOf(panel.element)).toBe("这是第二句。");
});

test("edits to the draft survive the next take", async () => {
  const { panel } = await panelWith();
  await dictate(panel.element);
  const box = panel.element.querySelector("textarea") as HTMLTextAreaElement;
  box.value = "改过的开头。";
  box.dispatchEvent(new window.Event("input", { bubbles: true }));
  await dictate(panel.element);
  expect(draftOf(panel.element)).toBe("改过的开头。这是第二句。");
});

test("sending delivers the whole draft and then empties it", async () => {
  const { panel, calls } = await panelWith();
  await dictate(panel.element);
  await dictate(panel.element);
  role(panel.element, "send")!.click();
  expect(calls.sent).toEqual(["这是第一句。这是第二句。"]);
  expect(draftOf(panel.element)).toBe("");
});

test("sending leaves the panel open and still holding the microphone", async () => {
  const { panel, calls, tracks } = await panelWith();
  await dictate(panel.element);
  role(panel.element, "send")!.click();
  expect(panel.element.isConnected).toBe(true);
  expect(calls.closed).toBe(0);
  expect(tracks[0]!.stopped).toBe(false);
  // And a second round really works, rather than merely looking ready.
  await dictate(panel.element);
  role(panel.element, "send")!.click();
  expect(calls.sent).toHaveLength(2);
});

// Sending is what presses Enter, so an accidental tap on an empty draft would
// fire a bare newline at whatever is running.
test("sending is unavailable while the draft is empty", async () => {
  const { panel, calls } = await panelWith();
  const send = role(panel.element, "send") as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  send.click();
  expect(calls.sent).toEqual([]);
});

test("cancelling a recording transcribes nothing and leaves the draft alone", async () => {
  const { panel, calls } = await panelWith();
  await dictate(panel.element);
  role(panel.element, "record")!.click();
  role(panel.element, "cancel")!.click();
  await flush();
  expect(calls.transcribed).toBe(1);
  expect(panel.element.dataset.mode).toBe("idle");
  expect(draftOf(panel.element)).toBe("这是第一句。");
});

test("a refused microphone explains itself instead of showing a dead button", async () => {
  const { panel } = await panelWith({
    getStream: async () => {
      throw new Error("denied");
    },
  });
  expect(panel.element.dataset.mode).toBe("denied");
  expect(role(panel.element, "record")).toBeNull();
  expect(panel.element.textContent).toContain("voice.denied");
});

// A failed take must not take the sentences already collected with it.
test("a failed transcription says so and keeps the draft", async () => {
  let fail = false;
  const { panel } = await panelWith({
    transcribe: async () => {
      if (fail) throw new Error("502");
      return "这是第一句。";
    },
  });
  await dictate(panel.element);
  fail = true;
  await dictate(panel.element);
  expect(panel.element.textContent).toContain("voice.failed");
  expect(draftOf(panel.element)).toBe("这是第一句。");
  expect(role(panel.element, "record")).not.toBeNull();
});

test("silence says so and keeps the draft", async () => {
  let silent = false;
  const { panel } = await panelWith({
    transcribe: async () => (silent ? "" : "这是第一句。"),
  });
  await dictate(panel.element);
  silent = true;
  await dictate(panel.element);
  expect(panel.element.textContent).toContain("voice.empty");
  expect(draftOf(panel.element)).toBe("这是第一句。");
});

// iOS shows a system-wide recording indicator for as long as a track is live;
// leaving it on after the panel is gone would be a lie.
test("closing releases the microphone and tells the host", async () => {
  const { panel, calls, tracks } = await panelWith();
  panel.close();
  expect(tracks[0]!.stopped).toBe(true);
  expect(calls.closed).toBe(1);
  expect(panel.element.isConnected).toBe(false);
});

// --- joining takes ----------------------------------------------------------

test("takes join without a space in CJK and with one between words", async () => {
  mountDom();
  const { joinTakes } = await import("../public/voice-panel.js");
  // Chinese needs no separator; the recogniser already supplies punctuation.
  expect(joinTakes("这是第一句。", "这是第二句。")).toBe("这是第一句。这是第二句。");
  // English would otherwise run together into one unreadable word.
  expect(joinTakes("fix the hook", "then run the tests")).toBe("fix the hook then run the tests");
  // A full stop still needs the space after it when words follow.
  expect(joinTakes("fix the hook.", "then run it")).toBe("fix the hook. then run it");
  // Crossing scripts, the CJK side decides: no space.
  expect(joinTakes("这是第一句。", "then run it")).toBe("这是第一句。then run it");
  expect(joinTakes("", "first")).toBe("first");
  expect(joinTakes("first", "")).toBe("first");
});
