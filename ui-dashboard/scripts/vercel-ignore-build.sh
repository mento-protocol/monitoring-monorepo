#!/usr/bin/env bash
# Last manual redeploy nudge: 2026-06-09 — force prod rebuild for #810 (merge SHA was deduped onto an envio preview, so main's production deploy never fired).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

dashboard_paths=(
  "ui-dashboard"
  "shared-config"
  "package.json"
  "pnpm-lock.yaml"
  "pnpm-workspace.yaml"
  "patches"
  # `.lighthouserc.cjs` must trigger a Vercel preview so the matching
  # `.github/workflows/lighthouse.yml` filter (which also includes this
  # file) actually has a deployment to audit when the lhci config
  # changes. Without this, config-only PRs would skip Vercel build,
  # the workflow would wait for a non-existent preview, and the
  # required check would time out instead of validating the new budgets.
  ".lighthouserc.cjs"
)

pull_request_id="${VERCEL_GIT_PULL_REQUEST_ID:-}"
commit_ref="${VERCEL_GIT_COMMIT_REF:-}"
commit_sha="${VERCEL_GIT_COMMIT_SHA:-}"
repo_owner="${VERCEL_GIT_REPO_OWNER:-mento-protocol}"
repo_slug="${VERCEL_GIT_REPO_SLUG:-monitoring-monorepo}"
github_api_base="${GITHUB_API_BASE_URL:-https://api.github.com}"

has_git_repo() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1
}

skip_or_build_from_files() {
  local changed_files="$1"
  local skip_message="$2"
  local build_message="$3"

  local changed_file dashboard_path
  while IFS= read -r changed_file; do
    [[ -n "$changed_file" ]] || continue
    for dashboard_path in "${dashboard_paths[@]}"; do
      case "$changed_file" in
        "$dashboard_path" | "$dashboard_path"/*)
          echo "$build_message"
          exit 1
          ;;
      esac
    done
  done <<<"$changed_files"

  echo "$skip_message"
  exit 0
}

github_changed_files() {
  local mode="$1"
  local base_ref="$2"
  local head_ref="$3"

  GITHUB_DIFF_MODE="$mode" \
    GITHUB_DIFF_BASE="$base_ref" \
    GITHUB_DIFF_HEAD="$head_ref" \
    GITHUB_API_BASE_URL="$github_api_base" \
    GITHUB_REPO_OWNER="$repo_owner" \
    GITHUB_REPO_SLUG="$repo_slug" \
    node <<'NODE'
const mode = process.env.GITHUB_DIFF_MODE;
const baseRef = process.env.GITHUB_DIFF_BASE;
const headRef = process.env.GITHUB_DIFF_HEAD;
const apiBase = process.env.GITHUB_API_BASE_URL;
const owner = process.env.GITHUB_REPO_OWNER;
const repo = process.env.GITHUB_REPO_SLUG;
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "monitoring-monorepo-vercel-ignore-build",
};
if (token) {
  headers.Authorization = `Bearer ${token}`;
}

function apiUrl(path) {
  return new URL(path, `${apiBase.replace(/\/+$/, "")}/`);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} from ${url}`);
  }
  return response.json();
}

async function listPrFiles(prNumber) {
  const files = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = apiUrl(
      `/repos/${owner}/${repo}/pulls/${encodeURIComponent(
        prNumber,
      )}/files?per_page=100&page=${page}`,
    );
    const pageFiles = await fetchJson(url);
    if (!Array.isArray(pageFiles)) {
      throw new Error("GitHub PR files response was not an array");
    }
    files.push(...pageFiles.map((file) => file.filename).filter(Boolean));
    if (pageFiles.length < 100) {
      return files;
    }
  }
  throw new Error("GitHub PR file list exceeded pagination safety limit");
}

async function compareFiles(base, head, singleCommitOnly) {
  const url = apiUrl(
    `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
  );
  const comparison = await fetchJson(url);
  if (singleCommitOnly && comparison.ahead_by > 1) {
    throw new Error(
      `branch fallback has ${comparison.ahead_by} commits; build instead of risking a false skip`,
    );
  }
  if (!Array.isArray(comparison.files)) {
    throw new Error("GitHub compare response did not include files");
  }
  if (comparison.files.length >= 300) {
    throw new Error("GitHub compare response may be truncated at 300 files");
  }
  return comparison.files.map((file) => file.filename).filter(Boolean);
}

try {
  let files;
  if (mode === "pr") {
    files = await listPrFiles(headRef);
  } else if (mode === "branch-first") {
    files = await compareFiles(baseRef, headRef, true);
  } else if (mode === "compare") {
    files = await compareFiles(baseRef, headRef, false);
  } else {
    throw new Error(`unknown diff mode: ${mode}`);
  }
  console.log(files.join("\n"));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
NODE
}

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

  has_git_repo || return 1

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

  if changed_files="$(github_changed_files pr "" "$pull_request_id")"; then
    skip_or_build_from_files \
      "$changed_files" \
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

    if [[ -n "$commit_sha" ]] &&
      changed_files="$(github_changed_files branch-first main "$commit_sha")"; then
      skip_or_build_from_files \
        "$changed_files" \
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
  if [[ -n "$commit_sha" ]] &&
    changed_files="$(github_changed_files compare "$base_sha" "$commit_sha")"; then
    skip_or_build_from_files \
      "$changed_files" \
      "No dashboard-affecting changes since previous successful Vercel deployment; skipping build." \
      "Dashboard-affecting changes detected since previous successful Vercel deployment; building dashboard."
  fi

  echo "Previous Vercel SHA ${base_sha} is unavailable in this clone; building dashboard."
  exit 1
fi

skip_or_build_from_base \
  "$base_sha" \
  "No dashboard-affecting changes since previous successful Vercel deployment; skipping build." \
  "Dashboard-affecting changes detected since previous successful Vercel deployment; building dashboard."
