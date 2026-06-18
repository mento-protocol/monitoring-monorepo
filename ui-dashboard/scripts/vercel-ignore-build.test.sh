#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture_repo="$(mktemp -d)"
output_file="$(mktemp)"
mock_server_pid=""
mock_api_base=""
trap '[[ -z "$mock_server_pid" ]] || kill "$mock_server_pid" 2>/dev/null || true; rm -rf "$fixture_repo"; rm -f "$output_file"' EXIT

fail() {
  echo "vercel-ignore-build test failed: $*" >&2
  echo >&2
  echo "Last output:" >&2
  sed 's/^/  /' "$output_file" >&2
  if [[ -f "$fixture_repo/mock-github-api.log" ]]; then
    echo >&2
    echo "Mock GitHub API log:" >&2
    sed 's/^/  /' "$fixture_repo/mock-github-api.log" >&2
  fi
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

start_mock_github_api() {
  local port_file="$fixture_repo/mock-github-api-port"

  cat >"$fixture_repo/mock-github-api.mjs" <<'NODE'
import http from "node:http";
import { writeFileSync } from "node:fs";

const portFile = process.argv[2];

const responses = new Map([
  [
    "/repos/mento-protocol/monitoring-monorepo/pulls/982/files",
    [{ filename: "docs/pr-checklists/recurring-review-patterns.md" }],
  ],
  [
    "/repos/mento-protocol/monitoring-monorepo/pulls/983/files",
    [{ filename: "ui-dashboard/src/app/page.tsx" }],
  ],
  [
    "/repos/mento-protocol/monitoring-monorepo/compare/main...sha-docs",
    {
      ahead_by: 1,
      files: [{ filename: "docs/pr-checklists/recurring-review-patterns.md" }],
    },
  ],
  [
    "/repos/mento-protocol/monitoring-monorepo/compare/main...sha-dashboard",
    { ahead_by: 1, files: [{ filename: "ui-dashboard/src/app/page.tsx" }] },
  ],
  [
    "/repos/mento-protocol/monitoring-monorepo/compare/main...sha-multi-docs",
    {
      ahead_by: 2,
      files: [{ filename: "docs/pr-checklists/recurring-review-patterns.md" }],
    },
  ],
  [
    "/repos/mento-protocol/monitoring-monorepo/compare/previous-sha...sha-docs",
    {
      ahead_by: 1,
      files: [{ filename: "docs/pr-checklists/recurring-review-patterns.md" }],
    },
  ],
  [
    "/repos/mento-protocol/monitoring-monorepo/compare/previous-sha...sha-dashboard",
    { ahead_by: 1, files: [{ filename: "ui-dashboard/src/app/page.tsx" }] },
  ],
]);

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  console.error(url.pathname);
  const body = responses.get(url.pathname);

  if (!body) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: `no fixture for ${url.pathname}` }));
    return;
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock server did not bind to a TCP port");
  }
  writeFileSync(portFile, String(address.port));
});
NODE

  node "$fixture_repo/mock-github-api.mjs" "$port_file" >"$fixture_repo/mock-github-api.log" 2>&1 &
  mock_server_pid=$!
  for _ in {1..50}; do
    [[ -s "$port_file" ]] && break
    sleep 0.1
  done
  [[ -s "$port_file" ]] || fail "mock GitHub API did not start"
  mock_api_base="http://127.0.0.1:$(cat "$port_file")"
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
printf '{ "name": "root", "scripts": { "a": "echo a" } }\n' > package.json
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

expect_skip "PR first push with docs-only change skips against origin/main" \
  VERCEL_GIT_PULL_REQUEST_ID=407
assert_output_contains "No dashboard-affecting changes in PR #407"

expect_build "non-PR deployments still compare from previous successful SHA" \
  VERCEL_GIT_PREVIOUS_SHA="$previous_sha"

expect_skip "non-PR docs-only changes skip when previous SHA is current main" \
  VERCEL_GIT_PREVIOUS_SHA="$main_sha"

git switch -c dashboard-pr "$main_sha" >/dev/null 2>&1
printf 'dashboard v3\n' > ui-dashboard/app.txt
git commit -am "dashboard PR change" -q

expect_build "PR first push with dashboard change builds against origin/main" \
  VERCEL_GIT_PULL_REQUEST_ID=408
assert_output_contains "Dashboard-affecting changes detected in PR #408"

# Root package.json is not a watched path: a script/devDep-only root edit (no
# dashboard code) must skip even though it changes the repo's top-level manifest.
git switch -c root-pkg-only "$main_sha" >/dev/null 2>&1
printf '{ "name": "root", "scripts": { "a": "echo a", "b": "echo b" } }\n' > package.json
git commit -am "chore: add a root script" -q

expect_skip "PR root package.json-only change skips" \
  VERCEL_GIT_PULL_REQUEST_ID=413
assert_output_contains "No dashboard-affecting changes in PR #413"

# Restore HEAD for the branch-fallback tests below, which assume the dashboard
# branch is checked out.
git switch dashboard-pr >/dev/null 2>&1

# First push of a branch can race ahead of GitHub's PR registration — Vercel
# then ships neither VERCEL_GIT_PULL_REQUEST_ID nor VERCEL_GIT_PREVIOUS_SHA.
# The branch fallback uses VERCEL_GIT_COMMIT_REF + origin/main to decide.
expect_build "branch first push with dashboard change builds against origin/main" \
  VERCEL_GIT_COMMIT_REF=dashboard-pr
assert_output_contains "Dashboard-affecting changes detected on branch dashboard-pr vs main"

git switch docs-only >/dev/null 2>&1
expect_skip "branch first push with docs-only change skips against origin/main" \
  VERCEL_GIT_COMMIT_REF=docs-only
assert_output_contains "No dashboard-affecting changes on branch docs-only vs main"

expect_build "branch fallback only triggers on non-main commit ref" \
  VERCEL_GIT_COMMIT_REF=main
assert_output_contains "No VERCEL_GIT_PREVIOUS_SHA; building dashboard."

# Incremental preview diff: a branch whose first commit changed the dashboard
# (already deployed), then a docs-only follow-up push. The full branch-vs-main
# diff still shows the dashboard change, so the merge-base path would rebuild,
# but the diff against the previous branch deployment does not — so the
# redundant follow-up push skips.
git switch -c pr-incremental "$main_sha" >/dev/null 2>&1
printf 'dashboard v3\n' > ui-dashboard/app.txt
git commit -am "dashboard change in PR" -q
pr_prev_sha="$(git rev-parse --verify HEAD)"
printf 'docs v3\n' > AGENTS.md
git commit -am "docs-only follow-up in PR" -q

expect_skip "PR docs-only follow-up skips against previous branch deployment" \
  VERCEL_GIT_PULL_REQUEST_ID=410 \
  VERCEL_GIT_PREVIOUS_SHA="$pr_prev_sha"
assert_output_contains "No dashboard-affecting changes since previous deployment for PR #410"

printf 'dashboard v4\n' > ui-dashboard/app.txt
git commit -am "more dashboard work in PR" -q

expect_build "PR dashboard follow-up builds against previous branch deployment" \
  VERCEL_GIT_PULL_REQUEST_ID=410 \
  VERCEL_GIT_PREVIOUS_SHA="$pr_prev_sha"
assert_output_contains "Dashboard-affecting changes detected since previous deployment for PR #410"

start_mock_github_api
nogit_repo="$fixture_repo/no-git"
mkdir -p "$nogit_repo/ui-dashboard/scripts"
cp "$repo_root/ui-dashboard/scripts/vercel-ignore-build.sh" "$nogit_repo/ui-dashboard/scripts/vercel-ignore-build.sh"

cd "$nogit_repo"

expect_skip "PR docs-only changes skip without local git via GitHub API" \
  GITHUB_API_BASE_URL="$mock_api_base" \
  GIT_CEILING_DIRECTORIES="$nogit_repo" \
  GIT_DIR="$nogit_repo/.git-missing" \
  VERCEL_GIT_PULL_REQUEST_ID=982
assert_output_contains "No dashboard-affecting changes in PR #982"

expect_build "PR dashboard changes build without local git via GitHub API" \
  GITHUB_API_BASE_URL="$mock_api_base" \
  GIT_CEILING_DIRECTORIES="$nogit_repo" \
  GIT_DIR="$nogit_repo/.git-missing" \
  VERCEL_GIT_PULL_REQUEST_ID=983
assert_output_contains "Dashboard-affecting changes detected in PR #983"

expect_skip "branch first push docs-only change skips without local git via GitHub API" \
  GITHUB_API_BASE_URL="$mock_api_base" \
  GIT_CEILING_DIRECTORIES="$nogit_repo" \
  GIT_DIR="$nogit_repo/.git-missing" \
  VERCEL_GIT_COMMIT_REF=docs-only \
  VERCEL_GIT_COMMIT_SHA=sha-docs
assert_output_contains "No dashboard-affecting changes on branch docs-only vs main"

expect_build "branch first push dashboard change builds without local git via GitHub API" \
  GITHUB_API_BASE_URL="$mock_api_base" \
  GIT_CEILING_DIRECTORIES="$nogit_repo" \
  GIT_DIR="$nogit_repo/.git-missing" \
  VERCEL_GIT_COMMIT_REF=dashboard-pr \
  VERCEL_GIT_COMMIT_SHA=sha-dashboard
assert_output_contains "Dashboard-affecting changes detected on branch dashboard-pr vs main"

expect_build "branch first push multi-commit fallback builds without local git" \
  GITHUB_API_BASE_URL="$mock_api_base" \
  GIT_CEILING_DIRECTORIES="$nogit_repo" \
  GIT_DIR="$nogit_repo/.git-missing" \
  VERCEL_GIT_COMMIT_REF=docs-only \
  VERCEL_GIT_COMMIT_SHA=sha-multi-docs
assert_output_contains "Could not resolve origin/main for branch docs-only"

expect_skip "previous SHA docs-only change skips without local git via GitHub API" \
  GITHUB_API_BASE_URL="$mock_api_base" \
  GIT_CEILING_DIRECTORIES="$nogit_repo" \
  GIT_DIR="$nogit_repo/.git-missing" \
  VERCEL_GIT_PREVIOUS_SHA=previous-sha \
  VERCEL_GIT_COMMIT_SHA=sha-docs
assert_output_contains "No dashboard-affecting changes since previous successful Vercel deployment"

expect_build "previous SHA dashboard change builds without local git via GitHub API" \
  GITHUB_API_BASE_URL="$mock_api_base" \
  GIT_CEILING_DIRECTORIES="$nogit_repo" \
  GIT_DIR="$nogit_repo/.git-missing" \
  VERCEL_GIT_PREVIOUS_SHA=previous-sha \
  VERCEL_GIT_COMMIT_SHA=sha-dashboard
assert_output_contains "Dashboard-affecting changes detected since previous successful Vercel deployment"

expect_skip "PR incremental docs-only change skips without local git via GitHub API" \
  GITHUB_API_BASE_URL="$mock_api_base" \
  GIT_CEILING_DIRECTORIES="$nogit_repo" \
  GIT_DIR="$nogit_repo/.git-missing" \
  VERCEL_GIT_PULL_REQUEST_ID=984 \
  VERCEL_GIT_PREVIOUS_SHA=previous-sha \
  VERCEL_GIT_COMMIT_SHA=sha-docs
assert_output_contains "No dashboard-affecting changes since previous deployment for PR #984"

expect_build "PR incremental dashboard change builds without local git via GitHub API" \
  GITHUB_API_BASE_URL="$mock_api_base" \
  GIT_CEILING_DIRECTORIES="$nogit_repo" \
  GIT_DIR="$nogit_repo/.git-missing" \
  VERCEL_GIT_PULL_REQUEST_ID=985 \
  VERCEL_GIT_PREVIOUS_SHA=previous-sha \
  VERCEL_GIT_COMMIT_SHA=sha-dashboard
assert_output_contains "Dashboard-affecting changes detected since previous deployment for PR #985"

cd "$fixture_repo"

git update-ref -d refs/remotes/origin/main
expect_build "PR falls back to build when origin/main is unavailable" \
  GITHUB_API_BASE_URL=http://127.0.0.1:9 \
  VERCEL_GIT_PULL_REQUEST_ID=409
assert_output_contains "Could not resolve origin/main for PR #409; building dashboard."

expect_build "branch fallback falls back to build when origin/main is unavailable" \
  GITHUB_API_BASE_URL=http://127.0.0.1:9 \
  VERCEL_GIT_COMMIT_REF=docs-only
assert_output_contains "Could not resolve origin/main for branch docs-only; building dashboard."

echo "vercel-ignore-build tests passed"
