import { test, expect } from "bun:test";
import { createVoiceRecorder } from "../public/voice-recorder.js";

/**
 * A MediaRecorder stand-in.
 *
 * The real one only exists in a browser and behaves differently across iOS
 * versions, but the part that has bugs in it is the sequencing: what a second
 * tap does, what happens when stop arrives before any data, whether a cancelled
 * take can still be sent. So the recorder arrives through a factory and all of
 * that becomes testable headlessly.
 */
class FakeRecorder {
  mimeType = "audio/webm;codecs=opus";
  started = false;
  stopped = false;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
    this.ondataavailable?.({ data: new Blob(["0123456789"]) });
    this.onstop?.();
  }
}

function harness() {
  const made: FakeRecorder[] = [];
  let clock = 1000;
  const rec = createVoiceRecorder({
    makeRecorder: () => {
      const r = new FakeRecorder();
      made.push(r);
      return r;
    },
    now: () => clock,
  });
  return { rec, made, tick: (ms: number) => { clock += ms; } };
}

const STREAM = {} as unknown;

test("it starts idle", () => {
  expect(harness().rec.state).toBe("idle");
});

test("starting moves it to recording and starts the recorder", () => {
  const { rec, made } = harness();
  expect(rec.start(STREAM)).toBe(true);
  expect(rec.state).toBe("recording");
  expect(made).toHaveLength(1);
  expect(made[0]!.started).toBe(true);
});

// A double tap on the record button must not leave a second recorder running
// against the same stream, which would then never be stopped.
test("starting twice does not create a second recorder", () => {
  const { rec, made } = harness();
  rec.start(STREAM);
  expect(rec.start(STREAM)).toBe(false);
  expect(made).toHaveLength(1);
});

test("stopping yields a blob carrying the recorder's own mime type", async () => {
  const { rec } = harness();
  rec.start(STREAM);
  const blob = await rec.stop();
  expect(blob).not.toBeNull();
  expect(blob!.type).toBe("audio/webm;codecs=opus");
  expect(blob!.size).toBe(10);
  expect(rec.state).toBe("idle");
});

test("cancelling stops the recorder but yields nothing", async () => {
  const { rec, made } = harness();
  rec.start(STREAM);
  expect(await rec.cancel()).toBeNull();
  expect(made[0]!.stopped).toBe(true);
  expect(rec.state).toBe("idle");
});

test("stopping when it never started yields nothing", async () => {
  expect(await harness().rec.stop()).toBeNull();
});

test("elapsed time comes from the injected clock and is zero when idle", () => {
  const { rec, tick } = harness();
  expect(rec.elapsedMs()).toBe(0);
  rec.start(STREAM);
  tick(2500);
  expect(rec.elapsedMs()).toBe(2500);
});

// Tapping stop the instant after start can produce no chunks at all. Sending an
// empty body upstream would be a wasted round trip and a confusing error, so it
// counts as nothing recorded.
test("a recording with no data yields nothing", async () => {
  const rec = createVoiceRecorder({
    makeRecorder: () => {
      const r = new FakeRecorder();
      r.stop = function (this: FakeRecorder) {
        this.onstop?.();
      };
      return r;
    },
  });
  rec.start(STREAM);
  expect(await rec.stop()).toBeNull();
});
