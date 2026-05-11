#!/usr/bin/env bash
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

base_sha="${VERCEL_GIT_PREVIOUS_SHA:-}"

if [[ -z "$base_sha" ]]; then
  echo "No VERCEL_GIT_PREVIOUS_SHA; building dashboard."
  exit 1
fi

if ! git cat-file -e "${base_sha}^{commit}" 2>/dev/null; then
  echo "Previous Vercel SHA ${base_sha} is unavailable in this clone; building dashboard."
  exit 1
fi

if git diff --quiet "$base_sha" HEAD -- "${dashboard_paths[@]}"; then
  echo "No dashboard-affecting changes since previous successful Vercel deployment; skipping build."
  exit 0
fi

echo "Dashboard-affecting changes detected since previous successful Vercel deployment; building dashboard."
exit 1
