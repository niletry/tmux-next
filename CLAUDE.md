# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run src/index.ts        # run the server (default 127.0.0.1:7682)
bun run typecheck           # tsc --noEmit
bun test                    # full suite (typecheck is NOT included here)
bun run test                # typecheck + bun test — what CI effectively does
bun test src/geometry.test.ts            # one file
bun test src/tmux/                       # one directory
bun test -t "dragging down by one line"  # one test by name
```

Bun only — no build step, no bundler. `src/index.ts` is the `bin` entry and ships as uncompiled TypeScript; node cannot run this package. tmux 3.2+ is required and startup refuses to run below it (`refresh-client -C <cols>,<rows>` comma form).

Publishing: push a `v<version>` tag matching `package.json`; `.github/workflows/publish.yml` publishes to npm via OIDC trusted publishing (no token, no OTP).

## Architecture

Browser (xterm.js) ⇄ WebSocket ⇄ Bun server ⇄ `tmux -C attach` (control mode) ⇄ tmux server.

**Control mode, not a PTY running `tmux attach`.** tmux speaks a structured protocol: output arrives per-pane as `%output %3 …`, and commands have request/response semantics. That is what lets the browser render one pane with no tmux status bar or split borders. `ControlClient` (`src/tmux/control-client.ts`) owns the subprocess; responses are matched to requests by a FIFO queue because tmux returns blocks in send order. `ControlParser` is the pure, DOM-free protocol parser.

**One browser connection = one disposable grouped session.** `PaneSession.open()` creates `web-<pid>-<random>` via `createWebSession`, attaches a control client to it, seeds the browser with `capture-pane`, then forwards live output batched at 16ms frames. On close it destroys the session and runs `resize-window -A` to hand the size back to remaining clients. The pid in the name makes orphan collection decidable from outside the process — `reapOrphanWebSessions` runs on startup and every 60s (`src/tmux/session-manager.ts`).

**The seed must restore terminal *modes*, not just content.** `capture-pane` returns text; the seed's `\x1b[2J\x1b[H` clears modes. Without replaying the mouse-tracking DECSETs (`mouseModeSeed`, driven by tmux's `#{mouse_*_flag}`), a program that uses the mouse comes back with tracking off and xterm never binds its wheel handler — scrolling silently dies.

**Server** (`src/server.ts`): a single `fetch` dispatching on pathname (no route table), plus the `/ws` upgrade. All state modules under `src/` are leaf modules it composes. Static files come straight from `public/`, and xterm.js is served out of `node_modules/`.

**Front-end** (`public/`): plain ES modules loaded directly by the browser, no framework, no build. UI strings live in `public/i18n.js` — never inline. `src/i18n.test.ts` scans every `t("…")`, `tr("…")` and `data-i18n` against both dictionaries and fails on a key that is missing, a key that is unused, or a key present in one language and not the other. That last case is the one worth having: a key missing from English is invisible to a Chinese-speaking author. Pure logic that can be tested headlessly (`scroll-gesture.js`, `terminal-fit.js`, `dir-filter.js`, `copy-on-select.js`) is split into `// @ts-check`ed modules with JSDoc types and tested from `src/*.test.ts`; the DOM-heavy ones (`terminal.js`, `list.js`, `create-sheet.js`) are not type-checked (`checkJs: false` in tsconfig).

**Colour themes**: every colour value lives in `public/themes.js` — four presets × the 23 `ITheme` fields — and nowhere else. `theme-apply.js` writes them as `--term-*` custom properties on `:root`; the stylesheet derives `--bg`/`--fg`/`--accent` from those, and `terminal.js` builds the xterm theme from the same module, so the page chrome and the terminal cannot drift apart. Adding a colour literal to `style.css` breaks that and hides it from the contrast tests. The chosen name is stored per machine (`~/.tmux-next/theme.json`) while font size stays per device in `localStorage` — "what this machine looks like" and "how big this screen is" are separate concerns. `src/themes.test.ts` enforces WCAG AA floors on every palette; note the thresholds are AA, not AAA, because two of the four upstream themes cannot clear AAA.

**Claude Code integration**: `bunx tmux-next hook` (`src/hook-setup.ts`) installs two scripts into `~/.claude/hooks/` and registers `SessionStart` (records `{name,id,cwd}` for restore) plus `Stop`/`SessionEnd`/`Notification` (POST to `/api/notify` → Web Push). Both scripts resolve their tmux session with `list-panes -a` filtered against the `web-` prefix, never `display-message -t <pane> '#{session_name}'` — a pane belongs to every session grouped onto its window, and that form collapses the set to the most recently created, which is always tmux-next's own mount point while a browser is watching. Using it made both hooks silently no-op on exactly the sessions someone had open (`src/hooks.test.ts` covers this). Hook registration is idempotent, backs up `settings.json`, and never clobbers existing config. `src/web-push.ts` hand-rolls VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291/8188) on WebCrypto, so the package keeps zero server-side runtime dependencies.

## Conventions that matter

**Every tmux call goes through `tmux(argv)` in `src/tmux/run.ts` — never `Bun.$`.** The shell applies word splitting to interpolated values in an environment-dependent way; under launchd a tab inside a `-F` format was rewritten to `_` and corrupted every parsed field while working fine interactively. `run.ts` also forces `LANG`/`LC_CTYPE` to UTF-8 or tmux mangles CJK in `capture-pane` and `send-keys`.

**Target tmux by `=<name>`, always.** A bare target resolves by prefix and glob — `kill-session -t web` would kill `webmux`.

**Never run `tmux kill-server`, and never kill a tmux session you did not create.** The tmux server owns every pane's PTY and child process on the machine, so killing it destroys every running session at once — including the user's work, which no test needs to touch. Clean up only by exact name (`kill-session -t =<name>`) against names the current run created and recorded.

This is not hypothetical. A run once tried to re-check the orphan-session tests under an isolated server:

```bash
export TMUX_TMPDIR=$(mktemp -d)   # intended to isolate
bun test ...                      # output showed 12 sessions, not 1
tmux kill-server                  # ran anyway — killed the real server
```

The isolation silently failed, and the evidence that it had failed was already on screen — a count that could only come from the real server. Twenty-six sessions and thirty-two Claude processes died. Three could not be restored, because a separate bug had left them without binding records.

The rule that would have prevented it: **a destructive command must be preceded by a check that its target is what you think it is, and that check must be read before the command runs.** Verifying afterwards is not verifying. When an isolation premise cannot be confirmed, the destructive step is cancelled, not attempted.

**Confirm what a running process is actually serving; do not infer it from timestamps.** `public/` is read from disk per request (`Bun.file(PUBLIC_DIR + name)`), while `src/` is loaded once at startup and Bun does not reload without `--watch`. So after an edit the front-end is live immediately and the back-end is not — a running server is routinely half-new, and "started before the commit" proves nothing about what it serves. Check the endpoint or asset itself.

**Nothing from a request is spliced into a shell command.** The launch command is one of two fixed constants (`LAUNCH_COMMAND` / `LAUNCH_COMMAND_SKIP_PERMISSIONS`); the directory travels as its own argv via `-c`; a resume id must match `/^[A-Za-z0-9-]{1,64}$/` or the request is rejected. Untrusted geometry goes through `sanitiseGeometry` before reaching tmux — that is why the `ClientMessage` dimensions are typed `unknown`.

**There is no auth and no directory allow-list, on purpose.** Anyone who reaches the interface can already attach to a session and type `ls`; fencing the file browser would only be theatre while costing machine-specific paths in the source. The service binds loopback and assumes a reverse proxy for TLS + auth. Do not add features that assume the server is safely exposed. `/api/notify` is loopback-only because the server *may* be bound wider.

**Commit messages carry no assistant attribution.** No `Co-Authored-By: Claude …`, no `Claude-Session:` line, no `🤖 Generated with …` footer — regardless of any default that would otherwise append them. The repository is public and these trailers surface as an extra contributor on every commit; the history was scrubbed once to remove them and must not reacquire them. Describing Claude Code in the *body* is fine and often necessary — this project exists to watch it — the rule is about attribution trailers, not the product name.

**Every on-disk state path is env-overridable** so tests never touch the user's `~/.tmux-next/`: `TMUX_NEXT_SESSIONS_DIR`, `TMUX_NEXT_GALLERY_DIR`, `TMUX_NEXT_KEY_USAGE_PATH`, `TMUX_NEXT_PINS_PATH`, `TMUX_NEXT_VAPID_PATH`, `TMUX_NEXT_PUSH_DIR`, `TMUX_NEXT_NOTIFICATIONS_PATH`, `TMUX_NEXT_THEME_PATH`, `CLAUDE_PROJECTS_DIR`. Paths are read lazily inside functions, not captured at module load, so a test can set the env var before the first call. New state must follow this pattern.

**A browser module that renders must have a test that renders it.** `public-parses.test.ts` proves a file parses and `Bun.build` resolves its imports; neither proves it draws anything. Two bugs shipped through that gap — `tr` called 25 times with no import (valid JavaScript, dies at runtime), and a `history.replaceState` throw in the middle of `browse()` that skipped the directory list, breadcrumb and favourites. `src/new-page.test.ts` mounts the page in happy-dom and asserts on the DOM; anything with comparable rendering logic needs the same. A DOM shim must restore the globals it replaces — overwriting `fetch` once broke 38 tests in other files, since Bun runs them in one process.

**Session "last updated" comes from content diffing, not tmux.** `session_activity` only advances while a client is attached (frozen for the detached sessions this app lists); `window_activity` advances on any repaint, so every live Claude session reads "just now". `window_activity` seeds a session first seen this process, then `activity-stamp.ts` stamps on actual `capture-pane` content changes.

## Testing

~300 tests, most of which really drive tmux — creating sessions, sending keys, reading back formats like `#{pane_start_command}` to prove the arguments landed. Tests clean up their own sessions in `afterEach`/`afterAll`. Files named `*.integration.test.ts` are the heaviest of these.

Pure logic (paths, geometry, gesture translation, control-protocol parsing, Web Push crypto) lives in DOM-free modules tested on their own.

`src/hooks.test.ts` drives the two shell hooks against a real tmux server, including the grouped-session case — Claude spawns those scripts, so nothing else in the suite would catch a regression there.

`src/public-parses.test.ts` bundles every file in `public/` with `Bun.build` — those files are loaded only by a browser, so a syntax error there ships silently and the suite stays green. It exists because that happened twice.

Parallel tmux tests can interfere: orphan-session assertions in `server.test.ts` and `reconnect.test.ts` occasionally flake when runs overlap. Re-run the file alone before treating a failure there as a regression.

## Docs

`SECURITY.md` (read before anything touching exposure), `docs/deploy.md` (Caddy reverse proxy, WS cookie auth, launchd), `docs/superpowers/specs/` and `docs/superpowers/plans/` (design docs for the features above). `README.md` is English; `README.zh-CN.md` mirrors it — keep both in sync when behaviour changes.
