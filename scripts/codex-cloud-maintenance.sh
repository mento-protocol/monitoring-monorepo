#!/usr/bin/env bash
# Refresh a cached Codex Cloud container after Codex checks out a task branch.
#
# Configure this as the environment maintenance script in Codex Cloud. It keeps
# branch-sensitive state fresh without repeating the setup script's apt/tool
# installation work.

set -euo pipefail

readonly DEFAULT_REPO_SLUG="mento-protocol/monitoring-monorepo"
readonly DEFAULT_ORIGIN_URL="https://github.com/${DEFAULT_REPO_SLUG}.git"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

normalize_github_token_env() {
  if [[ -z "${GH_TOKEN:-}" && -n "${GITHUB_TOKEN:-}" ]]; then
    export GH_TOKEN="$GITHUB_TOKEN"
  fi
}

ensure_origin_remote() {
  local origin_url="${CODEX_CLOUD_ORIGIN_URL:-}"
  if [[ -z "$origin_url" ]]; then
    if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
      origin_url="https://github.com/${GITHUB_REPOSITORY}.git"
    else
      origin_url="$DEFAULT_ORIGIN_URL"
    fi
  fi

  if git remote get-url origin >/dev/null 2>&1; then
    local existing_origin
    existing_origin="$(git remote get-url origin)"
    if [[ -n "${CODEX_CLOUD_ORIGIN_URL:-}" && "$existing_origin" != "$origin_url" ]]; then
      echo "==> Replacing origin remote from CODEX_CLOUD_ORIGIN_URL: ${origin_url}"
      git remote set-url origin "$origin_url"
    elif [[ "$existing_origin" =~ ^git@github\.com:(.+)$ ]]; then
      local repo_path
      repo_path="${BASH_REMATCH[1]%.git}"
      local https_origin="https://github.com/${repo_path}.git"
      echo "==> Rewriting SSH origin for token-backed cloud auth: ${https_origin}"
      git remote set-url origin "$https_origin"
    elif [[ "$existing_origin" =~ ^ssh://git@github\.com/(.+)$ ]]; then
      local repo_path
      repo_path="${BASH_REMATCH[1]%.git}"
      local https_origin="https://github.com/${repo_path}.git"
      echo "==> Rewriting SSH origin for token-backed cloud auth: ${https_origin}"
      git remote set-url origin "$https_origin"
    else
      echo "==> Using existing origin remote: ${existing_origin}"
    fi
  else
    echo "==> Adding missing origin remote: ${origin_url}"
    git remote add origin "$origin_url"
  fi
}

configure_github_git_auth_if_available() {
  normalize_github_token_env

  if ! command -v gh >/dev/null 2>&1; then
    echo "WARN: gh is not installed; continuing with existing git credentials." >&2
    return 0
  fi

  if gh auth status >/dev/null 2>&1 || [[ -n "${GH_TOKEN:-}" ]]; then
    echo "==> Configuring git to use GitHub CLI credentials"
    if gh auth setup-git -h github.com; then
      return 0
    fi

    cat >&2 <<'MSG'
warning: `gh auth setup-git` failed; installing the GitHub CLI credential helper
directly for this cached container.
MSG
    git config --global credential.https://github.com.helper '!gh auth git-credential'
  else
    echo "WARN: gh is installed but unauthenticated; continuing with existing git credentials." >&2
  fi
}

refresh_origin_main() {
  echo "==> Refreshing origin/main for path-aware agent gates"
  if git fetch --no-tags --prune origin "+refs/heads/main:refs/remotes/origin/main"; then
    return 0
  fi

  cat >&2 <<'MSG'
error: could not fetch origin/main. Verify the origin remote is reachable from
Codex Cloud and that GitHub auth has enough repository read permission.
MSG
  return 1
}

activate_package_manager() {
  echo "==> Activating package manager from package.json"
  if command -v corepack >/dev/null 2>&1; then
    corepack enable
    PNPM_VERSION="$(node -p "require('./package.json').packageManager.split('@')[1]")"
    corepack prepare "pnpm@${PNPM_VERSION}" --activate
  fi
  pnpm --version
}

echo "==> Marking repository safe for git"
git config --global --add safe.directory "$REPO_ROOT" || true

ensure_origin_remote
configure_github_git_auth_if_available
refresh_origin_main

echo "==> Configuring repository git hooks"
git config core.hooksPath .trunk/hooks

activate_package_manager

echo "==> Syncing workspace dependencies for the checked-out branch"
CI=true pnpm install --frozen-lockfile --prefer-offline

echo "==> Regenerating Envio types for the checked-out branch"
pnpm indexer:codegen

echo "==> Validating repo-visible agent context"
pnpm agent:context-check

echo "Codex Cloud maintenance complete."
