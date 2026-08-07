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

dir="$HOME/.tmux-next/sessions"
mkdir -p "$dir" 2>/dev/null || exit 0

jq -cn --arg s "$name" --arg i "$id" --arg c "$cwd" \
  '{session:$s, id:$i} + (if $c == "" then {} else {cwd:$c} end)' \
  >"$dir/$id.json" 2>/dev/null

exit 0
