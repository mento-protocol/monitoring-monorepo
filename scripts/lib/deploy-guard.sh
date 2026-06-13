#!/usr/bin/env bash
# Shared guard sourced by deploy scripts. Refuses dirty working trees before
# mutating external systems (scripts/AGENTS.md). Anchored to the repo that
# contains this guard file so it checks the deployed checkout, not the caller's
# cwd. Uses `return` (not `exit`) since it is sourced and all callers set -e.
_guard_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_repo_root="$(git -C "$_guard_dir" rev-parse --show-toplevel 2>/dev/null)"
if [[ -z "$_repo_root" ]]; then
  echo "❌ deploy-guard: not inside a git repository; refusing to deploy."
  return 1
fi
if [[ -n "$(git -C "$_repo_root" status --porcelain)" ]]; then
  echo "❌ Working directory is not clean. Commit or stash your changes first."
  git -C "$_repo_root" status --short
  return 1
fi
