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

exec "$helper" "$@"
