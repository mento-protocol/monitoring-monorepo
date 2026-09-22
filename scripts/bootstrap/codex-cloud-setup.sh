#!/usr/bin/env bash
# Prepare a Codex Cloud container for monitoring-monorepo agent work.
#
# Configure this as the environment setup script in Codex Cloud. It keeps the
# cloud checkout close to a fresh local worktree without requiring anything from
# a developer's home directory.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=scripts/bootstrap/codex-cloud-git-helpers.sh
source "$REPO_ROOT/scripts/bootstrap/codex-cloud-git-helpers.sh"

# shellcheck source=scripts/bootstrap/codex-cloud-github-cli.sh
source "$REPO_ROOT/scripts/bootstrap/codex-cloud-github-cli.sh"
# shellcheck source=scripts/bootstrap/codex-cloud-trunk.sh
source "$REPO_ROOT/scripts/bootstrap/codex-cloud-trunk.sh"

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

persist_user_path_entry() {
  local path_entry="$1"
  local export_line="export PATH=\"${path_entry}:\$PATH\""

  for profile in "$HOME/.bashrc" "$HOME/.profile"; do
    touch "$profile"
    if ! grep -Fqx "$export_line" "$profile"; then
      printf '\n%s\n' "$export_line" >>"$profile"
    fi
  done
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
  if [[ "$remote_url" != https://github.com/* && "$remote_url" != git@github.com:* && "$remote_url" != ssh://git@github.com/* ]]; then
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

verify_github_api_capabilities() {
  local remote_url
  local repository
  remote_url="$(git remote get-url origin)"
  if [[ "$remote_url" != https://github.com/* && "$remote_url" != git@github.com:* && "$remote_url" != ssh://git@github.com/* ]]; then
    echo "==> Skipping GitHub API probes for non-GitHub origin: ${remote_url}"
    return 0
  fi

  repository="${remote_url#https://github.com/}"
  repository="${repository#git@github.com:}"
  repository="${repository#ssh://git@github.com/}"
  repository="${repository%.git}"

  echo "==> Verifying GitHub repository API access"
  gh api "repos/${repository}" >/dev/null

  echo "==> Verifying GitHub pull-request API read access"
  gh api "repos/${repository}/pulls?state=open&per_page=1" >/dev/null
}

verify_origin_write_access() (
  local remote_url
  local probe_branch
  local probe_ref
  local probe_suffix
  local cleanup_eligible=false
  remote_url="$(git remote get-url origin)"
  if [[ "$remote_url" != https://github.com/* && "$remote_url" != git@github.com:* && "$remote_url" != ssh://git@github.com/* ]]; then
    echo "==> Skipping GitHub write probe for non-GitHub origin: ${remote_url}"
    return 0
  fi

  probe_suffix="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  probe_branch="codex-cloud-write-probe-${probe_suffix}"
  probe_ref="refs/heads/${probe_branch}"

  # Invoked indirectly by the EXIT trap below.
  # shellcheck disable=SC2329
  cleanup_probe_ref() {
    if [[ "$cleanup_eligible" == "true" ]]; then
      git push origin --delete "$probe_branch" >/dev/null 2>&1 ||
        echo "warning: could not remove temporary GitHub write probe ${probe_branch}." >&2
    fi
  }
  trap cleanup_probe_ref EXIT

  # A dry run suppresses the ref update, so it cannot prove that the remote
  # accepts branch creation. Use a collision-resistant ref and remove it here.
  echo "==> Verifying git can create and delete a temporary branch on origin"
  # The server may create the ref even when the client loses the success
  # response. Make cleanup eligible before the push so the EXIT trap also
  # covers that ambiguous failure.
  cleanup_eligible=true
  if ! git push origin "HEAD:${probe_ref}" >/dev/null; then
    cat >&2 <<'MSG'
error: GitHub authentication can read this repository but cannot create a
temporary branch. Give the Codex Cloud GH_TOKEN/GITHUB_TOKEN repository
Contents read/write permission, then start a fresh session. Pull request and
ship flows cannot publish commits with a read-only token.
MSG
    return 1
  fi

  if ! git push origin --delete "$probe_branch" >/dev/null; then
    echo "error: GitHub authentication created the temporary write probe but could not delete it: ${probe_branch}" >&2
    return 1
  fi
  cleanup_eligible=false
)

is_valid_sha256() {
  [[ "$1" =~ ^[0-9a-fA-F]{64}$ ]]
}

# Keep the cleanup trap local to this subshell so every return removes the file.
run_verified_foundry_installer() (
  local foundryup_url="$1"
  local expected_sha256="$2"
  local installer=""

  if ! installer="$(mktemp "${TMPDIR:-/tmp}/codex-cloud-foundryup.XXXXXX")"; then
    echo "error: could not create a temporary file for the Foundry installer." >&2
    return 1
  fi
  trap 'rm -f -- "$installer"' EXIT

  if ! curl -fsSL "$foundryup_url" -o "$installer"; then
    echo "error: could not download the configured Foundry installer." >&2
    return 1
  fi
  if [[ ! -f "$installer" || -L "$installer" ]]; then
    echo "error: the downloaded Foundry installer is not a regular file." >&2
    return 1
  fi

  echo "==> Verifying configured Foundry installer sha256"
  if ! printf '%s  %s\n' "$expected_sha256" "$installer" | sha256sum -c -; then
    echo "error: the configured Foundry installer sha256 does not match." >&2
    return 1
  fi
  if ! bash "$installer"; then
    echo "error: the verified Foundry installer failed." >&2
    return 1
  fi
)

# Resolve the Foundry installer source and refuse an unverifiable one. It
# reads default_foundryup_url and assigns foundryup_url and
# foundryup_sha256, all three declared local by install_foundry. The body is
# tests and echo only, so the caller may invoke it conditionally without
# changing where errexit applies.
resolve_foundry_installer() {
  foundryup_url="${CODEX_CLOUD_FOUNDRYUP_URL:-$default_foundryup_url}"
  foundryup_sha256="${CODEX_CLOUD_FOUNDRYUP_SHA256:-}"

  if [[ "$foundryup_url" != "$default_foundryup_url" && -z "$foundryup_sha256" ]]; then
    echo "error: CODEX_CLOUD_FOUNDRYUP_SHA256 is required when CODEX_CLOUD_FOUNDRYUP_URL changes the default Foundry installer URL." >&2
    return 1
  fi
  if [[ -n "$foundryup_sha256" ]] && ! is_valid_sha256 "$foundryup_sha256"; then
    echo "error: CODEX_CLOUD_FOUNDRYUP_SHA256 must contain exactly 64 hexadecimal characters." >&2
    return 1
  fi
}

install_foundry() {
  if is_disabled "${CODEX_CLOUD_INSTALL_FOUNDRY:-true}"; then
    echo "==> Skipping Foundry install because CODEX_CLOUD_INSTALL_FOUNDRY=${CODEX_CLOUD_INSTALL_FOUNDRY}"
    return 0
  fi

  export PATH="${HOME}/.foundry/bin:${PATH}"
  persist_user_path_entry "$HOME/.foundry/bin"
  if command -v forge >/dev/null 2>&1; then
    echo "==> Foundry already available"
    forge --version
    return 0
  fi

  echo "==> Installing Foundry for Aegis forge tests"
  local default_foundryup_url="https://foundry.paradigm.xyz"
  local foundryup_url
  local foundryup_sha256
  resolve_foundry_installer || return 1

  if [[ -n "$foundryup_sha256" ]]; then
    if ! run_verified_foundry_installer "$foundryup_url" "$foundryup_sha256"; then
      return 1
    fi
  else
    # Preserve Foundry's documented public bootstrap path only for the exact
    # default URL. Every custom URL must use the verified-file path above.
    if ! curl -fsSL "$default_foundryup_url" | bash; then
      echo "error: the default Foundry installer failed." >&2
      return 1
    fi
  fi
  if ! command -v foundryup >/dev/null 2>&1; then
    cat >&2 <<'MSG'
error: foundryup was not installed on PATH after running the Foundry installer.
Codex Cloud must allow HTTPS egress to foundry.paradigm.xyz and GitHub release
hosts, or the base image must preinstall Foundry. Aegis Foundry checks require
`forge` on PATH.
MSG
    return 1
  fi

  if ! foundryup; then
    echo "error: foundryup failed after the Foundry installer completed." >&2
    return 1
  fi
  forge --version
}

check_osv_api_egress() {
  if is_disabled "${CODEX_CLOUD_CHECK_OSV_EGRESS:-true}"; then
    echo "==> Skipping OSV API egress check because CODEX_CLOUD_CHECK_OSV_EGRESS=${CODEX_CLOUD_CHECK_OSV_EGRESS}"
    return 0
  fi

  echo "==> Checking OSV API egress"
  if curl -fsS --max-time 20 \
    -H "Content-Type: application/json" \
    -d '{"queries":[{"package":{"ecosystem":"npm","name":"lodash"},"version":"4.17.20"}]}' \
    https://api.osv.dev/v1/querybatch >/dev/null; then
    return 0
  fi

  cat >&2 <<'MSG'
error: Codex Cloud could not query https://api.osv.dev/v1/querybatch.
Enable Agent internet access for this environment, allowlist api.osv.dev, and
allow POST requests. Trunk's osv-scanner linter uses this API during
`./tools/trunk check --ci --all`.
MSG
  return 1
}

install_playwright_host_dependencies() {
  if is_disabled "${CODEX_CLOUD_INSTALL_PLAYWRIGHT_DEPS:-true}"; then
    echo "==> Skipping Playwright host dependencies because CODEX_CLOUD_INSTALL_PLAYWRIGHT_DEPS=${CODEX_CLOUD_INSTALL_PLAYWRIGHT_DEPS}"
    return 0
  fi

  echo "==> Installing Playwright Chromium and Linux host dependencies"
  pnpm --filter @mento-protocol/ui-dashboard exec playwright install --with-deps chromium
}

# The offline installer suite sources these functions without running setup.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

cd "$REPO_ROOT"

echo "==> Marking repository safe for git"
git config --global --add safe.directory "$REPO_ROOT" || true

ensure_github_cli
ensure_github_cli_attach_support
ensure_github_auth
configure_github_git_auth

codex_cloud_ensure_origin_remote
verify_origin_git_auth
verify_github_api_capabilities
verify_origin_write_access
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
install_foundry
check_osv_api_egress

echo "==> Installing workspace dependencies"
CI=true pnpm install --frozen-lockfile

echo "==> Verifying dashboard dependency resolution"
pnpm --filter @mento-protocol/ui-dashboard exec node -e "require.resolve('@sentry/nextjs/package.json')"

install_playwright_host_dependencies

echo "==> Running Envio codegen"
# Drop any stale type facade first: a reused/cached checkout may already carry
# the gitignored .envio/types.d.ts, which would let the verification below pass
# even if THIS codegen run silently wrote nothing -- the exact miss we guard for.
rm -f indexer-envio/.envio/types.d.ts
pnpm indexer:codegen

echo "==> Verifying Envio codegen output"
if [ ! -s "indexer-envio/.envio/types.d.ts" ]; then
  cat >&2 <<'MSG'
error: Envio codegen did not produce indexer-envio/.envio/types.d.ts.
`pnpm --filter @mento-protocol/indexer-envio typecheck` and the indexer vitest
suites resolve types from this file and will fail without it. `envio codegen` is
quiet in CI/non-TTY mode and exits 0 even when it writes nothing, so re-run
`pnpm indexer:codegen` and inspect the envio CLI output for the underlying error.
(The ReScript `generated/` dir is intentionally not produced here -- it is only
needed for `pnpm indexer:dev`/`start`, which needs Docker plus live RPC.)
MSG
  exit 1
fi

echo "==> Validating repo-visible agent context"
pnpm agent:context-check

echo "Codex Cloud setup complete."
