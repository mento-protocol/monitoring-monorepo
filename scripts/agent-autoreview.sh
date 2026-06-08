#!/usr/bin/env bash
set -euo pipefail

helper="${AUTOREVIEW_HELPER:-$HOME/.agents/skills/autoreview/scripts/autoreview}"

if [[ ! -x "$helper" ]]; then
  cat >&2 <<EOF
agent:autoreview requires the global autoreview skill helper:
  $helper

Install or restore ~/.agents/skills/autoreview, then retry.
EOF
  exit 127
fi

if [[ "${1:-}" == "--" ]]; then
  shift
fi

running_inside_codex_sandbox() {
  [[ -n "${CODEX_SANDBOX:-}" || -n "${CODEX_THREAD_ID:-}" ]]
}

has_explicit_engine() {
  if [[ -n "${AUTOREVIEW_ENGINE:-}" ]]; then
    return 0
  fi

  local arg
  for arg in "$@"; do
    case "$arg" in
      --engine | --engine=*)
        return 0
        ;;
    esac
  done

  return 1
}

has_prepare_only() {
  local arg
  for arg in "$@"; do
    if [[ "$arg" == "--prepare-only" ]]; then
      return 0
    fi
  done

  return 1
}

if running_inside_codex_sandbox && ! has_explicit_engine "$@" && ! has_prepare_only "$@"; then
  cat >&2 <<EOF
agent:autoreview: detected Codex sandbox; defaulting to --engine local because nested codex exec is unavailable here.
agent:autoreview: pass --engine codex, --engine claude, or AUTOREVIEW_ENGINE to override.
EOF
  set -- --engine local "$@"
fi

exec "$helper" "$@"
