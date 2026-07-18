import { afterAll, beforeAll, expect, test } from "bun:test";
import { ControlClient } from "./control-client";

const SESSION = "cc-test-" + Math.random().toString(36).slice(2, 8);

beforeAll(async () => {
  await Bun.$`tmux new-session -d -s ${SESSION} -x 80 -y 24`.quiet();
});

afterAll(async () => {
  await Bun.$`tmux kill-session -t ${SESSION}`.quiet().nothrow();
});

test("runs a command and returns its output lines", async () => {
  const client = await ControlClient.attach(SESSION);
  const lines = await client.command(`display-message -p -t ${SESSION} '#{session_name}'`);
  expect(lines).toEqual([SESSION]);
  client.close();
});

test("rejects when tmux reports an error", async () => {
  const client = await ControlClient.attach(SESSION);
  // Note: `display-message -t <bad>` silently falls back to the current
  // session in tmux 3.7, so it is not a usable error case. has-session is.
  await expect(client.command("has-session -t no-such-session-xyz")).rejects.toThrow(
    /can't find session/,
  );
  client.close();
});

test("keeps command results in order under concurrency", async () => {
  const client = await ControlClient.attach(SESSION);
  const [a, b, c] = await Promise.all([
    client.command("display-message -p 'one'"),
    client.command("display-message -p 'two'"),
    client.command("display-message -p 'three'"),
  ]);
  expect([a[0], b[0], c[0]]).toEqual(["one", "two", "three"]);
  client.close();
});

test("delivers pane output to the registered listener", async () => {
  const client = await ControlClient.attach(SESSION);
  const paneId = (await client.command(`display-message -p -t ${SESSION} '#{pane_id}'`))[0]!;

  let seen = "";
  const stop = client.onOutput(paneId, (d) => {
    seen += new TextDecoder().decode(d);
  });

  await client.command(`send-keys -t ${paneId} 'echo MARKER_9f3a' Enter`);
  await Bun.sleep(700);

  expect(seen).toContain("MARKER_9f3a");
  stop();
  client.close();
});

test("attach rejects for a session that does not exist", async () => {
  await expect(ControlClient.attach("no-such-session-xyz")).rejects.toThrow();
});

test("pending commands reject once the client is closed", async () => {
  const client = await ControlClient.attach(SESSION);
  client.close();
  await expect(client.command("display-message -p 'x'")).rejects.toThrow();
});
