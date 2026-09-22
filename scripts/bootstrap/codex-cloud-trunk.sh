#!/usr/bin/env bash
# Trunk CLI provisioning for Codex Cloud setup: bypass the proxy for the
# download hosts, install the pinned CLI, and preinstall its managed tools.
#
# Source-only helper. It leaves shell options to its caller and defines no
# top-level side effects.
#
# Reads CODEX_CLOUD_TRUNK_BYPASS_PROXY, CODEX_CLOUD_TRUNK_ALLOWLIST_HOSTS,
# CODEX_CLOUD_TRUNK_TARBALL_URL, CODEX_CLOUD_TRUNK_TARBALL_SHA256,
# CODEX_CLOUD_TRUNK_INSTALL_TOOLS, TRUNK_CACHE, XDG_CACHE_HOME, HOME and
# NO_PROXY. Writes NO_PROXY and no_proxy.
#
# Calls is_enabled and is_disabled, which stay in codex-cloud-setup.sh.

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
