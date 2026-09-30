---
title: Paired review evaluation v2 separates execution from grading
status: active
owner: eng
canonical: true
last_verified: 2026-09-30
scope: ci/process
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0110 — Paired review evaluation v2

## Status

Accepted for the opt-in diagnostic path. Narrows
[ADR 0083](0083-non-ledger-review-eval-experiments.md) to allow the v2 direct-review
comparison described here. Existing v1 lanes and ledger rules remain in force.

## Context

The existing evaluation preserves execution identity carefully, but its answer
key contains duplicate roots and some later-head findings. Session-tail scoring
can count a withdrawn suspicion. Its raw cache identity also binds grading
inputs, so a grader change can require another reviewer execution.

## Decision

Add a small paired direct-review evaluation with a separately versioned dataset
and scorer. Compare explicit skill snapshots on the same frozen cases. Require
one complete final review and retain full execution traces for diagnosis.

Separate reviewer execution identity from grading identity. Bind source,
repair, skill, prompt, runtime, and invocation behavior to the former. Bind
immutable reviewer evidence, answer key, grader configuration, and scorer bytes
to the latter. Reuse each phase only when its own inputs match.
Keep answer-key selection separate from execution code. Pin grading source and
prompts for the process lifetime, and reject source drift before saving results.

Use root-cause labels and repaired-root negative controls. A repaired case is
not a claim that its whole PR has no defects. Keep original and repaired cases
in one PR family and split. Record prior exposure and label authority explicitly.
Agent audits and model judgments do not become human calibration.

A dataset digest establishes identity, not permission to execute its source.
Restrict executable probes to reviewed source and repair tuples. Verify and copy
their complete local module closure by hash before importing the copies in a
private directory with an empty environment. New families require reviewed
trust pins. Model confinement alone does not protect the host probe process.

Separate execution completion from comparative conclusions. Incomplete calls
cannot become zero findings. Valid uncertainty remains visible. An A/A run can
qualify the instrument but cannot establish a skill improvement. V2 cannot
promote a skill, append a v1 ledger row, or refresh its schedule.

## Alternatives considered

- Change v1 scoring in place: rejected because historical scores would change
  meaning and broad cache invalidation would buy unnecessary reviewer calls.
- Add a dashboard and automatic benchmark service: rejected because a small
  operator-run panel resolves the current execution and scoring defects.
- Require the final message of any old transcript: rejected because old callers
  permitted addenda after a report. Final-review compatibility needs evidence.

## Consequences

The repository retains v1 during explicit migration. The v2 path has no scheduler,
publication automation, live finder, or automatic promotion. Its pilot proves
operation on a narrow, previously exposed panel. Independent calibration and
unseen PRs are necessary before broader quality claims.

## Evidence

- [Implementation issue #2555](https://github.com/mento-protocol/monitoring-monorepo/issues/2555)
- [V2 runbook](../evals/review-skill-v2.md)
- [V1 answer-key limits](../evals/review-skill.md#the-exam-and-the-answer-key)
