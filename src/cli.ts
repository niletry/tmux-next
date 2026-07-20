/**
 * Argument parsing and the tmux preflight, kept apart from the process so both
 * can be tested without spawning anything.
 */

export const DEFAULT_PORT = 7682;

/**
 * Loopback by default, and changing it is a deliberate act.
 *
 * There is no authentication in this service at all — it expects to sit behind
 * a reverse proxy that provides TLS and auth. Binding it to a public interface
 * hands anyone who can reach the port a shell on the machine.
 */
export const DEFAULT_HOST = "127.0.0.1";

export type TmuxVersion = { major: number; minor: number };

/**
 * Every resize is sent as `refresh-client -C <cols>,<rows>`. The comma form
 * arrived in tmux 3.2; before that the flag took `<cols>x<rows>` and this one
 * is simply not understood, so the terminal would silently never resize.
 */
export const MIN_TMUX: TmuxVersion = { major: 3, minor: 2 };

export type CliResult =
  | { kind: "run"; port: number; host: string }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

export function parseArgs(argv: string[]): CliResult {
  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--version" || arg === "-v") return { kind: "version" };

    if (arg === "--port" || arg === "-p") {
      const raw = argv[++i];
      // Checked rather than coerced: `--port` with nothing after it would
      // otherwise become NaN and fall back to the default without a word.
      if (raw === undefined) return { kind: "error", message: "--port needs a number" };
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        return { kind: "error", message: `--port must be 1-65535, got "${raw}"` };
      }
      port = n;
      continue;
    }

    if (arg === "--host") {
      const raw = argv[++i];
      if (raw === undefined) return { kind: "error", message: "--host needs an address" };
      host = raw;
      continue;
    }

    return { kind: "error", message: `unknown option "${arg}"` };
  }

  return { kind: "run", port, host };
}

/** Reads `tmux -V` output. Handles letter suffixes (3.7b) and next- builds. */
export function parseTmuxVersion(output: string): TmuxVersion | null {
  const m = output.match(/(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

export function meetsMinimum(found: TmuxVersion, min: TmuxVersion): boolean {
  if (found.major !== min.major) return found.major > min.major;
  return found.minor >= min.minor;
}

export const HELP = `tmux-next — a phone-friendly web client for your tmux sessions

Usage:
  tmux-next [options]

Options:
  -p, --port <n>     port to listen on (default ${DEFAULT_PORT})
      --host <addr>  address to bind (default ${DEFAULT_HOST})
  -h, --help         show this help
  -v, --version      show the version

The server speaks plain HTTP and has no authentication of its own. It binds to
loopback so that it is unreachable from the network; to use it from a phone,
put a reverse proxy in front that terminates TLS and authenticates. Changing
--host without doing that exposes a shell to anyone who can reach the port.

Requires tmux ${MIN_TMUX.major}.${MIN_TMUX.minor} or newer.`;
