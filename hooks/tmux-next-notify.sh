#!/bin/bash
# Claude Code hook (Stop / SessionEnd / Notification), installed by
# `tmux-next hook`.
#
# Reports the event to a running tmux-next so it can push a notification to your
# phone: a turn finished and it's waiting on you, the session ended, or Claude
# needs your confirmation/input.
#
# Deliberately silent and non-blocking: a no-op when not inside tmux, when
# tmux-next isn't reachable, or when anything is missing, and it never delays
# Claude — the request is fired in the background.

[ -z "$TMUX" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0

input=$(cat)

# Map the Claude hook to the event tmux-next understands.
hook=$(printf '%s' "$input" | jq -r '.hook_event_name // empty' 2>/dev/null)
case "$hook" in
  Stop) event=waiting ;;
  SessionEnd) event=ended ;;
  Notification) event=attention ;;
  *) exit 0 ;;
esac

# The user session the current pane belongs to. $TMUX_PANE is set inside tmux.
#
# Not `display-message -t <pane> '#{session_name}'`: a pane belongs to *every*
# session grouped onto its window, and that form has to collapse the set to one
# answer — it returns the most recently created, which is always tmux-next's own
# `web-*` mount point while a browser is watching. The `web-*` guard below then
# fired on the very sessions a browser was open on, silently skipping them.
#
# `list-panes -a` does not collapse: it prints one row per (session, pane), so
# the mount points can be filtered out and the user's session kept. pane_id
# comes first and cannot contain `|`, so `cut -f2-` keeps names with `|` or
# spaces intact. Empty means the pane lives only in a web session — nothing to
# attribute, so exit as before.
name=$(tmux list-panes -a -F '#{pane_id}|#{session_name}' 2>/dev/null \
  | grep "^${TMUX_PANE}|" | cut -d'|' -f2- | grep -v '^web-' | head -1)
[ -z "$name" ] && exit 0

# Notification events carry the prompt text; the others don't.
message=$(printf '%s' "$input" | jq -r '.message // empty' 2>/dev/null)

body=$(jq -cn --arg e "$event" --arg s "$name" --arg m "$message" \
  '{event:$e, session:$s} + (if $m == "" then {} else {message:$m} end)')

# Default port; override with TMUX_NEXT_PORT if the server runs elsewhere.
port="${TMUX_NEXT_PORT:-7682}"

# Backgrounded so Claude never waits on it; connection-refused returns at once.
curl -s -m 2 --connect-timeout 1 -X POST -H 'content-type: application/json' \
  --data "$body" "http://127.0.0.1:${port}/api/notify" >/dev/null 2>&1 &

exit 0
