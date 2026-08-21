#!/usr/bin/env bash
# Focused tests for the fork-head refusal in babysit_repo_gate.
#
# The gate is fail-closed: a fork head must never reach pr:ready-state, and an
# unreadable fork status must not read as ready. Run: bash .claude/babysit-pr.test.sh
set -uo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/babysit-pr.sh"
pass=0
fail=0

# Fake checkout: has package.json with a pr:ready-state script, so the gate
# reaches the fork check instead of short-circuiting on the checkout guards.
make_root() {
  local d
  d="$(mktemp -d)"
  printf '{"scripts":{"pr:ready-state":"true"}}' >"$d/package.json"
  printf '%s' "$d"
}

# $1 = expected prefix, $2 = label, $3 = stub body for `gh`
check() {
  local want=$1 label=$2 stub=$3 root out bin
  root="$(make_root)"
  bin="$(mktemp -d)"
  printf '#!/usr/bin/env bash\n%s\n' "$stub" >"$bin/gh"
  chmod +x "$bin/gh"
  # pnpm must never run for a refused PR; make it explode if the gate slips past.
  printf '#!/usr/bin/env bash\necho "pnpm should not run" >&2\nexit 99\n' >"$bin/pnpm"
  chmod +x "$bin/pnpm"

  out=$(
    # Scoping PATH to this subshell is the isolation: the stubs must not leak
    # into the next case. SC2030/SC2031 flag exactly that, and it is intended.
    # shellcheck disable=SC2030,SC2031
    PATH="$bin:$PATH"
    unset CLAUDE_CODE_REMOTE
    # shellcheck disable=SC1090
    source "$HOOK"
    babysit_repo_gate 123 mento-protocol monitoring-monorepo "$root"
  )

  if [[ "$out" == "$want"* ]]; then
    printf '  ok    %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '  FAIL  %s\n        want prefix: %s\n        got:         %s\n' "$label" "$want" "$out"
    fail=$((fail + 1))
  fi
  rm -rf "$root" "$bin"
}

check FAIL 'fork head is refused' \
  'echo true'
check PENDING 'unreadable fork status does not read as ready' \
  'exit 1'
# Same-repo falls through to pr:ready-state. Assert on the reason, not just the
# verdict: both outcomes are FAIL, so a prefix check alone would pass even if
# the gate had refused it as a fork.
refute() {
  local label=$1 stub=$2 root out bin
  root="$(make_root)"
  bin="$(mktemp -d)"
  printf '#!/usr/bin/env bash\n%s\n' "$stub" >"$bin/gh"
  chmod +x "$bin/gh"
  printf '#!/usr/bin/env bash\nexit 99\n' >"$bin/pnpm"
  chmod +x "$bin/pnpm"
  out=$(
    # Scoping PATH to this subshell is the isolation: the stubs must not leak
    # into the next case. SC2030/SC2031 flag exactly that, and it is intended.
    # shellcheck disable=SC2030,SC2031
    PATH="$bin:$PATH"
    unset CLAUDE_CODE_REMOTE
    # shellcheck disable=SC1090
    source "$HOOK"
    babysit_repo_gate 123 mento-protocol monitoring-monorepo "$root"
  )
  if [[ "$out" != *"fork head"* && "$out" == *"pr:ready-state"* ]]; then
    printf '  ok    %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '  FAIL  %s\n        got: %s\n' "$label" "$out"
    fail=$((fail + 1))
  fi
  rm -rf "$root" "$bin"
}
refute 'same-repo head reaches the probe, not the fork refusal' \
  'echo false'

printf '%s passed, %s failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
