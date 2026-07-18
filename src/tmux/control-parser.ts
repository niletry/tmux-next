export type ControlEvent =
  | { type: "block"; commandNumber: number; ok: boolean; lines: string[] }
  | { type: "output"; paneId: string; data: Uint8Array }
  | { type: "notification"; name: string; args: string[] };

const OCTAL = /[0-7]/;

/**
 * tmux escapes non-printable bytes and backslash as octal \xxx inside %output.
 * A backslash not followed by three octal digits is a literal backslash.
 *
 * Accepts both a "binary" string (one char per byte, as produced by the
 * parser's buffer) and a normal JS string; code points above 0xff are
 * re-encoded as UTF-8.
 */
export function unescapeOctal(s: string): Uint8Array {
  const out: number[] = [];
  const encoder = new TextEncoder();

  for (let i = 0; i < s.length; i++) {
    if (
      s[i] === "\\" &&
      OCTAL.test(s[i + 1] ?? "") &&
      OCTAL.test(s[i + 2] ?? "") &&
      OCTAL.test(s[i + 3] ?? "")
    ) {
      out.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 3;
      continue;
    }

    const code = s.charCodeAt(i);
    if (code <= 0xff) {
      out.push(code);
    } else {
      for (const b of encoder.encode(s[i]!)) out.push(b);
    }
  }
  return new Uint8Array(out);
}

/**
 * Splits a tmux control mode stream into typed events.
 *
 * Relies on the documented guarantee that a notification never occurs inside
 * an output block, so a single in-block flag is enough to disambiguate.
 */
export class ControlParser {
  #buf = "";
  #inBlock = false;
  #blockNumber = 0;
  #blockLines: string[] = [];

  push(chunk: Uint8Array): ControlEvent[] {
    // "binary" keeps one char per byte so octal unescaping stays byte-exact
    // and multibyte characters split across chunks are reassembled intact.
    this.#buf += Buffer.from(chunk).toString("binary");

    const events: ControlEvent[] = [];
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) !== -1) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      const event = this.#line(line);
      if (event) events.push(event);
    }
    return events;
  }

  #line(line: string): ControlEvent | null {
    if (this.#inBlock) {
      if (line.startsWith("%end ") || line.startsWith("%error ")) {
        this.#inBlock = false;
        return {
          type: "block",
          commandNumber: this.#blockNumber,
          ok: line.startsWith("%end "),
          lines: this.#blockLines,
        };
      }
      this.#blockLines.push(decodeUtf8(line));
      return null;
    }

    if (line.startsWith("%begin ")) {
      this.#inBlock = true;
      this.#blockNumber = Number(line.split(" ")[2]);
      this.#blockLines = [];
      return null;
    }

    if (line.startsWith("%output ")) {
      const sp = line.indexOf(" ", 8);
      return {
        type: "output",
        paneId: line.slice(8, sp),
        data: unescapeOctal(line.slice(sp + 1)),
      };
    }

    if (line.startsWith("%")) {
      const parts = decodeUtf8(line).slice(1).split(" ");
      return { type: "notification", name: parts[0]!, args: parts.slice(1) };
    }

    return null;
  }
}

/** Block and notification lines arrive as binary strings; make them real text. */
function decodeUtf8(binary: string): string {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
