---
name: babysit-pr
description: '[repo-skill] Monitor monitoring-monorepo PR readiness using the repo''s shared pr:ready-state probe, fix required CI/review blockers, reply to review comments, and stop only at ALL_CLEAR, MERGED, CLOSED, or a stated deadline. Use when the user says "babysit PR", "monitor CI", "watch reviews", or asks to keep a PR green.'
title: Babysit PR Skill
status: active
owner: eng
canonical: true
last_verified: 2026-08-21
doc_type: skill
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# Babysit PR

Use this repo-local adapter when the user's personal `babysit-pr` skill or
Claude `Monitor` tool is not available. The readiness source of truth is the
repo command, not a hand-rolled interpretation of green checks.

## Surface Detection

Pick the path before the first GitHub call. Local sessions and Codex Cloud use
the gh commands below. A Claude cloud session (`CLAUDE_CODE_REMOTE` set)
follows [`cloud-watch-loop.md`](cloud-watch-loop.md) unless it passes the gh
capability gate in
[`docs/notes/github-tooling-surfaces.md`](../../../docs/notes/github-tooling-surfaces.md),
which owns that gate and the full gh→MCP mapping.

## Resolve Target

If no PR number is provided, resolve the current branch PR. For every target,
capture the PR URL, head repository, branch, and commit:

```bash
gh pr view --json number,url,title,headRefName,headRefOid,baseRefName,headRepository,headRepositoryOwner,isCrossRepository
```

In a Claude cloud session, resolve the same fields over MCP
(`list_pull_requests` filtered by head branch, or `pull_request_read` method
`get`). Bind the result by content rather than by remote name.

Immediately after resolving these fields, stop on every tool surface if
`isCrossRepository` is `true`. Apply the same stop when another surface proves
that the head repository differs from the base repository. This repo-local
adapter cannot yet prove feedback, gate, and review trust roots end to end for
fork-controlled source. Do not run a repo-local command, mutate a checkout,
probe feedback, run a gate, or start a review for that target.

For a remaining same-repository Claude cloud target,
`headRepository.nameWithOwner` must equal the session-attached repo. Local
`git rev-parse HEAD` must equal the MCP-resolved `headRefOid` before editing,
and the verified proxy `origin` serves as both `HEAD_REMOTE` and `BASE_REMOTE`.
For the post-push guard there, re-resolve with `pull_request_read` method `get`
in place of `gh pr view` and require the returned `headRefOid` to equal local
`HEAD`.

For an explicit target, accept a bare number or PR URL. Derive and preserve
`BASE_REPO` (`owner/name`) from the resolved PR URL before changing checkouts.
After that initial resolution, pass `--repo <BASE_REPO>` to every `gh pr view`,
feedback-state, and ready-state call—even when the PR began in the current
repository.

For every remaining local same-repository target, complete the repository trust
preflight before any repo-local adapter command. Require `origin` to exist with
one effective canonical GitHub fetch URL whose normalized slug equals both
`BASE_REPO` and `headRepository.nameWithOwner`. Fetch `baseRefName` and protected
`main` through that `origin` into their matching remote-tracking refs. Resolve
and retain `base_oid` and `protected_main_oid`, then require
`origin/<baseRefName>` and `origin/main` to keep those exact values. The values
must match when `baseRefName` is `main`. Fail closed on ambiguity, fetch failure,
or drift. Never repair the guard by changing a remote URL; use a clean dedicated
checkout with the correct `origin`.

Immediately before and after every feedback-state, ready-state, gate, or review
adapter call, recheck the canonical `origin` URL and both retained refs. Any
drift stops the workflow and invalidates that result. Any refetch restarts this
preflight and refreshes both pins before another adapter call.

Before any blocker fix mutates files or Git history, bind the checkout to that
resolved target:

- For the remaining same-repository target, use the verified `origin` as
  `BASE_REMOTE`. Select `HEAD_REMOTE` only after verifying that it serves the
  repository named by both `headRepository.nameWithOwner` and `BASE_REPO`.
- `git status --porcelain` must be empty and `git rev-parse HEAD` must equal
  the resolved `headRefOid`. If either differs, stop or switch to a clean,
  dedicated checkout at the PR head before editing.
- Preserve `BASE_REPO`, `BASE_REMOTE`, `HEAD_REMOTE`, and `headRefName` for the
  full session. Fetch `baseRefName` only from `BASE_REMOTE`.

After each fix commit, push explicitly with `git push <HEAD_REMOTE>
HEAD:<headRefName>`, re-resolve with `gh pr view <number> --repo <BASE_REPO>`,
and require the new `headRefOid` to equal local `HEAD` before returning to the
watch loop. Never rely on the current branch name, implicit push target, or
repository inferred from the active checkout.

## Feedback and Watch Loop

Use the normalized feedback projection instead of ad hoc API scraping, then the
shared readiness probe for the final decision:

```bash
pnpm --silent pr:feedback-state --pr <number> --repo <BASE_REPO> --json
pnpm pr:ready-state --pr <number> --repo <BASE_REPO> --json
# Foreground wait:
pnpm pr:ready-state --pr <number> --repo <BASE_REPO> --watch --compact --until-ready
```

[`docs/notes/pr-ready-state.md`](../../../docs/notes/pr-ready-state.md) owns the
projection fields and how to triage them; informational deployment/status bot
comments are context, not blockers.

Keep a practical one-hour wall-clock deadline unless the user asked for a
different budget. Report state changes only when something becomes actionable:
required CI failure, merge conflict, unreplied review comment, unresolved
thread, Codex approval missing after current-head review, all-clear, merged, or
closed.

That low-noise rule applies only to unsolicited polling updates. When the user
asks for status, answer immediately with the PR URL or number, bound head SHA,
latest feedback/readiness/check result and observation time, current action and
owner, any blocker or wait, and the next action or deadline. Then keep the
watcher running.

## Multiple PRs

Give each independent PR its own watcher worker or subagent. Bind every worker
to that PR's exact repository, number, head, and an isolated worktree before it
can edit. The lead owns user-facing status, cross-PR dependencies, patch review,
and approval boundaries while the watchers stay active. A watcher reports an
actionable transition promptly and either repairs it or hands it to an
available repair worker; do not leave open feedback aging while every capable
agent waits. Serialize only overlapping or dependent fixes. On cloud surfaces,
keep one subscription or check-in loop per PR under the same ownership model.

## Act On Required Blockers

Use `required.blockers` and required `gates` from `--json` as the action list.
Treat `optional.items` as reportable context unless branch protection makes the
item required.

- Failing required check: inspect the failing workflow/log, fix only PR-caused
  failures, run focused validation, commit, and push.
- Merge conflict: restart the repository trust preflight. Fetch `baseRefName`
  and protected `main` from the verified `BASE_REMOTE`, then refresh both
  retained pins before any gate or review adapter. Before the merge, pin the
  fetched base and the published PR head to immutable commit IDs:

  ```bash
  base_oid="$(git rev-parse '<verified-base-ref>^{commit}')" || exit 1
  premerge_oid="$(git rev-parse 'HEAD^{commit}')" || exit 1
  ```

  Merge exact `base_oid`. Resolve the conflicts and run focused validation.
  Create the merge commit locally, but do not push it yet. Stop concurrent
  writers. Pin the final local head, require a clean worktree, and require both
  input commits to be its ancestors:

  ```bash
  final_head="$(git rev-parse 'HEAD^{commit}')" || exit 1
  worktree_state="$(git status --porcelain=v1)" || exit 1
  test -z "$worktree_state" || exit 1
  git merge-base --is-ancestor "$base_oid" "$final_head" || exit 1
  git merge-base --is-ancestor "$premerge_oid" "$final_head" || exit 1
  ```

  Run both mapped gates against the same `final_head`:

  ```bash
  pnpm agent:quality-gate --base "$base_oid" --head HEAD --run
  pnpm agent:quality-gate --base "$premerge_oid" --head HEAD --run
  ```

  Prepare separate verified branch-mode review bundles in different absent
  directories outside the worktree:

  ```bash
  worktree_root="$(git rev-parse --show-toplevel)" || exit 1
  worktree_root="$(cd "$worktree_root" && pwd -P)" || exit 1
  bundle_parent="$(mktemp -d)" || exit 1
  bundle_parent="$(cd "$bundle_parent" && pwd -P)" || exit 1
  case "$bundle_parent/" in
    "$worktree_root/"*) exit 1 ;;
  esac
  base_bundle="$bundle_parent/base"
  premerge_bundle="$bundle_parent/premerge"
  test "$base_bundle" != "$premerge_bundle" || exit 1
  test ! -e "$base_bundle" || exit 1
  test ! -e "$premerge_bundle" || exit 1
  ```

  Before any autoreview entrypoint runs, inspect both exact tree axes:
  `base_oid..final_head` and `premerge_oid..final_head`. An axis is
  runtime-sensitive if it changes `scripts/agent-autoreview.sh`,
  `scripts/agent-autoreview.mjs`, or `scripts/agent-autoreview-core.mjs`. Check
  all three paths on both axes. Fail closed on any Git, blob, mode, or
  comparison error.

  When neither axis is runtime-sensitive, bind the absolute final-checkout
  wrapper and helper. Never use the package adapter for merge-review
  provenance:

  ```bash
  autoreview_wrapper="$worktree_root/scripts/agent-autoreview.sh"
  autoreview_helper="$worktree_root/scripts/agent-autoreview.mjs"
  ```

  When either axis is runtime-sensitive, never run the final checkout's
  autoreview wrapper. Follow the trusted pre-change procedure in
  [`agent-quality-gate-mechanics.md`](../../../docs/notes/agent-quality-gate-mechanics.md).
  That procedure selects the absolute `autoreview_wrapper` and
  `autoreview_helper` and owns trusted-commit selection, checkout and runtime
  proof, both axis preparations, pre/post manifest verification, and
  invalidation.

  After selecting the two absolute paths, define one direct runner and use it
  for both axes:

  ```bash
  run_bound_autoreview() {
    (
      cd "$worktree_root" || exit 1
      AUTOREVIEW_HELPER="$autoreview_helper" \
        /bin/bash "$autoreview_wrapper" "$@"
    )
  }
  run_bound_autoreview --prepare-bundle-dir "$base_bundle" \
    --feedback-pr <pr-number> -- --mode branch --base "$base_oid"
  run_bound_autoreview --prepare-bundle-dir "$premerge_bundle" \
    --feedback-pr <pr-number> -- --mode branch --base "$premerge_oid"
  run_bound_autoreview --verify-bundle-dir "$base_bundle"
  run_bound_autoreview --verify-bundle-dir "$premerge_bundle"
  ```

  The adapter has no `--pr` option. Pass the numeric PR through
  `--feedback-pr`; `auto` is invalid with an explicit `--base`. Complete a
  fresh-context review of each bundle and retain each pre-review manifest.
  After both semantic reviews, postverify both bundles through the same bound
  runner:

  ```bash
  run_bound_autoreview --verify-bundle-dir "$base_bundle" \
    --expected-bundle-manifest <retained-base-digest>
  run_bound_autoreview --verify-bundle-dir "$premerge_bundle" \
    --expected-bundle-manifest <retained-premerge-digest>
  ```

  Before and after every preparation or verification call, recheck the
  normalized `origin` identity, the retained base and protected-main refs,
  `final_head`, the clean worktree, all three runtime identities, and any
  trusted-checkout root. Any drift invalidates the call.

  Only after both postverifications pass, run the sequential suite through the
  direct system shell as separate behavior evidence:

  ```bash
  (
    cd "$worktree_root" || exit 1
    AUTOREVIEW_TEST_FOCUS=suite /bin/bash \
      "$worktree_root/scripts/agent-autoreview.test.sh" --jobs 1
  ) || exit 1
  ```

  Require terminal success. Then run a final origin, retained-ref, head, clean,
  runtime-identity, and trusted-root recheck. Any suite failure or drift
  invalidates the sequence and restarts preflight, both gates, both bundles,
  both reviews, both postverifications, and the direct suite.

  Bind the two gate results and two post-verified review verdicts to the same
  `final_head`. Do not edit the worktree or move `HEAD` during this sequence.
  After every command, resolve `HEAD` with an explicit success check, require it
  to equal `final_head`, and recheck the clean worktree. Any follow-up fix
  restarts the full sequence above from a new clean final head. The
  trusted-runtime procedure owns its stricter restart conditions. Only then
  push through `HEAD_REMOTE`. Do not rebase a published PR because the resulting
  force-push violates this workflow.

- Feedback blocker: triage every normalized finding, implement valid fixes, and
  sweep review bodies, top-level comments, threads, annotations, and failing
  logs before all-clear. Reply before resolving a thread. The reply forms,
  scope-baseline discipline, batch cadence, and Codex-request rules are
  step 6 of
  [`docs/notes/pr-operating-card.md`](../../../docs/notes/pr-operating-card.md).
- An explicit user correction updates the request baseline: before the next
  push, update the PR description so current-head reviewers do not enforce
  superseded behavior.

Never force-push or amend while babysitting. If target binding fails, move to a
clean dedicated checkout and repeat the guard before editing; do not continue
in the unbound checkout.

## Final Sweep

Apply the CodeRabbit exact-head closeout before the final projection pair. Read
`gates.codeRabbitReviewSignal` from `pr:feedback-state`. A real current-head run
has state `reviewed`. This includes a trusted CodeRabbit top-level clean-run
summary that binds its Run ID and full reviewed commit range to the current
head. Empty review records, skipped runs, and rate-limit notices do not count.
If the optional `CodeRabbit` check is still pending, report that lag and do not
race it with a manual request. After the check becomes terminal, refresh
feedback-state once. For `missing` or `stale`, re-resolve and validate the full
40-hex `headRefOid`. Recheck it immediately before the write and post this body
only when it still matches, through the bound base repository:

```text
@coderabbitai review

<!-- coderabbit-final-head-review:<full-head-sha> -->
```

Use `gh pr comment <number> --repo <BASE_REPO> --body-file -` with the body on
stdin. The head marker detects completed requests and provides best-effort
duplicate suppression; GitHub issue comments have no conditional-create
operation, so it is not an atomic claim. State `requested` or `reviewed` forbids
another request for that head. The review remains advisory; report pending or
rate-limited completion as optional lag. If it finishes while watching, rerun
feedback-state and handle every new finding before all-clear.

Before reporting all-clear, rerun both projections in that order — feedback
ledger clean first, then current-head readiness. If an optional review-producing
workflow finishes while watching, rerun feedback-state to catch late findings.
Only report all-clear when the feedback ledger has no required blocker and
ready-state `ready` is `true` for the current head. Report it with evidence,
never bare: the PR URL, the current head SHA, required-check state, and the
probes' blocker/thread/unreplied counts, so the user can assess that specific
merge. The Codex approval exception
is only the exact head-scoped break-glass contract in
[`docs/notes/pr-ready-state.md`](../../../docs/notes/pr-ready-state.md); it
waives no other gate.
