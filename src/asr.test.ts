import { test, expect, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, statSync } from "node:fs";
import {
  asrPath,
  readAsrConfig,
  writeAsrConfig,
  transcribe,
  ASR_ENDPOINT,
  DEFAULT_RESOURCE_ID,
  type Fetch,
} from "./asr";

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

// --- forwarding to the recogniser -------------------------------------------
//
// Every test here uses an injected fetch. Hitting the real endpoint would cost
// money, need the network, and require a private credential in CI — and the
// key in this file is deliberately fake.

const CONFIG = { key: "fake-key-0000", resourceId: "volc.bigasr.auc_turbo" };

const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

/** Records the calls it receives and answers with whatever the test wants. */
function stubFetch(reply: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl: Fetch = async (url, init) => {
    calls.push({ url, init });
    return reply;
  };
  return { impl, calls };
}

function ok(text: string) {
  return new Response(JSON.stringify({ result: { text } }), {
    headers: { "x-api-status-code": "20000000" },
  });
}

test("the upstream request carries the key, the resource id and the audio", async () => {
  const { impl, calls } = stubFetch(ok("这是一个测试"));

  const result = await transcribe(bytes("PRETEND-AUDIO"), CONFIG, "req-1", impl);
  expect(result).toEqual({ ok: true, text: "这是一个测试" });

  expect(calls).toHaveLength(1);
  const { url, init } = calls[0]!;
  expect(url).toBe(ASR_ENDPOINT);
  expect(init.method).toBe("POST");

  const headers = init.headers as Record<string, string>;
  expect(headers["X-Api-Key"]).toBe("fake-key-0000");
  expect(headers["X-Api-Resource-Id"]).toBe("volc.bigasr.auc_turbo");
  expect(headers["X-Api-Request-Id"]).toBe("req-1");

  const body = JSON.parse(String(init.body));
  expect(Buffer.from(body.audio.data, "base64").toString()).toBe("PRETEND-AUDIO");
  // The endpoint sniffs the container; a format field would only be a lie
  // waiting to be believed.
  expect(body.audio.format).toBeUndefined();
});

test("empty audio is refused without reaching the network", async () => {
  const { impl, calls } = stubFetch(ok("never"));
  const result = await transcribe(new ArrayBuffer(0), CONFIG, "req-2", impl);
  expect(result).toEqual({ ok: false, status: 400, error: "empty" });
  expect(calls).toHaveLength(0);
});

test("a bad credential is reported as such, not as a generic failure", async () => {
  const { impl } = stubFetch(
    new Response(JSON.stringify({ header: { message: "Invalid X-Api-Key" } }), {
      status: 401,
      headers: { "x-api-status-code": "45000010" },
    }),
  );
  expect(await transcribe(bytes("a"), CONFIG, "r", impl)).toEqual({
    ok: false,
    status: 502,
    error: "credential",
  });
});

test("any other upstream complaint surfaces its message", async () => {
  const { impl } = stubFetch(
    new Response("{}", {
      status: 400,
      headers: { "x-api-status-code": "45000000", "x-api-message": "error params" },
    }),
  );
  const result = await transcribe(bytes("a"), CONFIG, "r", impl);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBe("error params");
});

// The endpoint answers 200 with the failure in a header, so the status line
// alone cannot tell success from failure.
test("a 200 with no text is a failure, not an empty success", async () => {
  const { impl } = stubFetch(
    new Response("{}", {
      status: 200,
      headers: { "x-api-status-code": "45000000", "x-api-message": "error params" },
    }),
  );
  expect((await transcribe(bytes("a"), CONFIG, "r", impl)).ok).toBe(false);
});

test("silence comes back as an empty string, which is a success", async () => {
  const { impl } = stubFetch(ok(""));
  expect(await transcribe(bytes("a"), CONFIG, "r", impl)).toEqual({ ok: true, text: "" });
});

test("a network failure is caught rather than thrown at the caller", async () => {
  const impl: Fetch = async () => {
    throw new Error("offline");
  };
  expect(await transcribe(bytes("a"), CONFIG, "r", impl)).toEqual({
    ok: false,
    status: 502,
    error: "network",
  });
});
