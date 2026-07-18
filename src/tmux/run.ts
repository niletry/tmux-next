export type TmuxResult = { ok: boolean; stdout: string; stderr: string };

/**
 * Runs a tmux command with an argv array — no shell involved.
 *
 * Bun.$ is a shell: it applies word splitting to interpolated values, and that
 * behaviour depends on the environment. Under launchd (a bare environment) a
 * tab inside a `-F` format string was silently rewritten to an underscore,
 * which corrupted every parsed field while working fine in an interactive
 * shell. Session names containing spaces would break the same way.
 *
 * Passing argv straight to the process removes the entire class of bug.
 */
export async function tmux(args: string[]): Promise<TmuxResult> {
  const proc = Bun.spawn(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    // Without a UTF-8 locale tmux sanitises non-ASCII and control bytes in its
    // output — CJK text in capture-pane comes back mangled. launchd starts the
    // service with an empty environment, so the locale must be forced here.
    env: {
      ...process.env,
      LANG: process.env.LANG ?? "en_US.UTF-8",
      LC_CTYPE: process.env.LC_CTYPE ?? "en_US.UTF-8",
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout, stderr };
}
