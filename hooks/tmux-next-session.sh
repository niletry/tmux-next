#!/bin/bash
# Claude Code SessionStart hook, installed by `tmux-next hook`.
#
# Records this conversation's binding to its tmux session on disk, so tmux-next
# can bring it back (claude --resume) if the tmux server dies — a reboot, a
# crash, `tmux kill-server`. Writes one small file per Claude session under
# ~/.tmux-next/sessions/, named by the (uuid) session id.
#
# Deliberately silent and non-blocking: a no-op when not inside tmux, when
# tmux-next isn't set up, or when anything is missing. Never fails Claude start.

[ -z "$TMUX" ] && exit 0

input=$(cat)
id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$id" ] && exit 0

# The session the current pane belongs to. $TMUX_PANE is set inside tmux.
name=$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null)
[ -z "$name" ] && exit 0

# web-* sessions are tmux-next's own attach points, not sessions it lists.
case "$name" in web-*) exit 0 ;; esac

dir="$HOME/.tmux-next/sessions"
mkdir -p "$dir" 2>/dev/null || exit 0

jq -cn --arg s "$name" --arg i "$id" --arg c "$cwd" \
  '{session:$s, id:$i} + (if $c == "" then {} else {cwd:$c} end)' \
  >"$dir/$id.json" 2>/dev/null

exit 0
