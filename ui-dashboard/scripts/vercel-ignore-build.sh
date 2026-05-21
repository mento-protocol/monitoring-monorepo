#!/usr/bin/env bash
# Last manual redeploy nudge: 2026-05-21 — force-rebuild after Vercel Blob token rotation.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

dashboard_paths=(
  "ui-dashboard"
  "shared-config"
  "package.json"
  "pnpm-lock.yaml"
  "pnpm-workspace.yaml"
)

pull_request_id="${VERCEL_GIT_PULL_REQUEST_ID:-}"
commit_ref="${VERCEL_GIT_COMMIT_REF:-}"

skip_or_build_from_base() {
  local base_sha="$1"
  local skip_message="$2"
  local build_message="$3"

  if git diff --quiet "$base_sha" HEAD -- "${dashboard_paths[@]}"; then
    echo "$skip_message"
    exit 0
  fi

  echo "$build_message"
  exit 1
}

resolve_main_merge_base() {
  local production_ref="origin/main"

  if ! git cat-file -e "${production_ref}^{commit}" 2>/dev/null; then
    git fetch --quiet origin "main:refs/remotes/${production_ref}" 2>/dev/null
  fi

  git merge-base HEAD "$production_ref"
}

if [[ -n "$pull_request_id" ]]; then
  if pr_base_sha="$(resolve_main_merge_base)"; then
    skip_or_build_from_base \
      "$pr_base_sha" \
      "No dashboard-affecting changes in PR #${pull_request_id}; skipping build." \
      "Dashboard-affecting changes detected in PR #${pull_request_id}; building dashboard."
  fi

  echo "Could not resolve origin/main for PR #${pull_request_id}; building dashboard."
  exit 1
fi

base_sha="${VERCEL_GIT_PREVIOUS_SHA:-}"

if [[ -z "$base_sha" ]]; then
  # First push of a feature branch can outrun GitHub's PR registration, so Vercel
  # ships neither VERCEL_GIT_PULL_REQUEST_ID nor VERCEL_GIT_PREVIOUS_SHA. Fall back
  # to diffing against origin/main when we know we're on a non-main branch.
  if [[ -n "$commit_ref" && "$commit_ref" != "main" ]]; then
    if branch_base_sha="$(resolve_main_merge_base)"; then
      skip_or_build_from_base \
        "$branch_base_sha" \
        "No dashboard-affecting changes on branch ${commit_ref} vs main; skipping build." \
        "Dashboard-affecting changes detected on branch ${commit_ref} vs main; building dashboard."
    fi

    echo "Could not resolve origin/main for branch ${commit_ref}; building dashboard."
    exit 1
  fi

  echo "No VERCEL_GIT_PREVIOUS_SHA; building dashboard."
  exit 1
fi

if ! git cat-file -e "${base_sha}^{commit}" 2>/dev/null; then
  echo "Previous Vercel SHA ${base_sha} is unavailable in this clone; building dashboard."
  exit 1
fi

skip_or_build_from_base \
  "$base_sha" \
  "No dashboard-affecting changes since previous successful Vercel deployment; skipping build." \
  "Dashboard-affecting changes detected since previous successful Vercel deployment; building dashboard."
