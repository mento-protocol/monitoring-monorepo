---
title: Adopt native stacked pull requests through an opt-in pilot
status: active
owner: eng
canonical: true
last_verified: 2026-09-09
scope: ci/process
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0091 — Adopt native stacked pull requests through an opt-in pilot

**Status:** Accepted (Sep 2026), rollout tooling in force; live pilot outstanding.
**Scope:** ci/process

## Context

Dependent PRs already occur in this repository. PR #2292 depends on the fixture
work in #2291. PR #1967 records a manual rebase after its parent squash-merged.
These changes benefit from distinct review scopes, but parent transitions need
extra work. GitHub's native stacked PR public preview exposes that relationship
and applies protections from the stack target to each layer.

The existing readiness probe reads protections from the immediate PR base.
That is correct for ordinary dependent PRs but can select the wrong branch for
a native upper layer. Native merges can also include multiple unmerged PRs and
rewrite a remaining child's history. Those semantics require explicit handling
before routine adoption.

## Decision

Make native stacks opt-in for small, linear, same-repository dependencies.
Keep independent PRs as the default. Add native metadata discovery to readiness,
separate the diff base from the protection base, and report layer readiness
without implying that other layers passed.

Use the existing ship and babysit skills. Their canonical operating card routes
to the [stacked PR workflow](../notes/stacked-pull-requests.md). Ship publishes
and validates each PR before linking explicit PR numbers. Babysit discovers
members and rechecks dependent heads when a parent changes. Neither skill gains
automatic force-push or stack-sync authority. No workflow branch-filter
expansion is part of this rollout.

Keep ADR 0084's specific-PR approval, squash, and head-binding rules. For native
stacks, an approved agent merge selects only the bottommost unmerged layer and
uses GitHub's asynchronous merge endpoint with the selected head SHA. Verify
the terminal operation and PR merge record before reporting completion. The
endpoint's selected-head SHA does not establish a binding for every layer of a
group merge. No new unattended merge lane is introduced.

Pilot the next authorized low-risk helper-and-consumer feature. Do not create
synthetic pilot PRs. Keep the rollout issue open for actual CI, review,
worktree, and parent-merge evidence. Broader adoption depends on reviewing
that evidence; publishing the tooling alone does not complete the pilot.

## Alternatives considered

- **Keep only ordinary dependent PRs.** Supported as a fallback. They lack
  native dependency visibility and do not exercise native protection semantics.
- **Create all layers from commits with a new stack skill.** Rejected for this
  rollout. Explicit existing PR numbers preserve our publication and review
  boundaries without a second orchestration workflow.
- **Automatically sync and merge whole stacks.** Rejected. Sync can force-push,
  and a selected-head check does not bind every unmerged layer's head.

## Consequences

Each layer retains its own author checks, reviews, feedback, and merge consent.
An extra metadata lookup can block readiness when stack membership is
unavailable. That failure is preferable to using the wrong protections.
GitHub's automatic child rewrite invalidates old head-bound evidence, even
when the displayed code appears unchanged. Native stacks can therefore still
require repeated checks and local reconciliation.

The pilot must record review turnaround, repeated checks, manual interventions,
and agent mistakes. A comparison with a similar ordinary dependency has limits;
no time saving is assumed before observation.

## Evidence

- [Rollout issue #2286](https://github.com/mento-protocol/monitoring-monorepo/issues/2286).
- [PR #2292](https://github.com/mento-protocol/monitoring-monorepo/pull/2292)
  and [PR #1967](https://github.com/mento-protocol/monitoring-monorepo/pull/1967).
- [GitHub public preview announcement](https://github.blog/changelog/2026-07-30-stacked-pull-requests-are-now-in-public-preview/).
- [GitHub stack API reference](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests-apis-and-webhooks).
- [GitHub merge behavior](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-stacked-pull-requests).
- [Readiness contract](../notes/pr-ready-state.md) and
  [operating card](../notes/pr-operating-card.md).
