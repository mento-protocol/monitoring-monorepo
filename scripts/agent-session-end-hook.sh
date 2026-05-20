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

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO="$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$REPO" ] || exit 0

input="$(cat 2>/dev/null || true)"
cwd=""
if command -v jq >/dev/null 2>&1; then
  cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"
fi
[ -z "$cwd" ] && cwd="$(pwd)"

cwd_repo="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true)"
[ "$cwd_repo" = "$REPO" ] || exit 0

recent_commits="$(git -C "$cwd" rev-list --count --since='2 hours ago' HEAD 2>/dev/null || echo 0)"
modified="$(git -C "$cwd" status --porcelain 2>/dev/null | wc -l | tr -d ' ' || echo 0)"

if [ "$recent_commits" -gt 0 ] || [ "$modified" -gt 0 ]; then
  printf 'Session touched the tree (%s recent commit(s), %s unstaged file(s)). Consider /compound to capture any new learnings into memory or AGENTS.md.\n' \
    "$recent_commits" "$modified" >&2
fi

exit 0
