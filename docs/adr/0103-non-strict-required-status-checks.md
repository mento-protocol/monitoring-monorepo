---
title: Non-strict required status checks for main
status: active
owner: eng
canonical: true
last_verified: 2026-09-15
scope: ci/process
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0103 — Non-strict required status checks for main

**Status:** Accepted (Sep 2026), in force.
**Scope:** ci/process

## Context

`main`'s branch ruleset (id 13494367) set
`strict_required_status_checks_policy: true`. GitHub's strict mode requires a
PR's required checks to have last run against the current tip of `main`
before it can merge, so `mergeStateStatus: BEHIND` blocked merge even when
the PR had no textual conflict and its own head's checks were green. The
merge-readiness oracle (`scripts/pr/pr-ready-state-core.mjs`) mirrored that:
BEHIND was a required blocker regardless of mergeability.

`main` merges frequently in this repository. Measured over 2026-09-14/15, six
merges each forced at least one re-integration round on other open PRs —
about fourteen rounds total — purely to clear BEHIND, not to resolve an
actual conflict. The ruleset's `bypass_actors` grants `OrganizationAdmin`
`bypass_mode: always`; twice during that window an operator used that bypass
to merge a BEHIND PR directly, and both bypasses broke `main`, because the
bypass skips required checks entirely rather than re-running them against
the new tip. The strict policy was costing re-integration churn on the
common path while providing no protection on the path an operator actually
used to route around it.

## Decision

Turn off `strict_required_status_checks_policy` on `main`'s ruleset. The
operator applies that ruleset change directly in GitHub; it is not part of
this decision's implementation.

A PR may merge once its own head's required checks are green and it has no
textual conflict with `main`. Being merely behind `main` no longer blocks.
`mergeable: CONFLICTING` and `mergeStateStatus: DIRTY` still block, unchanged.

The oracle (`pr-ready-state-core.mjs`, `pr-ready-state-closeout.mjs`, and
`pr-stack-ready-state.mjs`) mirrors this, but fails closed rather than
assuming the ruleset change has landed: it reads
`strict_required_status_checks_policy` straight off the branch protection or
ruleset response it already fetches for required checks — aggregating every
applicable `required_status_checks` rule, since a base can carry more than
one, with any confirmed `true` winning — and only demotes BEHIND from
`required.blockers[]` to a non-blocking `notes[]` entry once that value is
confirmed `false`. Unknown or confirmed `true` keeps BEHIND blocking, so the
probe cannot report a PR ready before the operator's ruleset change actually
takes effect, and the CodeRabbit closeout gate keeps sending a still-blocked
BEHIND PR to `merge_base_first` too, so babysitting does not spend a review
request on a head it will still have to rewrite. A real conflict always
stays a required blocker.

Backstops replace the per-PR freshness check: the push-triggered `ci` run on
`main` and the Slack main-failure notifier
(`.github/workflows/notify-slack-on-main-failure.yml`) catch what a stale
merge introduces. Rule of thumb: when `main` is red, nobody merges until it
is green again.

## Alternatives considered

- **Keep strict mode.** Rejected. Its cost (about fourteen forced
  re-integration rounds across six merges in one day) fell on every ordinary
  PR, while the `OrganizationAdmin` bypass let an operator route around it
  entirely when it was inconvenient, and did so unsafely twice. A control
  that is this expensive to keep and this easy to defeat is not a control.
- **A GitHub merge queue.** Deferred, not rejected outright. `merge_group`
  refs cannot carry Vercel's required checks (Vercel does not report on that
  ref shape), and this repo's CI contract
  (`scripts/workflows/check-ci-contract.mjs`) pins trigger shapes that a
  queue would need to renegotiate. Revisit if Vercel adds `merge_group`
  support.

## Consequences

- A PR merges on its own green checks plus no textual conflict; it does not
  wait on `main` moving further while it is otherwise clear.
- A semantic conflict — two merged PRs that are each individually fine but
  break together — is caught by `main`'s own post-merge `ci` run and the
  Slack notifier, not before merge. Fixing that after the fact costs a
  revert or a follow-up PR, not a blocked merge.
- Re-integrating the base is still required when a PR is actually
  CONFLICTING/DIRTY, or when the operator asks for it; it is no longer
  required merely for being BEHIND.
- The `OrganizationAdmin` `always` bypass is unchanged by this decision; nothing
  here narrows or widens it.

## Evidence

- `docs/notes/pr-ready-state.md` and `docs/notes/stacked-pull-requests.md`
  document the current oracle behavior.
- `scripts/pr/pr-ready-state-core.mjs`, `scripts/pr/pr-ready-state.mjs`,
  `scripts/pr/pr-ready-state-closeout.mjs`,
  `scripts/pr/pr-ready-state.test.mjs`, `scripts/pr/pr-stack-ready-state.mjs`,
  and `scripts/pr/pr-stack-ready-state.test.mjs` implement and test the
  change, including the fail-closed live strict-policy read.
- `gh api repos/mento-protocol/monitoring-monorepo/rulesets/13494367` shows
  the current `bypass_actors` and (until the operator flips it)
  `strict_required_status_checks_policy: true`.
