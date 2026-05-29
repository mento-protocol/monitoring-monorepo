#!/usr/bin/env bash
# Refresh a cached Codex Cloud container after Codex checks out a task branch.
#
# Configure this as the environment maintenance script in Codex Cloud. It keeps
# branch-sensitive state fresh without repeating the setup script's apt/tool
# installation work.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/codex-cloud-git-helpers.sh
source "$REPO_ROOT/scripts/codex-cloud-git-helpers.sh"

configure_github_git_auth_if_available() {
  codex_cloud_normalize_github_token_env

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

codex_cloud_ensure_origin_remote
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
