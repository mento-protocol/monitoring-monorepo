---
title: The v1 review-skill evaluation has no scheduled freshness alarm
status: active
owner: eng
canonical: true
last_verified: 2026-11-04
scope: ci/process
date: 2026-11
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0112 — The v1 review-skill evaluation has no scheduled freshness alarm

## Status

Accepted. Narrows [ADR 0110](0110-paired-review-evaluation-v2.md): v1 stays in
the repository during migration, but its weekly freshness workflow is removed.

## Context

The v1 evaluation runs on an operator machine, and a weekly workflow turned red
once its ledger aged past 60 days. The last ledger row is from 2026-09-14. New
review experiments use v2, which has no freshness clock. So from 2026-10-27 the
workflow turned red every Tuesday and posted to #ci-failures. Its staleness
issue (#2594) stayed open for three weeks without a comment. An alarm that
nobody acts on teaches people to ignore that channel.

The workflow's contract job ran the same three commands as the required
`scripts` job in `ci.yml`. That job runs on every pull request that touches the
frozen inputs.

## Decision

Delete `.github/workflows/review-eval-freshness.yml` and the
issue-publication wrapper only it used. Keep the v1 harness, ledger, frozen
contract and the required CI checks over them unchanged. Staleness is
pull-based now: `pnpm review:eval -- --schedule-issue --dry-run` prints the
plan locally. The hash-covered freshness guard stays unchanged and refuses
live issue creation, because the workflow it authorized no longer exists.

## Alternatives considered

- Keep the workflow: rejected, because two red runs and an untouched issue
  showed that its signal had no consumer.
- Raise the thresholds: rejected, because that only delays the same unowned
  alarm.
- Retire v1 entirely: out of scope. It changes the ledger contract and needs
  the evaluation owner's decision.

## Consequences

The v1 ledger can age without anyone being told. That is accepted while v2 is
the active path. Resuming recurring v1 runs means restoring the workflow from
git history, together with an owner who acts on its issue.

## Evidence

- [Run 2026-10-27](https://github.com/mento-protocol/monitoring-monorepo/actions/runs/40531003093)
  and [run 2026-11-03](https://github.com/mento-protocol/monitoring-monorepo/actions/runs/41681628842)
- [Issue #2594](https://github.com/mento-protocol/monitoring-monorepo/issues/2594)
