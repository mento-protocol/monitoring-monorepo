#!/usr/bin/env bash
# Shared Git/GitHub helpers for Codex Cloud setup and maintenance scripts.

codex_cloud_normalize_github_token_env() {
  if [[ -z "${GH_TOKEN:-}" && -n "${GITHUB_TOKEN:-}" ]]; then
    export GH_TOKEN="$GITHUB_TOKEN"
  fi
}

codex_cloud_default_origin_url() {
  if [[ -n "${CODEX_CLOUD_ORIGIN_URL:-}" ]]; then
    echo "$CODEX_CLOUD_ORIGIN_URL"
  elif [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
    echo "https://github.com/${GITHUB_REPOSITORY}.git"
  else
    echo "https://github.com/mento-protocol/monitoring-monorepo.git"
  fi
}

codex_cloud_ensure_origin_remote() {
  local origin_url
  origin_url="$(codex_cloud_default_origin_url)"

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
