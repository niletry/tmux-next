#!/usr/bin/env bun
import { HELP, MIN_TMUX, meetsMinimum, parseArgs, parseTmuxVersion } from "./cli";
import { startServer } from "./server";
// Read from package.json so `--version` can never drift from the published one.
import pkg from "../package.json" with { type: "json" };

const VERSION = pkg.version;

/**
 * Refuses to start on a tmux that cannot do what this depends on.
 *
 * Failing here is much kinder than failing later: on an old tmux the sizing
 * command is simply not understood, so the terminal comes up at the wrong
 * width and nothing ever says why.
 */
async function checkTmux(): Promise<string | null> {
  let out: string;
  try {
    const proc = Bun.spawn(["tmux", "-V"], { stdout: "pipe", stderr: "pipe" });
    out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return "tmux is installed but `tmux -V` failed";
  } catch {
    return "tmux was not found on PATH — install tmux first";
  }

  const found = parseTmuxVersion(out);
  const need = `${MIN_TMUX.major}.${MIN_TMUX.minor}`;
  if (!found) {
    return `could not read a version from \`tmux -V\` (${out.trim()}); ${need}+ is required`;
  }
  if (!meetsMinimum(found, MIN_TMUX)) {
    return `tmux ${found.major}.${found.minor} is too old — ${need} or newer is required`;
  }
  return null;
}

const parsed = parseArgs(process.argv.slice(2));

if (parsed.kind === "help") {
  console.log(HELP);
  process.exit(0);
}

if (parsed.kind === "version") {
  console.log(VERSION);
  process.exit(0);
}

if (parsed.kind === "error") {
  console.error(`tmux-next: ${parsed.message}`);
  console.error("try --help");
  process.exit(2);
}

const problem = await checkTmux();
if (problem) {
  console.error(`tmux-next: ${problem}`);
  process.exit(1);
}

const server = startServer(parsed.port, parsed.host);
console.log(`listening on http://${parsed.host}:${server.port}`);

// Binding beyond loopback breaks the assumption the whole design rests on:
// that a reverse proxy is doing TLS and authentication.
if (parsed.host !== "127.0.0.1" && parsed.host !== "localhost") {
  console.warn(
    `warning: bound to ${parsed.host}, reachable from the network.\n` +
      "         This service has no authentication of its own.",
  );
}
