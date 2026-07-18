import { expect, test } from "bun:test";
import { ControlParser, unescapeOctal } from "./control-parser";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder().decode(u);

test("unescapeOctal decodes octal escapes and passes printable bytes through", () => {
  expect(dec(unescapeOctal("hello"))).toBe("hello");
  expect(dec(unescapeOctal("\\033[38;5;12m"))).toBe("\x1b[38;5;12m");
  expect(dec(unescapeOctal("a\\015\\012b"))).toBe("a\r\nb");
});

test("unescapeOctal treats a backslash not followed by octal as a literal", () => {
  expect(dec(unescapeOctal("C:\\path"))).toBe("C:\\path");
});

test("unescapeOctal round-trips multibyte utf-8", () => {
  expect(dec(unescapeOctal("中文 ✻"))).toBe("中文 ✻");
});

test("parses an output block into a single block event", () => {
  const p = new ControlParser();
  const events = p.push(enc(
    "%begin 1363006971 2 1\n" +
    "0: ksh* (1 panes) [80x24]\n" +
    "%end 1363006971 2 1\n"
  ));
  expect(events).toEqual([
    { type: "block", commandNumber: 2, ok: true, lines: ["0: ksh* (1 panes) [80x24]"] },
  ]);
});

test("marks a block ending in %error as not ok", () => {
  const p = new ControlParser();
  const events = p.push(enc("%begin 1 7 1\n" + "no such session\n" + "%error 1 7 1\n"));
  expect(events).toEqual([
    { type: "block", commandNumber: 7, ok: false, lines: ["no such session"] },
  ]);
});

test("parses %output into pane id and unescaped bytes", () => {
  const p = new ControlParser();
  const events = p.push(enc("%output %3 hi\\033[0m\n"));
  expect(events.length).toBe(1);
  const e = events[0]!;
  if (e.type !== "output") throw new Error("wrong type");
  expect(e.paneId).toBe("%3");
  expect(dec(e.data)).toBe("hi\x1b[0m");
});

test("parses other notifications generically", () => {
  const p = new ControlParser();
  const events = p.push(enc("%window-add @14\n%sessions-changed\n"));
  expect(events).toEqual([
    { type: "notification", name: "window-add", args: ["@14"] },
    { type: "notification", name: "sessions-changed", args: [] },
  ]);
});

test("reassembles events split across chunk boundaries", () => {
  const p = new ControlParser();
  expect(p.push(enc("%outp"))).toEqual([]);
  expect(p.push(enc("ut %1 ab"))).toEqual([]);
  const events = p.push(enc("c\n"));
  expect(events.length).toBe(1);
  const e = events[0]!;
  if (e.type !== "output") throw new Error("wrong type");
  expect(dec(e.data)).toBe("abc");
});

test("does not treat a %-prefixed line inside a block as a notification", () => {
  const p = new ControlParser();
  const events = p.push(enc("%begin 1 3 1\n" + "%output is documented\n" + "%end 1 3 1\n"));
  expect(events).toEqual([
    { type: "block", commandNumber: 3, ok: true, lines: ["%output is documented"] },
  ]);
});

test("splits a multibyte character across chunks without corrupting it", () => {
  const p = new ControlParser();
  const full = enc("%output %1 中\n");
  p.push(full.slice(0, 12));
  const events = p.push(full.slice(12));
  expect(events.length).toBe(1);
  const e = events[0]!;
  if (e.type !== "output") throw new Error("wrong type");
  expect(dec(e.data)).toBe("中");
});
