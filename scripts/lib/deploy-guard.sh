#!/usr/bin/env bash
# Shared guard sourced by deploy scripts. Deploy scripts must refuse dirty
# working trees before mutating external systems (scripts/AGENTS.md):
# uncommitted edits would ship unreviewed and make rollback/audit unreliable.
#
# Use `return` (not `exit`) on failure: this file is sourced, and `exit` would
# kill the caller's parent shell — including an interactive terminal if someone
# sources it by hand to test. All callers run `set -e`/`set -euo pipefail`, so a
# non-zero return aborts the deploy. The `|| exit 1` fallback keeps it safe if
# the file is ever executed directly instead of sourced (return outside a
# sourced context is an error).
#
# Anchor the status check to THIS file's repo (scripts/lib/ → two levels up),
# not the caller's CWD. The deploy scripts always deploy their own computed
# repo root, so checking the caller's working directory would let a dirty
# monitoring-monorepo checkout slip through when a script is launched from
# elsewhere. Fail closed if `git -C` errors (e.g. the path is not a worktree).
__deploy_guard_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
__deploy_guard_status="$(git -C "$__deploy_guard_root" status --porcelain 2>/dev/null)" || {
  echo "❌ Could not read git status for $__deploy_guard_root. Aborting deploy."
  unset __deploy_guard_root __deploy_guard_status
  # shellcheck disable=SC2317  # reachable only when executed (not sourced)
  return 1 2>/dev/null || exit 1
}
if [[ -n "$__deploy_guard_status" ]]; then
  echo "❌ Working directory is not clean. Commit or stash your changes first."
  git -C "$__deploy_guard_root" status --short
  unset __deploy_guard_root __deploy_guard_status
  # shellcheck disable=SC2317  # reachable only when executed (not sourced)
  return 1 2>/dev/null || exit 1
fi
unset __deploy_guard_root __deploy_guard_status
