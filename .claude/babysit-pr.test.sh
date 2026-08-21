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

# $1 = expected prefix, $2 = label, $3 = stub body for `gh`, $4 = optional env
# assignment applied inside the subshell (e.g. CLAUDE_CODE_REMOTE=1)
check() {
  local want=$1 label=$2 stub=$3 extra_env=${4:-} root out bin
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
    [[ -n "$extra_env" ]] && export "${extra_env?}"
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
# Ordering regression: the cloud capability guard returns PENDING early. If the
# fork check ever moves below it, a fork PR stops being refused on the cloud
# path — which is where fork risk is highest. Pin the order from this side.
check FAIL 'fork head is refused even in a Claude cloud session' \
  'echo true' 'CLAUDE_CODE_REMOTE=1'
# A successful call that yields no usable value means the field was not read.
# Treating that as same-repo would fail open on exactly what this gate catches.
check PENDING 'empty fork status is not treated as same-repo' \
  'echo ""'
check PENDING 'unexpected fork status is not treated as same-repo' \
  'echo null'
# Same-repo falls through to pr:ready-state. Assert on the reason, not just the
# verdict: both outcomes are FAIL, so a prefix check alone would pass even if
# the gate had refused it as a fork.
refute() {
  local label=$1 stub=$2 root out bin
  root="$(make_root)"
  bin="$(mktemp -d)"
  printf '#!/usr/bin/env bash\n%s\n' "$stub" >"$bin/gh"
  chmod +x "$bin/gh"
  # Emit a well-formed probe result rather than failing: a failing stub would
  # drive the gate's retry-once path through its real `sleep 5` for no added
  # coverage. What this case proves is that the probe was reached at all.
  cat >"$bin/pnpm" <<'STUB'
#!/usr/bin/env bash
printf '%s' '{"ready":false,"summary":"stub probe reached"}'
STUB
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
  if [[ "$out" != *"fork head"* && "$out" == *"stub probe reached"* ]]; then
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
