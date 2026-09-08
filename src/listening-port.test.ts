import { expect, test } from "bun:test";
import { DEFAULT_PORT } from "./cli";

// Other test files in the same `bun test` process call `startServer()` for
// real and it calls `setListeningPort()`, so the shared module-level state is
// not reliably "unset" from this file's point of view — a plain import here
// could observe whatever the last test file that started a server left
// behind. A cache-busting query string gives each test a fresh module
// instance, the same trick `src/*-page.test.ts` files use for happy-dom
// globals, so "never set" is actually never set for this instance.
async function freshModule() {
  return import(`./listening-port.ts?t=${Math.random()}`) as Promise<
    typeof import("./listening-port")
  >;
}

test("未设置过时回落到 CLI 的默认端口", async () => {
  const { getListeningPort } = await freshModule();
  expect(getListeningPort()).toBe(DEFAULT_PORT);
});

test("设置后原样读回", async () => {
  const { getListeningPort, setListeningPort } = await freshModule();
  setListeningPort(54321);
  expect(getListeningPort()).toBe(54321);
});
