#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

paths_file="$(mktemp)"
output_file="$(mktemp)"
trap 'rm -f "$paths_file" "$output_file"' EXIT

fail() {
  echo "agent-quality-gate test failed: $*" >&2
  echo >&2
  echo "Last gate output:" >&2
  sed 's/^/  /' "$output_file" >&2
  exit 1
}

run_gate() {
  : > "$paths_file"
  local path
  for path in "$@"; do
    printf '%s\n' "$path" >> "$paths_file"
  done

  scripts/agent-quality-gate.sh \
    --changed-paths-file "$paths_file" \
    --base origin/test \
    > "$output_file"
}

run_gate_expect_failure() {
  : > "$paths_file"
  local path
  for path in "$@"; do
    printf '%s\n' "$path" >> "$paths_file"
  done

  set +e
  scripts/agent-quality-gate.sh \
    --changed-paths-file "$paths_file" \
    --base origin/test \
    --run \
    > "$output_file" 2>&1
  local exit_code=$?
  set -e

  [[ "$exit_code" -ne 0 ]] ||
    fail "expected gate to fail, but it exited 0"
}

assert_contains() {
  local expected="$1"
  grep -Fq -- "$expected" "$output_file" ||
    fail "expected output to contain: $expected"
}

line_number() {
  local needle="$1"
  grep -nF -- "$needle" "$output_file" | head -n 1 | cut -d: -f1
}

assert_order() {
  local earlier="$1"
  local later="$2"
  local earlier_line
  local later_line

  earlier_line="$(line_number "$earlier" || true)"
  later_line="$(line_number "$later" || true)"

  [[ -n "$earlier_line" ]] || fail "missing ordered item: $earlier"
  [[ -n "$later_line" ]] || fail "missing ordered item: $later"
  [[ "$earlier_line" -lt "$later_line" ]] ||
    fail "expected '$earlier' before '$later'"
}

run_gate "ui-dashboard/package.json"
assert_contains "- pnpm install --frozen-lockfile (workspace package manifest changed)"
assert_order \
  "- pnpm install --frozen-lockfile (workspace package manifest changed)" \
  "- pnpm --filter @mento-protocol/ui-dashboard lint (ui-dashboard changed)"

run_gate_expect_failure "ui-dashboard/package.json"
assert_contains "Refusing to run because package manifests or lockfile changed."
assert_contains "re-run with --allow-package-script-changes if they are safe."

run_gate_expect_failure "pnpm-lock.yaml"
assert_contains "Refusing to run because package manifests or lockfile changed."
assert_contains "dependency install scripts"

run_gate "indexer-envio/package.json"
assert_contains "- docs/pr-checklists/stateful-data-ui.md (indexer data flow changed)"
assert_order \
  "- pnpm install --frozen-lockfile (workspace package manifest changed)" \
  "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (indexer schema/source/ABI/package path changed)"
assert_order \
  "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (indexer schema/source/ABI/package path changed)" \
  "- pnpm indexer:testnet:codegen (indexer schema/source/ABI/package path changed)"
assert_order \
  "- pnpm indexer:testnet:codegen (indexer schema/source/ABI/package path changed)" \
  "- pnpm indexer:codegen (indexer schema/source/ABI/package path changed)"
assert_order \
  "- pnpm indexer:codegen (indexer schema/source/ABI/package path changed)" \
  "- pnpm install --frozen-lockfile (link generated package after indexer codegen)"
assert_order \
  "- pnpm install --frozen-lockfile (link generated package after indexer codegen)" \
  "- pnpm --filter @mento-protocol/indexer-envio lint (indexer-envio changed)"

run_gate "indexer-envio/src/bridge.ts"
assert_order \
  "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (indexer schema/source/ABI/package path changed)" \
  "- pnpm indexer:testnet:codegen (indexer schema/source/ABI/package path changed)"
assert_order \
  "- pnpm indexer:testnet:codegen (indexer schema/source/ABI/package path changed)" \
  "- pnpm indexer:codegen (indexer schema/source/ABI/package path changed)"
assert_order \
  "- pnpm indexer:codegen (indexer schema/source/ABI/package path changed)" \
  "- pnpm install --frozen-lockfile (link generated package after indexer codegen)"

run_gate "indexer-envio/scripts/run-envio-with-env.mjs"
assert_order \
  "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (indexer schema/source/ABI/package path changed)" \
  "- pnpm indexer:testnet:codegen (indexer schema/source/ABI/package path changed)"
assert_order \
  "- pnpm indexer:testnet:codegen (indexer schema/source/ABI/package path changed)" \
  "- pnpm indexer:codegen (indexer schema/source/ABI/package path changed)"
assert_order \
  "- pnpm indexer:codegen (indexer schema/source/ABI/package path changed)" \
  "- pnpm install --frozen-lockfile (link generated package after indexer codegen)"

run_gate "indexer-envio/config.multichain.bridge-only.yaml"
assert_contains "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (bridge-only indexer config changed)"
assert_contains "- pnpm indexer:codegen (restore full multichain generated package after bridge-only codegen)"
assert_order \
  "- pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen (bridge-only indexer config changed)" \
  "- pnpm indexer:codegen (restore full multichain generated package after bridge-only codegen)"
assert_order \
  "- pnpm indexer:codegen (restore full multichain generated package after bridge-only codegen)" \
  "- pnpm install --frozen-lockfile (link generated package after indexer codegen)"
assert_order \
  "- pnpm install --frozen-lockfile (link generated package after indexer codegen)" \
  "- pnpm --filter @mento-protocol/indexer-envio lint (indexer-envio changed)"

run_gate "indexer-envio/config/aggregators.json"
assert_contains "- docs/pr-checklists/stateful-data-ui.md (indexer config data flow changed)"
assert_contains "- pnpm --filter @mento-protocol/indexer-envio test (indexer-envio changed)"

run_gate "ui-dashboard/src/lib/gql-retry.ts"
assert_contains "- docs/pr-checklists/swr-polling-hasura.md (Hasura/SWR/query path changed)"
assert_contains "- pnpm --filter @mento-protocol/ui-dashboard react-doctor --diff origin/test --fail-on warning --offline (ui-dashboard client code should keep React Doctor clean)"

run_gate "ui-dashboard/src/components/breach-history-panel.tsx"
assert_contains "- docs/pr-checklists/swr-polling-hasura.md (Hasura/SWR/query path changed)"

run_gate "ui-dashboard/src/app/pool/[poolId]/_tabs/swaps-tab.tsx"
assert_contains "- docs/pr-checklists/swr-polling-hasura.md (Hasura/SWR/query path changed)"

run_gate "ui-dashboard/src/app/pool/[poolId]/_components/pool-detail-page-client.tsx"
assert_contains "- docs/pr-checklists/swr-polling-hasura.md (Hasura/SWR/query path changed)"

run_gate "ui-dashboard/src/lib/fetch-all-networks.ts"
assert_contains "- docs/pr-checklists/swr-polling-hasura.md (Hasura/SWR/query path changed)"

run_gate "ui-dashboard/src/lib/fetch-json.ts"
assert_contains "- docs/pr-checklists/swr-polling-hasura.md (Hasura/SWR/query path changed)"

run_gate "ui-dashboard/src/lib/network-fetcher/fetch.ts"
assert_contains "- docs/pr-checklists/swr-polling-hasura.md (Hasura/SWR/query path changed)"

run_gate "ui-dashboard/src/lib/queries.ts"
assert_contains "- docs/pr-checklists/swr-polling-hasura.md (Hasura/SWR/query path changed)"

run_gate "terraform/main.tf"
assert_contains "- terraform -chdir=terraform fmt -check -recursive (Terraform changed)"
assert_contains "- docs/pr-checklists/terraform-cloudrun.md (Terraform/Cloud Run path changed)"

run_gate "bootstrap-worktree.sh"
assert_contains "- bash -n bootstrap-worktree.sh (shell script changed)"

run_gate "docs/process.md"
assert_contains "Detected surfaces:"
assert_contains "- docs"

echo "agent quality gate tests passed"
