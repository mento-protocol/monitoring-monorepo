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
  local owner=$2
  local repo=$3
  local repo_root=$4

  # Fork-head PRs are a hard stop, checked before EVERY other exit in this
  # function — including the checkout and script-availability guards below,
  # which return PASS. A fork PR in a checkout without package.json would
  # otherwise satisfy the gate on exactly the case this refuses: that guard returns early in a Claude cloud
  # session, and a fork head must refuse on every surface rather than depend on
  # which one is running. `pr:ready-state`, `pr:feedback-state`, and the
  # autoreview bundle sequence all assume the head commit is reachable through a
  # trusted `origin` serving the base repo
  # (docs/notes/agent-quality-gate-mechanics.md); a fork head breaks that, so
  # the gate refuses rather than reporting a readiness it cannot prove. This
  # lives in the hook, not a skill file, because the hook runs whichever babysit
  # skill won the name collision (docs/notes/codex-agent-skills.md). The MCP
  # path carries the same stop in docs/notes/github-tooling-surfaces.md.
  local cross
  if ! cross=$(gh pr view "$pr" --repo "${owner}/${repo}" --json isCrossRepository \
    --jq '.isCrossRepository' 2>/dev/null); then
    # Running ahead of the cloud capability guard means this is also the first
    # thing to fail in a blocked Claude cloud session. Name that cause and the
    # MCP fallback, or the guard's more useful message never gets reached and
    # the session is told only that a field was unreadable.
    if [[ -n "${CLAUDE_CODE_REMOTE:-}" ]]; then
      printf 'PENDING fork status unreadable for #%s in this Claude cloud session (gh is not reliably capable here — GraphQL and/or the repo API are unreachable this session); establish isCrossRepository over MCP and follow the cloud watch loop in docs/notes/github-tooling-surfaces.md' "$pr"
      return 0
    fi
    printf 'PENDING fork status unreadable for #%s; cannot prove the head is same-repo' "$pr"
    return 0
  fi
  if [[ "$cross" == "true" ]]; then
    printf 'FAIL #%s has a fork head; repo gates cannot prove trust roots for fork-controlled source (docs/notes/agent-quality-gate-mechanics.md)' "$pr"
    return 0
  fi
  # Continue only on an explicit "false". A null, empty, or unexpected value
  # means the field was not read, not that the head is same-repo, and treating
  # it as same-repo would fail open on the exact case this gate exists to catch.
  if [[ "$cross" != "false" ]]; then
    printf 'PENDING fork status for #%s read back as %s; cannot prove the head is same-repo' "$pr" "${cross:-empty}"
    return 0
  fi

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

  # In Claude cloud sessions the platform's GitHub credential proxy blocks
  # GraphQL regardless of tokens, and the gh binary is not reliably available
  # either, so pr:ready-state cannot run there (rides on GraphQL either way —
  # see docs/notes/github-tooling-surfaces.md). REST /repos/* behavior varies
  # by session rather than being a fixed block. Only repo-scoped calls prove
  # capability — `gh auth status` passes in those sessions regardless. The
  # probe needs REST /repos/*, GraphQL (`gh pr view` and the reviewThreads
  # query), and `gh api --slurp` (missing from the default Ubuntu gh 2.45 a
  # variant may ship), so gate on all three. Without this guard the probe
  # failure below would read as FAIL and poison every cloud babysit run.
  if [[ -n "${CLAUDE_CODE_REMOTE:-}" ]] &&
    { ! gh api --help 2>/dev/null | grep -q -- '--slurp' ||
      ! gh api "repos/${owner}/${repo}" --jq .full_name >/dev/null 2>&1 ||
      ! gh api graphql -f query='query{viewer{login}}' >/dev/null 2>&1; }; then
    printf 'PENDING pr:ready-state unavailable in this Claude cloud session (gh is not reliably capable — GraphQL and/or the repo API are unreachable this session); use the MCP emulation in docs/notes/github-tooling-surfaces.md — probe-verified all-clear needs a gh-capable surface'
    return 0
  fi

  # `pnpm <script>` prints a "> pkg@ <script> <path>" banner to STDOUT before
  # the script's own output. Piping that into jq makes it choke on the
  # non-JSON preamble ("Invalid numeric literal"), and the `|| ready="false"`
  # fallbacks below then silently report PENDING forever even when the PR is
  # green + approved. `--silent` suppresses the banner so `--json` is clean,
  # parseable output; capturing stderr to /dev/null keeps any script warning
  # from corrupting the JSON too. `--repo` is required: a cloud checkout's
  # origin is the credential-proxy URL, which gh cannot map to a repository,
  # so an implicit-repo invocation fails even after the capability gate passes.
  # Retry once before declaring FAIL. The probe intermittently hits transient
  # gh auth/network errors that succeed on an immediate retry, and a
  # single-attempt FAIL turns those into false REPO_GATE_FAIL alarms — six of
  # them across three PRs on 2026-08-20, every one reproducing clean by hand
  # seconds later. A vendored copy of this hook in the babysit-pr skill's
  # `hooks/` dir used to shadow-compete with this file; it was removed once the
  # skill's path-convention discovery ($REPO_ROOT/.claude/babysit-pr.sh) made it
  # redundant, so this file is now the only copy to keep in step.
  local output
  output=$(cd "$repo_root" && pnpm --silent pr:ready-state --pr "$pr" --repo "${owner}/${repo}" --json 2>/dev/null) || {
    sleep 5
    output=$(cd "$repo_root" && pnpm --silent pr:ready-state --pr "$pr" --repo "${owner}/${repo}" --json 2>/dev/null) || {
      printf 'FAIL pr:ready-state errored twice (repro: pnpm pr:ready-state --pr %s --repo %s/%s --json)' "$pr" "$owner" "$repo"
      return 0
    }
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
