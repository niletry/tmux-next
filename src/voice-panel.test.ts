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

const track = () => ({ stopped: false, stop(this: { stopped: boolean }) { this.stopped = true; } });

async function panelWith(over: Record<string, unknown> = {}) {
  mountDom();
  const { createVoicePanel } = await import("../public/voice-panel.js");
  const tracks = [track()];
  const calls = { transcribed: 0, inserted: [] as string[], closed: 0 };
  const panel = createVoicePanel({
    getStream: async () => ({ getTracks: () => tracks }),
    makeRecorder: () => new FakeRecorder(),
    transcribe: async () => {
      calls.transcribed++;
      return "把 hook 修好";
    },
    onInsert: (t: string) => calls.inserted.push(t),
    onClose: () => { calls.closed++; },
    tr: (k: string) => k,
    ...over,
  });
  document.body.append(panel.element);
  await panel.open();
  return { panel, calls, tracks };
}

const role = (el: HTMLElement, name: string) =>
  el.querySelector(`[data-role="${name}"]`) as HTMLElement | null;

test("an opened panel offers the record button", async () => {
  const { panel } = await panelWith();
  expect(panel.element.dataset.mode).toBe("idle");
  expect(role(panel.element, "record")).not.toBeNull();
});

test("the one state button switches to recording, and cancel appears with it", async () => {
  const { panel } = await panelWith();
  role(panel.element, "record")!.click();
  expect(panel.element.dataset.mode).toBe("recording");
  // Still one button, not a second control appearing beside the first.
  expect(panel.element.querySelectorAll('[data-role="record"]')).toHaveLength(1);
  expect(role(panel.element, "cancel")).not.toBeNull();
});

test("stopping transcribes and shows the text for review", async () => {
  const { panel, calls } = await panelWith();
  role(panel.element, "record")!.click();
  role(panel.element, "record")!.click();
  await flush();
  expect(calls.transcribed).toBe(1);
  expect(panel.element.dataset.mode).toBe("review");
  const box = panel.element.querySelector("textarea") as HTMLTextAreaElement;
  expect(box.value).toBe("把 hook 修好");
});

// The whole point of the review box: what gets inserted is what the user
// approved, not what the recogniser guessed.
test("inserting sends the edited text, not the recognised text", async () => {
  const { panel, calls } = await panelWith();
  role(panel.element, "record")!.click();
  role(panel.element, "record")!.click();
  await flush();
  const box = panel.element.querySelector("textarea") as HTMLTextAreaElement;
  box.value = "把 hook 修好，再跑一遍测试";
  role(panel.element, "insert")!.click();
  expect(calls.inserted).toEqual(["把 hook 修好，再跑一遍测试"]);
});

// Dictation comes in bursts: say a sentence, look at what landed, say the next.
// Closing after one insert would mean reopening and re-granting attention for
// every sentence.
test("inserting leaves the panel open and ready for the next sentence", async () => {
  const { panel, calls, tracks } = await panelWith();
  role(panel.element, "record")!.click();
  role(panel.element, "record")!.click();
  await flush();
  role(panel.element, "insert")!.click();

  expect(panel.element.dataset.mode).toBe("idle");
  expect(role(panel.element, "record")).not.toBeNull();
  expect(panel.element.isConnected).toBe(true);
  expect(calls.closed).toBe(0);
  // Still holding the microphone, so the next take starts without a new prompt.
  expect(tracks[0]!.stopped).toBe(false);

  // And a second round really works, rather than merely looking ready.
  role(panel.element, "record")!.click();
  role(panel.element, "record")!.click();
  await flush();
  role(panel.element, "insert")!.click();
  expect(calls.inserted).toHaveLength(2);
});

// The old take must not linger in the box on the next round.
test("a second recording starts from an empty review box", async () => {
  const { panel } = await panelWith();
  role(panel.element, "record")!.click();
  role(panel.element, "record")!.click();
  await flush();
  (panel.element.querySelector("textarea") as HTMLTextAreaElement).value = "改过的内容";
  role(panel.element, "insert")!.click();
  expect(panel.element.querySelector("textarea")).toBeNull();
});

test("cancelling a recording transcribes nothing and returns to idle", async () => {
  const { panel, calls } = await panelWith();
  role(panel.element, "record")!.click();
  role(panel.element, "cancel")!.click();
  await flush();
  expect(calls.transcribed).toBe(0);
  expect(panel.element.dataset.mode).toBe("idle");
});

test("a refused microphone explains itself instead of showing a dead button", async () => {
  const { panel } = await panelWith({
    getStream: async () => {
      throw new Error("denied");
    },
  });
  expect(panel.element.dataset.mode).toBe("error");
  expect(role(panel.element, "record")).toBeNull();
  expect(panel.element.textContent).toContain("voice.denied");
});

test("a failed transcription says so and offers another take", async () => {
  const { panel } = await panelWith({
    transcribe: async () => {
      throw new Error("502");
    },
  });
  role(panel.element, "record")!.click();
  role(panel.element, "record")!.click();
  await flush();
  expect(panel.element.dataset.mode).toBe("error");
  expect(role(panel.element, "again")).not.toBeNull();
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
