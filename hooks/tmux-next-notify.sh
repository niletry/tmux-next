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

# The session the current pane belongs to. $TMUX_PANE is set inside tmux.
name=$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null)
[ -z "$name" ] && exit 0

# web-* sessions are tmux-next's own attach points, not user sessions.
case "$name" in web-*) exit 0 ;; esac

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
