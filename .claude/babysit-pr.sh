#!/usr/bin/env bash
# Repo babysit gate for mento-protocol/monitoring-monorepo.
#
# The babysit-pr skill auto-discovers this file at `$REPO_ROOT/.claude/babysit-pr.sh`
# (see babysit-prs.sh hook resolution) and sources it for BOTH local and cloud
# runs. It augments the generic ALL_CLEAR gate with the repo's own readiness
# probe (`pnpm pr:ready-state`) so babysit won't declare a PR clear until the
# repo's required CI + review gates are satisfied. Defining `babysit_repo_gate`
# here makes this the single source of truth; any copy vendored into a local
# skill `hooks/` dir is sourced first and harmlessly overridden by this one.
#
# Contract (from the babysit-pr skill):
#   babysit_repo_init <owner> <repo> <repo_root>
#   babysit_repo_gate <pr> <owner> <repo> <repo_root>  -> prints "PASS|PENDING|FAIL [msg]"

babysit_repo_init() {
  if [[ "${BABYSIT_REQUIRE_CODEX_EXPLICIT:-false}" != "true" ]]; then
    # Read by the babysit-prs.sh harness after it sources this hook; shellcheck
    # can't see across the source boundary, hence the disable.
    # shellcheck disable=SC2034
    BABYSIT_REQUIRE_CODEX=1
  fi
}

babysit_repo_gate() {
  local pr=$1
  local repo_root=$4

  if [[ ! -f "$repo_root/package.json" ]]; then
    printf 'PASS monitoring checkout not available'
    return 0
  fi

  # Resolve package.json / the pr:ready-state script from $repo_root, not the
  # caller's CWD — the harness may invoke this gate from a subdirectory, and
  # the file guard above already keys on the absolute "$repo_root/package.json".
  if ! (cd "$repo_root" && node -e 'const scripts=require("./package.json").scripts||{}; process.exit(scripts["pr:ready-state"] ? 0 : 1)') >/dev/null 2>&1; then
    printf 'PASS pr:ready-state script unavailable in this checkout'
    return 0
  fi

  # `pnpm <script>` prints a "> pkg@ <script> <path>" banner to STDOUT before
  # the script's own output. Piping that into jq makes it choke on the
  # non-JSON preamble ("Invalid numeric literal"), and the `|| ready="false"`
  # fallbacks below then silently report PENDING forever even when the PR is
  # green + approved. `--silent` suppresses the banner so `--json` is clean,
  # parseable output; capturing stderr to /dev/null keeps any script warning
  # from corrupting the JSON too.
  local output
  output=$(cd "$repo_root" && pnpm --silent pr:ready-state --pr "$pr" --json 2>/dev/null) || {
    printf 'FAIL pr:ready-state errored (repro: pnpm pr:ready-state --pr %s --json)' "$pr"
    return 0
  }

  # Explicit boolean test — do NOT use `.ready // …` fallbacks: jq's `//`
  # treats an explicit `false` as empty, so a genuine `ready:false` would fall
  # through to the next term. `pr:ready-state` always emits a top-level
  # boolean `.ready`, so test it directly.
  local ready summary
  ready=$(printf '%s' "$output" | jq -r 'if .ready == true then "true" else "false" end' 2>/dev/null) || ready="false"
  # `.summary` is the script's human one-liner (string), e.g.
  # "2 required blocker(s) remain." — surface it so a PENDING gate says WHY
  # instead of the opaque "pr:ready-state not ready".
  summary=$(printf '%s' "$output" | jq -r '
    .summary // .summaryText // .message // empty
  ' 2>/dev/null) || summary=""

  if [[ "$ready" == "true" ]]; then
    if [[ -n "$summary" ]]; then
      printf 'PASS %s' "$summary"
    else
      printf 'PASS pr:ready-state ready'
    fi
  else
    if [[ -n "$summary" ]]; then
      printf 'PENDING %s' "$summary"
    else
      printf 'PENDING pr:ready-state not ready'
    fi
  fi
}
