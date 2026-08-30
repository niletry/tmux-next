# Security

## What this software is

tmux-next hands a browser full control of your tmux sessions: reading what is
on screen, typing into them, creating new ones, and killing them. A tmux
session is a shell. **Anyone who can reach this service can run commands as the
user who started it.**

That is the intended behaviour, not a flaw. It is also why the deployment
details below are not optional advice.

## It has no authentication

There is no login, no token, no session check. Requests are served to whoever
sends them.

The service binds to `127.0.0.1` for that reason, and it expects a reverse
proxy in front of it to provide TLS and authentication. `--host` exists for
people who know what they are doing; using it prints a warning.

Two things are easy to get wrong when setting that proxy up:

- **The WebSocket needs its own rule.** Browsers do not send Basic Auth
  headers on a WebSocket handshake. If you protect `/` with Basic Auth and
  forget `/ws`, the terminal is wide open while the pages look protected. One
  working approach — setting a cookie on authenticated requests and checking
  that cookie on the WebSocket path — is in `docs/deploy.md`.
- **Any port that reaches the service is a shell.** Binding to `0.0.0.0` on a
  machine with a public interface, or forwarding a port to it, skips the proxy
  entirely.

## It can now hold a Jira credential

With the Jira plugin configured, `~/.tmux-next/jira/config.json` holds an API
token for your Jira instance. The file is `0600` and no endpoint ever returns
the token — but that is not the boundary that matters. **Anyone who can reach
this service can read your Jira through it**, as you, without ever seeing the
token.

So the warning above changes in kind, not just degree: an exposed port was
already a shell, and is now a shell plus your issue tracker.

The plugin only ever runs the JQL from `config.json`. It does not accept a
query from the browser, and it must not be changed to — that would turn the
service into an open query proxy against your instance.

Turn the whole thing off with `TMUX_NEXT_DISABLE_PLUGINS=jira`; the tab, the
API and the pages disappear together.

### And, if you enable the PR view, a Bitbucket one

Listing an issue's pull requests needs nothing extra: Jira's own dev-status
endpoint answers with the token you already configured. **Build status does
not** — this instance's CI never reports into Jira, so those come from
Bitbucket, which means a second credential in the same file:
`bitbucket.email` and `bitbucket.appPassword`.

That widens the blast radius again. Someone who reaches this service cannot see
the app password — no endpoint returns it — but they can use it, as you,
against whatever it is scoped to. **Scope it to reads.** An app password with
`Repositories: Read` and `Pull requests: Read` is enough for everything this
plugin does; anything more is capability you are storing for no benefit.

Leave the `bitbucket` section out entirely and the feature degrades honestly:
pull requests still list, and their checks read as "not asked" rather than
pretending there are none.

## Skipping permission prompts

The create dialog can start Claude Code with `--dangerously-skip-permissions`.
When that is used, the session acts without asking for confirmation. It is off
by default and deliberately not remembered between sessions, but it does mean
a reachable instance is more dangerous than one without it. Treat access to
this service the same way you treat SSH access to the machine.

## Directory browsing is unrestricted

The picker can list any directory the user can read, and a session can be
created anywhere. This is deliberate: anyone who can reach the endpoint can
already attach to a session and run `ls`, so restricting the picker while
leaving a shell open protected nothing and only broke real use.

## Reporting a vulnerability

Please report privately rather than opening a public issue: use GitHub's
[private vulnerability reporting][gh] on this repository.

[gh]: https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability

Useful things to include: what you did, what happened, and whether it needs
access to the service or works from outside it. There is no bug bounty.

Expect a first response within a week. This is a personal project maintained
in spare time, not a product with an on-call rotation — please size your
expectations accordingly.

## Supported versions

There have been no releases yet. Only the `master` branch is maintained; fixes
land there and nothing older is patched.
