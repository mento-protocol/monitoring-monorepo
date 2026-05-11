#!/usr/bin/env bash
set -euo pipefail

base_ref="${1:-origin/main}"

# React Doctor falls back to a full scan when HEAD is detached. Match the CI
# reattach step before running the diff gate, while avoiding branch-name reuse
# on repeated local invocations.
if [[ "$(git rev-parse --abbrev-ref HEAD)" == "HEAD" ]]; then
  scan_branch="__react_doctor_scan"
  if git show-ref --verify --quiet "refs/heads/${scan_branch}"; then
    scan_branch="${scan_branch}_$(date +%s)_$$"
  fi
  git switch -c "$scan_branch"
fi

pnpm --filter @mento-protocol/ui-dashboard react-doctor \
  --diff "$base_ref" \
  --fail-on warning \
  --offline
