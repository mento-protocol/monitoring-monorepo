#!/usr/bin/env bash
set -euo pipefail

base_ref="${1:-origin/main}"
original_head="$(git rev-parse --verify HEAD)"
created_scan_branch=""

cleanup_scan_branch() {
  if [[ -n "$created_scan_branch" ]]; then
    git switch --detach "$original_head" >/dev/null 2>&1 || true
    git branch -D "$created_scan_branch" >/dev/null 2>&1 || true
  fi
}

trap cleanup_scan_branch EXIT

# React Doctor falls back to a full scan when HEAD is detached. Match the CI
# reattach step before running the diff gate, then clean up the temporary
# branch so local gate runs do not leave the checkout on a synthetic branch.
if [[ "$(git rev-parse --abbrev-ref HEAD)" == "HEAD" ]]; then
  scan_branch="__react_doctor_scan"
  if git show-ref --verify --quiet "refs/heads/${scan_branch}"; then
    scan_branch="${scan_branch}_$(date +%s)_$$"
  fi
  git switch -c "$scan_branch" >/dev/null 2>&1
  created_scan_branch="$scan_branch"
fi

pnpm --filter @mento-protocol/ui-dashboard react-doctor \
  --diff "$base_ref" \
  --fail-on warning \
  --offline
