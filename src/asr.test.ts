import { test, expect, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, statSync } from "node:fs";
import { asrPath, readAsrConfig, writeAsrConfig, DEFAULT_RESOURCE_ID } from "./asr";

// A throwaway path per run, so the suite never reads or writes the real
// ~/.tmux-next/asr.json — which on a developer's machine holds a live key.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "asr-test-"));
  process.env.TMUX_NEXT_ASR_PATH = join(dir, "asr.json");
});

test("the path follows the environment override", () => {
  expect(asrPath()).toBe(join(dir, "asr.json"));
});

test("a missing file reads as unconfigured", async () => {
  expect(await readAsrConfig()).toBeNull();
});

test("unreadable JSON reads as unconfigured rather than throwing", async () => {
  await Bun.write(asrPath(), "{not json");
  expect(await readAsrConfig()).toBeNull();
});

test("a key round-trips and gets the default resource id", async () => {
  expect(await writeAsrConfig("fake-key-0000")).toBe(true);
  expect(await readAsrConfig()).toEqual({
    key: "fake-key-0000",
    resourceId: DEFAULT_RESOURCE_ID,
  });
});

test("a resource id already in the file is preserved", async () => {
  await Bun.write(
    asrPath(),
    JSON.stringify({ key: "fake-key-0000", resourceId: "volc.bigasr.next" }),
  );
  expect((await readAsrConfig())?.resourceId).toBe("volc.bigasr.next");
});

test("a file without a usable key reads as unconfigured", async () => {
  for (const bad of [{}, { key: "" }, { key: "   " }, { key: 42 }, { key: null }]) {
    await Bun.write(asrPath(), JSON.stringify(bad));
    expect(await readAsrConfig()).toBeNull();
  }
});

test("a non-string or blank key is refused and nothing is written", async () => {
  for (const bad of [null, undefined, 42, {}, [], "", "   "]) {
    expect(await writeAsrConfig(bad)).toBe(false);
  }
  expect(await readAsrConfig()).toBeNull();
});

test("surrounding whitespace is trimmed off a pasted key", async () => {
  expect(await writeAsrConfig("  fake-key-0000\n")).toBe(true);
  expect((await readAsrConfig())?.key).toBe("fake-key-0000");
});

// A credential, so it must not be world-readable — the rest of ~/.tmux-next is
// ordinary state, this one file is not.
test("the file is written 0600", async () => {
  await writeAsrConfig("fake-key-0000");
  expect(statSync(asrPath()).mode & 0o777).toBe(0o600);
});
