#!/usr/bin/env bash
set -euo pipefail

score="$(
  pnpm --filter @mento-protocol/ui-dashboard react-doctor --full --score --offline \
    | tail -n 1 \
    | tr -d '[:space:]'
)"

if [[ "$score" != "100" ]]; then
  echo "Expected ui-dashboard react-doctor score 100, got ${score}" >&2
  exit 1
fi
