#!/usr/bin/env bash
# agent-session-end-hook.sh
#
# Fires on SessionEnd from Claude Code and Codex. Nudges /compound when the
# session did meaningful work (new commits or working-tree changes) so any
# new learnings get extracted into memory / AGENTS.md / CLAUDE.md before
# context is lost. Silent on no-op sessions to avoid notification spam.
#
# Hook input arrives as JSON on stdin (Claude Code + Codex share this shape):
#   { "session_id": "...", "cwd": "...", "hook_event_name": "SessionEnd", ... }
set -euo pipefail

REPO="/Users/chapati/code/mento/monitoring-monorepo"

input="$(cat 2>/dev/null || true)"
cwd=""
if command -v jq >/dev/null 2>&1; then
  cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"
fi
[ -z "$cwd" ] && cwd="$(pwd)"

case "$cwd" in
  "$REPO" | "$REPO"/*) ;;
  *) exit 0 ;;
esac

cd "$cwd" 2>/dev/null || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

recent_commits="$(git log --oneline --since='2 hours ago' 2>/dev/null | wc -l | tr -d ' ' || echo 0)"
modified="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ' || echo 0)"

if [ "$recent_commits" -gt 0 ] || [ "$modified" -gt 0 ]; then
  printf 'Session touched the tree (%s recent commit(s), %s unstaged file(s)). Consider /compound to capture any new learnings into memory or AGENTS.md.\n' \
    "$recent_commits" "$modified" >&2
fi

exit 0
