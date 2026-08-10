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

# Map the Claude hook to the event tmux-next understands. An event we do not
# map is not an error — Claude sends more kinds than this hook cares about, and
# `Stop` registrations also receive subagent completions.
hook=$(printf '%s' "$input" | jq -r '.hook_event_name // empty' 2>/dev/null)
case "$hook" in
  Stop) event=waiting ;;
  SessionEnd) event=ended ;;
  Notification) event=attention ;;
  *) event="" ;;
esac

# Present only inside a subagent, which is the one reliable way to tell a
# subagent finishing from a turn finishing.
agent_type=$(printf '%s' "$input" | jq -r '.agent_type // empty' 2>/dev/null)
agent_id=$(printf '%s' "$input" | jq -r '.agent_id // empty' 2>/dev/null)

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

# A record of what arrived, including the events this hook then drops.
#
# Every way this script declines to act is silent by design, which is exactly
# what made two bugs hard to find: pushes that stopped for sessions a browser
# had open, and pushes that arrived when a subagent — not the turn — finished.
# The dropped events are the interesting ones and they never reach the server,
# so the only place they can be seen is here.
#
# The *shape* of the event only: which kind arrived, whether it came from a
# subagent, which session it was attributed to, and what this hook did about it.
# Never `message` or `last_assistant_message` — those are what you and the agent
# said to each other, and no amount of diagnostic value is worth writing them to
# disk by default. Set TMUX_NEXT_HOOK_LOG=off to record nothing at all.
hooklog="${TMUX_NEXT_HOOK_LOG:-$HOME/.tmux-next/hook-events.jsonl}"
if [ "$hooklog" != "off" ]; then
  {
    mkdir -p "$(dirname "$hooklog")" 2>/dev/null &&
      jq -cn \
        --arg ts "$(date +%s)" \
        --arg hook "$hook" \
        --arg action "${event:-ignored}" \
        --arg session "$name" \
        --arg agent "$agent_type" \
        --arg sub "$agent_id" \
        '{ts: ($ts|tonumber), hook: $hook, action: $action, session: $session}
         + (if $agent == "" then {} else {agent: $agent} end)
         + (if $sub   == "" then {} else {subagent: true} end)' >>"$hooklog"

    # Bounded, so an always-on diagnostic cannot quietly fill a disk.
    if [ "$(wc -l <"$hooklog")" -gt 1200 ]; then
      tail -n 600 "$hooklog" >"$hooklog.tmp" && mv "$hooklog.tmp" "$hooklog"
    fi
  } >/dev/null 2>&1
fi

[ -z "$event" ] && exit 0
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
