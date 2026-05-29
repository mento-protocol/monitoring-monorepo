#!/usr/bin/env bash
# Prepare a Codex Cloud container for monitoring-monorepo agent work.
#
# Configure this as the environment setup script in Codex Cloud. It keeps the
# cloud checkout close to a fresh local worktree without requiring anything from
# a developer's home directory.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/codex-cloud-git-helpers.sh
source "$REPO_ROOT/scripts/codex-cloud-git-helpers.sh"

run_as_root() {
  if [[ "$(id -u)" == "0" ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "error: need root privileges to run: $*" >&2
    return 1
  fi
}

is_enabled() {
  case "${1,,}" in
    1|true|yes|y|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_disabled() {
  case "${1,,}" in
    0|false|no|n|off)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

install_github_cli_from_official_apt_repo() {
  local arch
  arch="$(dpkg --print-architecture)"

  echo "==> Installing GitHub CLI from cli.github.com apt repository"
  run_as_root apt-get install -y ca-certificates curl gnupg
  run_as_root install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | run_as_root tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  run_as_root chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | run_as_root tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  run_as_root apt-get update
  run_as_root apt-get install -y gh
}

ensure_github_cli() {
  if command -v gh >/dev/null 2>&1; then
    return 0
  fi

  echo "==> Installing GitHub CLI"
  if command -v apt-get >/dev/null 2>&1; then
    run_as_root apt-get update
    if run_as_root apt-get install -y gh; then
      return 0
    fi

    install_github_cli_from_official_apt_repo
    return 0
  fi

  echo "error: gh is not installed and this image has no apt-get installer." >&2
  echo "Install GitHub CLI in the base image or expose it before running this setup." >&2
  return 1
}

ensure_origin_main_ref() {
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

ensure_github_auth() {
  codex_cloud_normalize_github_token_env

  echo "==> Verifying GitHub CLI auth"
  if gh auth status >/dev/null 2>&1; then
    gh auth status
    return 0
  fi

  if [[ -n "${GH_TOKEN:-}" ]]; then
    # gh honors GH_TOKEN directly. Print status again so setup logs show whether
    # the token has enough scopes for PR feedback sweeps. normalize_github_token_env
    # maps GITHUB_TOKEN to GH_TOKEN so later git credential-helper invocations see
    # the same token that passed this preflight.
    if gh auth status; then
      return 0
    fi
    echo "error: GitHub token is present, but gh rejected it." >&2
    return 1
  fi

  cat >&2 <<'MSG'
error: GitHub CLI is installed, but no GitHub auth is available.
Set GH_TOKEN (preferred) or GITHUB_TOKEN in the Codex Cloud environment with
repo/read PR permissions before running PR ship or babysit flows. Commands such
as `pnpm pr:ready-state --pr <number> --json` shell out to `gh` and require it.
MSG
  return 1
}

configure_github_git_auth() {
  echo "==> Configuring git to use GitHub CLI credentials"
  if gh auth setup-git -h github.com; then
    return 0
  fi

  cat >&2 <<'MSG'
warning: `gh auth setup-git` failed; installing the GitHub CLI credential helper
directly. This fallback keeps token-backed git fetch/push working in ephemeral
cloud containers where gh can authenticate from GH_TOKEN but has no persisted
login record.
MSG
  git config --global credential.https://github.com.helper '!gh auth git-credential'
}

verify_origin_git_auth() {
  local remote_url
  remote_url="$(git remote get-url origin)"
  if [[ "$remote_url" != https://github.com/* && "$remote_url" != git@github.com:* ]]; then
    echo "==> Skipping GitHub auth probe for non-GitHub origin: ${remote_url}"
    return 0
  fi

  echo "==> Verifying git can authenticate to origin"
  if git ls-remote --exit-code --heads origin main >/dev/null; then
    return 0
  fi

  cat >&2 <<'MSG'
error: git could not authenticate to origin through the GitHub CLI credential
helper. Ensure GH_TOKEN/GITHUB_TOKEN has repository contents read/write access,
that Codex Cloud allows HTTPS access to github.com, and that origin uses HTTPS
or has working SSH credentials.
MSG
  return 1
}

append_no_proxy_host() {
  local host="$1"
  local existing=",${NO_PROXY:-},"
  if [[ "$existing" == *",${host},"* ]]; then
    return 0
  fi

  if [[ -n "${NO_PROXY:-}" ]]; then
    export NO_PROXY="${NO_PROXY},${host}"
  else
    export NO_PROXY="$host"
  fi
  export no_proxy="$NO_PROXY"
}

configure_trunk_download_allowlist() {
  if ! is_enabled "${CODEX_CLOUD_TRUNK_BYPASS_PROXY:-}"; then
    return 0
  fi

  local hosts="${CODEX_CLOUD_TRUNK_ALLOWLIST_HOSTS:-trunk.io}"
  local host
  echo "==> Bypassing proxy for Trunk download hosts: ${hosts}"
  for host in ${hosts//,/ }; do
    if [[ -n "$host" ]]; then
      append_no_proxy_host "$host"
    fi
  done
}

trunk_platform() {
  local kernel
  local machine

  kernel="$(uname -s | tr '[:upper:]' '[:lower:]')"
  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64)
      machine="x86_64"
      ;;
    aarch64|arm64)
      machine="arm64"
      ;;
  esac

  echo "${kernel}-${machine}"
}

trunk_version() {
  local version
  version="$(awk '/^[[:space:]]+version:/{print $2; exit}' .trunk/trunk.yaml)"
  if [[ -z "$version" ]]; then
    echo "error: could not read Trunk CLI version from .trunk/trunk.yaml" >&2
    return 1
  fi
  echo "$version"
}

verify_trunk_tarball_checksum() {
  local download_path="$1"
  if [[ -z "${CODEX_CLOUD_TRUNK_TARBALL_SHA256:-}" ]]; then
    echo "error: CODEX_CLOUD_TRUNK_TARBALL_SHA256 is required when CODEX_CLOUD_TRUNK_TARBALL_URL is set." >&2
    return 1
  fi

  echo "==> Verifying mirrored Trunk tarball sha256"
  printf '%s  %s\n' "${CODEX_CLOUD_TRUNK_TARBALL_SHA256}" "$download_path" | sha256sum -c -
}

install_trunk_from_mirror() {
  if [[ -z "${CODEX_CLOUD_TRUNK_TARBALL_URL:-}" ]]; then
    return 1
  fi

  local platform
  local trunk_cache
  local cli_dir
  local version
  local tool_dir
  local tmp_dir
  local download_path

  platform="$(trunk_platform)"
  trunk_cache="${TRUNK_CACHE:-${XDG_CACHE_HOME:-${HOME}/.cache}/trunk}"
  cli_dir="${trunk_cache}/cli"
  version="$(trunk_version)"
  tool_dir="${cli_dir}/${version}-${platform}"

  if [[ -x "${tool_dir}/trunk" ]]; then
    return 0
  fi

  echo "==> Installing Trunk CLI ${version} from CODEX_CLOUD_TRUNK_TARBALL_URL"
  tmp_dir="$(mktemp -d)"
  download_path="${tmp_dir}/trunk.tar.gz"

  local install_status=0
  if curl -fsSL "${CODEX_CLOUD_TRUNK_TARBALL_URL}" -o "$download_path" && \
    verify_trunk_tarball_checksum "$download_path" && \
    tar --strip-components=1 -C "$tmp_dir" -xf "$download_path" && \
    mkdir -p "$tool_dir" && \
    mv "$tmp_dir/trunk" "$tool_dir/trunk" && \
    chmod +x "$tool_dir/trunk"; then
    install_status=0
  else
    install_status=$?
  fi
  rm -rf "$tmp_dir"
  return "$install_status"
}

prewarm_trunk() {
  echo "==> Prewarming Trunk CLI"
  configure_trunk_download_allowlist
  if [[ -n "${CODEX_CLOUD_TRUNK_TARBALL_URL:-}" ]]; then
    if [[ -z "${CODEX_CLOUD_TRUNK_TARBALL_SHA256:-}" ]]; then
      echo "error: CODEX_CLOUD_TRUNK_TARBALL_SHA256 is required when CODEX_CLOUD_TRUNK_TARBALL_URL is set." >&2
      return 1
    fi
    if install_trunk_from_mirror; then
      :
    else
      echo "warning: mirrored Trunk install failed; falling back to ./tools/trunk direct download." >&2
    fi
  fi
  if ./tools/trunk --version >/dev/null 2>&1; then
    ./tools/trunk --version
    return 0
  fi

  cat >&2 <<'MSG'
error: Trunk CLI could not be downloaded during setup.
Codex Cloud must allow HTTPS egress to trunk.io so ./tools/trunk can download
the pinned CLI from .trunk/trunk.yaml. If direct egress is available but the
proxy blocks trunk.io, set CODEX_CLOUD_TRUNK_BYPASS_PROXY=1 to add trunk.io to
NO_PROXY for this setup run. If both direct egress and proxy access are blocked,
allowlist https://trunk.io/releases/ in the cloud/proxy policy or set
CODEX_CLOUD_TRUNK_TARBALL_URL to a reachable mirror of the pinned Linux tarball
plus CODEX_CLOUD_TRUNK_TARBALL_SHA256 for checksum verification. Without this,
local Trunk fmt/check commands and git hooks fail later in the task.
MSG
  ./tools/trunk --version
}

install_trunk_tools() {
  if is_disabled "${CODEX_CLOUD_TRUNK_INSTALL_TOOLS:-true}"; then
    echo "==> Skipping Trunk tool preinstall because CODEX_CLOUD_TRUNK_INSTALL_TOOLS=${CODEX_CLOUD_TRUNK_INSTALL_TOOLS}"
    return 0
  fi

  echo "==> Preinstalling Trunk-managed linters and runtimes"
  if ./tools/trunk install; then
    return 0
  fi

  cat >&2 <<'MSG'
error: Trunk CLI is installed, but `trunk install` could not preinstall its
managed linters/runtimes. Codex Cloud needs HTTPS egress for the package hosts
used by the enabled linters in .trunk/trunk.yaml, including GitHub release hosts
for Trunk plugins/tools plus the language package registries used by those tools.
Run `./tools/trunk install` in the cloud setup log to identify the blocked host,
then allowlist that host or provide a prewarmed Trunk cache in the base image.
MSG
  return 1
}

echo "==> Marking repository safe for git"
git config --global --add safe.directory "$REPO_ROOT" || true

ensure_github_cli
ensure_github_auth
configure_github_git_auth

codex_cloud_ensure_origin_remote
verify_origin_git_auth
ensure_origin_main_ref

echo "==> Configuring repository git hooks"
git config core.hooksPath .trunk/hooks

echo "==> Activating package manager from package.json"
if command -v corepack >/dev/null 2>&1; then
  corepack enable
  PNPM_VERSION="$(node -p "require('./package.json').packageManager.split('@')[1]")"
  corepack prepare "pnpm@${PNPM_VERSION}" --activate
fi
pnpm --version

prewarm_trunk
install_trunk_tools

echo "==> Installing workspace dependencies"
CI=true pnpm install --frozen-lockfile

echo "==> Verifying dashboard dependency resolution"
pnpm --filter @mento-protocol/ui-dashboard exec node -e "require.resolve('@sentry/nextjs/package.json')"

echo "==> Running Envio codegen"
pnpm indexer:codegen

echo "==> Validating repo-visible agent context"
pnpm agent:context-check

echo "Codex Cloud setup complete."
