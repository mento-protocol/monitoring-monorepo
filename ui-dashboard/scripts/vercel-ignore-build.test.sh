#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture_repo="$(mktemp -d)"
output_file="$(mktemp)"
trap 'rm -rf "$fixture_repo"; rm -f "$output_file"' EXIT

fail() {
  echo "vercel-ignore-build test failed: $*" >&2
  echo >&2
  echo "Last output:" >&2
  sed 's/^/  /' "$output_file" >&2
  exit 1
}

expect_status() {
  local expected_status="$1"
  local label="$2"
  shift 2

  set +e
  env "$@" bash ui-dashboard/scripts/vercel-ignore-build.sh > "$output_file" 2>&1
  local actual_status=$?
  set -e

  [[ "$actual_status" == "$expected_status" ]] ||
    fail "${label}: expected exit ${expected_status}, got ${actual_status}"
}

expect_skip() {
  expect_status 0 "$@"
}

expect_build() {
  expect_status 1 "$@"
}

assert_output_contains() {
  local expected="$1"
  grep -Fq "$expected" "$output_file" ||
    fail "expected output to contain: ${expected}"
}

mkdir -p "$fixture_repo/ui-dashboard/scripts" "$fixture_repo/shared-config"
cp "$repo_root/ui-dashboard/scripts/vercel-ignore-build.sh" "$fixture_repo/ui-dashboard/scripts/vercel-ignore-build.sh"

cd "$fixture_repo"
git init -q
git config user.email test@example.invalid
git config user.name "Vercel Ignore Test"

printf 'dashboard v1\n' > ui-dashboard/app.txt
printf 'shared v1\n' > shared-config/config.txt
printf 'docs v1\n' > AGENTS.md
git add .
git commit -qm "initial dashboard"
previous_sha="$(git rev-parse --verify HEAD)"

printf 'dashboard v2\n' > ui-dashboard/app.txt
git commit -am "dashboard change on main" -q
main_sha="$(git rev-parse --verify HEAD)"
git update-ref refs/remotes/origin/main "$main_sha"

git switch -c docs-only >/dev/null 2>&1
printf 'docs v2\n' > AGENTS.md
git commit -am "docs-only PR change" -q

expect_skip "PR docs-only changes skip from origin/main" \
  VERCEL_GIT_PULL_REQUEST_ID=407 \
  VERCEL_GIT_PREVIOUS_SHA="$previous_sha"

expect_build "non-PR deployments still compare from previous successful SHA" \
  VERCEL_GIT_PREVIOUS_SHA="$previous_sha"

expect_skip "non-PR docs-only changes skip when previous SHA is current main" \
  VERCEL_GIT_PREVIOUS_SHA="$main_sha"

git switch -c dashboard-pr "$main_sha" >/dev/null 2>&1
printf 'dashboard v3\n' > ui-dashboard/app.txt
git commit -am "dashboard PR change" -q

expect_build "PR dashboard changes build from origin/main" \
  VERCEL_GIT_PULL_REQUEST_ID=408 \
  VERCEL_GIT_PREVIOUS_SHA="$main_sha"

git update-ref -d refs/remotes/origin/main
expect_build "PR falls back to build when origin/main is unavailable" \
  VERCEL_GIT_PULL_REQUEST_ID=409
assert_output_contains "Could not resolve origin/main for PR #409; building dashboard."

echo "vercel-ignore-build tests passed"
