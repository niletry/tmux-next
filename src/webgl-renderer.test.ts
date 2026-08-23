import { test, expect } from "bun:test";
import { createWebglRenderer } from "../public/webgl-renderer.js";

/**
 * Keeping the terminal on the WebGL renderer across a lost GPU context.
 *
 * The addon fires onContextLoss only after its own 3s restoration window has
 * failed, and does not dispose itself. Left alone, the terminal keeps a dead
 * renderer — which is what a phone hits after being backgrounded.
 */

type FakeAddon = {
  disposed: number;
  fireLoss: () => void;
  onContextLoss: (cb: () => void) => void;
  dispose: () => void;
};

function harness(opts: { failOn?: number[] } = {}) {
  const loaded: FakeAddon[] = [];
  const pending: Array<() => void> = [];
  let built = 0;

  const makeAddon = () => {
    if (opts.failOn?.includes(built++)) throw new Error("no webgl");
    let lossCb = () => {};
    const addon: FakeAddon = {
      disposed: 0,
      fireLoss: () => lossCb(),
      onContextLoss: (cb) => { lossCb = cb; },
      dispose: () => { addon.disposed++; },
    };
    return addon;
  };

  const term = { loadAddon: (a: unknown) => { loaded.push(a as FakeAddon); } };
  const renderer = createWebglRenderer({
    term,
    makeAddon,
    retryDelay: 500,
    maxRetries: 2,
    schedule: (fn: () => void) => { pending.push(fn); return 0; },
  });

  return { renderer, loaded, flush: () => { const q = pending.splice(0); for (const f of q) f(); } };
}

test("starting loads the addon and reports WebGL active", () => {
  const h = harness();
  expect(h.renderer.start()).toBe(true);
  expect(h.renderer.active).toBe(true);
  expect(h.loaded.length).toBe(1);
});

test("a renderer that cannot be created falls back without throwing", () => {
  const h = harness({ failOn: [0] });
  expect(h.renderer.start()).toBe(false);
  expect(h.renderer.active).toBe(false);
  expect(h.loaded.length).toBe(0);
});

test("a lost context disposes the dead addon and rebuilds", () => {
  const h = harness();
  h.renderer.start();
  h.loaded[0].fireLoss();
  // Disposed immediately: until it goes, xterm keeps rendering through a dead
  // context instead of falling back to the DOM renderer.
  expect(h.loaded[0].disposed).toBe(1);
  expect(h.renderer.active).toBe(false);
  h.flush();
  expect(h.loaded.length).toBe(2);
  expect(h.renderer.active).toBe(true);
});

test("each rebuild re-arms, so a second loss is handled too", () => {
  const h = harness();
  h.renderer.start();
  h.loaded[0].fireLoss();
  h.flush();
  h.loaded[1].fireLoss();
  expect(h.loaded[1].disposed).toBe(1);
  h.flush();
  expect(h.loaded.length).toBe(3);
});

test("repeated losses give up after the retry budget", () => {
  const h = harness();
  h.renderer.start();
  for (let i = 0; i < 5; i++) {
    const last = h.loaded[h.loaded.length - 1];
    last.fireLoss();
    h.flush();
  }
  // 1 initial + 2 retries, then it stays on the DOM renderer rather than
  // thrashing the GPU on a device that has taken the context away for good.
  expect(h.loaded.length).toBe(3);
  expect(h.renderer.active).toBe(false);
});

test("a rebuild that throws is not fatal and still counts against the budget", () => {
  const h = harness({ failOn: [1, 2] });
  expect(h.renderer.start()).toBe(true);
  h.loaded[0].fireLoss();
  h.flush();
  expect(h.renderer.active).toBe(false);
  h.loaded[0].fireLoss();
  h.flush();
  expect(h.renderer.active).toBe(false);
  expect(h.loaded.length).toBe(1);
});

test("the dead addon is disposed once, not on every later event", () => {
  const h = harness();
  h.renderer.start();
  h.loaded[0].fireLoss();
  h.loaded[0].fireLoss();
  expect(h.loaded[0].disposed).toBe(1);
});
