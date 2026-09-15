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

Two enforced backstops replace the per-PR freshness check. First, the oracle
reads the base branch head's own status rollup in one GraphQL query and emits
a required `base-red` blocker when a required context there ended in
`failure`, `cancelled`, `timed_out` or `action_required`; a base it cannot
read blocks the same way. Pending, in-progress and skipped base checks are not
red. "Nobody merges while `main` is red" is therefore a blocker, not a rule of
thumb. Second, the push-triggered `ci` run on `main` and the Slack
main-failure notifier
(`.github/workflows/notify-slack-on-main-failure.yml`) still report what a
stale merge introduces after the fact, which is what turns the base red for
the blocker to catch.

The unattended Dependabot auto-merge lane
(`.github/workflows/dependabot-auto-merge.yml`) keeps current-base validation
in its writer rather than relying on the base ruleset. It merges with the
repository `GITHUB_TOKEN`, whose merge commit emits no push-triggered
workflows, so a stale merge on that lane would land with no post-merge `ci`
run at all. The writer merges only a `clean` `mergeable_state`. A `behind`
head exits without merging and without repairing the branch: `update-branch`
would write a merge commit authored by that token, and the writer's own commit
proof accepts only commits authored by `dependabot[bot]`, so the repair would
disqualify the pull request from the lane for good. Dependabot's own rebase
pushes under its identity, starts a fresh classifier run, and brings the pull
request back. Every other merge state fails closed.

That check is an observation, not a server-enforced precondition: the merge
endpoint's `sha` pins the pull request's head, not the base. Two writers on
different branches could each read `clean` and the second could merge a base
commit behind the first. The window is the sub-second gap between the final
read and the merge request, and the lane only ever bumps pinned GitHub-owned
action SHAs in workflow YAML. Closing it properly needs the merge queue this
ADR defers, so the residual race is accepted and recorded here rather than
papered over with repository-wide serialization of an unattended lane.

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
  revert or a follow-up PR, not a blocked merge. Every other open PR is then
  blocked by `base-red` until `main` is green, so one semantic conflict stops
  the queue instead of compounding.
- Re-integrating the base is still required when a PR is actually
  CONFLICTING/DIRTY, or when the operator asks for it; it is no longer
  required merely for being BEHIND.
- The `OrganizationAdmin` `always` bypass is unchanged by this decision; nothing
  here narrows or widens it.
- **Amends** [ADR 0101](0101-legacy-gate-retirement.md)'s rollback step 2: that
  legacy-gate-retirement rollback instructed the operator to keep ruleset
  13494367's strict current-base required checks. This decision turns that
  policy off, so the ADR 0101 rollback must restore the ruleset with strict
  still off, not re-enable it.

## Evidence

- `docs/notes/pr-ready-state.md` and `docs/notes/stacked-pull-requests.md`
  document the current oracle behavior.
- `scripts/pr/pr-ready-state-core.mjs`, `scripts/pr/pr-ready-state.mjs`,
  `scripts/pr/pr-ready-state-status-contexts.mjs`,
  `scripts/pr/pr-ready-state-closeout.mjs`,
  `scripts/pr/pr-ready-state.test.mjs`, `scripts/pr/pr-stack-ready-state.mjs`,
  and `scripts/pr/pr-stack-ready-state.test.mjs` implement and test the
  change, including the fail-closed live strict-policy read and the
  `base-red` blocker.
- `.github/workflows/dependabot-auto-merge.yml` carries the unattended lane's
  own current-base validation;
  `scripts/production-infra-identity-contract/workflow-inventory.mjs` pins its
  reviewed semantic hash and
  `scripts/production-infra-identity-contract/dependabot-auto-merge.test.mjs`
  proves a behind head exits without merging and without any write.
- Probed 2026-09-15:
  `repos/mento-protocol/monitoring-monorepo/branches/main/protection/required_status_checks`
  answers `Branch not protected (HTTP 404)` while
  `repos/mento-protocol/monitoring-monorepo/branches/main` answers
  `protected: true` with `protection.enabled: false`. A ruleset-only base sets
  `protected`, so only the 404 message plus `protection.enabled: false`
  establishes that classic protection is absent.
- `gh api repos/mento-protocol/monitoring-monorepo/rulesets/13494367` shows
  the current `bypass_actors` and (until the operator flips it)
  `strict_required_status_checks_policy: true`.
