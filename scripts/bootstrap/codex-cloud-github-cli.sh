#!/usr/bin/env bash
# GitHub CLI provisioning for Codex Cloud setup: install the binary, then make
# sure it carries the flags this repository's agent flows call.
#
# Source-only helper. It leaves shell options to its caller and defines no
# top-level side effects.

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

CODEX_CLOUD_GH_APT_SOURCE="/etc/apt/sources.list.d/github-cli.list"
CODEX_CLOUD_GH_APT_KEYRING="/etc/apt/keyrings/githubcli-archive-keyring.gpg"

# Download first, install second. Piping curl straight into `tee` truncates an
# existing keyring the moment the download fails, and this installer now also
# runs on images whose GitHub apt source already works — an emptied keyring
# there would break every later `apt-get update`, including Playwright's host
# dependencies. The subshell keeps the cleanup trap local, so every return path
# removes the temporary file.
install_github_cli_keyring() (
  local keyring_tmp
  keyring_tmp="$(mktemp "${TMPDIR:-/tmp}/githubcli-keyring.XXXXXX")" || return 1
  trap 'rm -f -- "$keyring_tmp"' EXIT

  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o "$keyring_tmp" || return 1
  [[ -s "$keyring_tmp" ]] || return 1
  run_as_root install -m 0644 "$keyring_tmp" "$CODEX_CLOUD_GH_APT_KEYRING" || return 1
)

# Every step returns on its own failure, so the caller's context cannot change
# where this stops: bash suspends `errexit` inside a function invoked from an
# `if`, `&&`, or `||` list, and without these guards a failed keyring install
# would still write an apt source pointing at a keyring that does not exist.
install_github_cli_from_official_apt_repo() {
  local arch
  arch="$(dpkg --print-architecture)" || return 1

  echo "==> Installing GitHub CLI from cli.github.com apt repository"
  run_as_root apt-get install -y ca-certificates curl gnupg || return 1
  run_as_root install -m 0755 -d /etc/apt/keyrings || return 1
  install_github_cli_keyring || return 1
  run_as_root chmod go+r "$CODEX_CLOUD_GH_APT_KEYRING" || return 1
  echo "deb [arch=${arch} signed-by=${CODEX_CLOUD_GH_APT_KEYRING}] https://cli.github.com/packages stable main" |
    run_as_root tee "$CODEX_CLOUD_GH_APT_SOURCE" >/dev/null ||
    return 1
  run_as_root apt-get update || return 1
  run_as_root apt-get install -y gh || return 1
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

# Probe the flag, never the version string: distro builds backport flags
# unevenly, so `gh --version` is not evidence that `--attach` exists. Capture
# the help text first and match it separately, because `set -o pipefail` would
# report a missing or failing gh as a pipeline failure rather than as the
# "unsupported" answer this probe owes its caller.
gh_supports_pr_edit_attach() {
  local help_text
  command -v gh >/dev/null 2>&1 || return 1
  help_text="$(gh pr edit --help 2>/dev/null)" || return 1
  grep -q -- '--attach' <<<"$help_text"
}

# `gh pr edit --attach` uploads the Before/After screenshots that
# docs/notes/dashboard-verification.md requires; it landed in gh 2.99.0, while
# the distro package ensure_github_cli may have accepted predates it. Upgrade
# through the official apt repository above rather than adding a download
# source. Non-fatal on purpose: only dashboard visual evidence needs this flag,
# so a blocked upgrade must name the blocker here instead of failing an
# environment whose other agent work is unaffected.
ensure_github_cli_attach_support() {
  if gh_supports_pr_edit_attach; then
    return 0
  fi

  if command -v apt-get >/dev/null 2>&1; then
    echo "==> Upgrading GitHub CLI for 'gh pr edit --attach' (visual-evidence uploads)"
    # ensure_github_cli refreshes apt only when gh was missing, so an image that
    # ships an old gh and cleaned its package lists reaches this point with none.
    # Advisory: a stale list can still hold a usable candidate, so a failed
    # refresh must not stop the attempt.
    run_as_root apt-get update || true

    local apt_source_added=false
    if [[ -e "$CODEX_CLOUD_GH_APT_SOURCE" ]]; then
      # A GitHub CLI apt source is already configured — the image's own, or an
      # approved mirror. Upgrade through it rather than overwrite a file this
      # optional step has no way to restore.
      run_as_root apt-get install -y gh || true
    else
      # `|| true`: this optional upgrade must never abort setup. The re-probe
      # below, not this exit status, decides whether it worked.
      install_github_cli_from_official_apt_repo || true
      apt_source_added=true
    fi

    hash -r 2>/dev/null || true
    if gh_supports_pr_edit_attach; then
      return 0
    fi

    # The upgrade produced no usable gh, so an apt source this call added points
    # at a host this environment cannot reach. Drop it again rather than leave a
    # source that fails every later `apt-get update`, including Playwright's
    # host-dependency install.
    if [[ "$apt_source_added" == "true" && -e "$CODEX_CLOUD_GH_APT_SOURCE" ]]; then
      run_as_root rm -f "$CODEX_CLOUD_GH_APT_SOURCE" || true
    fi
  fi

  cat >&2 <<'MSG'
warning: the gh on PATH has no `gh pr edit --attach` (added in gh 2.99.0), and
this environment could not upgrade it. Allow HTTPS egress to
https://cli.github.com/packages so the official apt repository can install a
current gh, or ship gh 2.99.0 or later in the base image. Until then dashboard
UI pull requests cannot upload the Before/After screenshots that
docs/notes/dashboard-verification.md requires, and a UI task here must report
that as a blocker instead of publishing without visual evidence. All other
setup steps and agent flows are unaffected.
MSG
}
