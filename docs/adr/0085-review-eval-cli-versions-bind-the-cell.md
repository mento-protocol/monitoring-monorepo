---
title: Provider CLI versions bind the review-eval cell, not the plan
status: active
owner: eng
canonical: true
last_verified: 2026-09-03
scope: ci/process
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0085 — Provider CLI versions bind the review-eval cell, not the plan

**Status:** Accepted (Sep 2026), in force. Supersedes ADR 0083 on one point:
where provider CLI versions are bound.
**Scope:** ci/process

## Context

ADR 0083 made the campaign plan bind the provider CLI versions. The plan check
required byte equality against a live probe, so any provider release
invalidated every stored plan of every running campaign.

The Claude Code upgrade from 2.1.258 to 2.1.259 on 2026-09-02 did that
mid-campaign. It stranded six paid holdout cells between a screen and its
holdout: the plan no longer validated, and the cells could not be scored.

Cache identity carried the plan digest but not the runtime. An artifact
produced under one CLI version was still reusable under another, so a single
stage could mix runtimes without saying so.

## Decision

The plan records the provider CLI versions it was planned under. It does not
bind them, and a rebuild uses the recorded versions. A stored plan therefore
stays valid across a provider upgrade.

Every cache identity instead carries the live version of the provider its own
phase invokes: the contestant CLI for a raw cell, the finder CLI as well on a
`live-paired` lane, and the judge CLI for a score or novelty cell that calls the
judge. This matches the canonical cell fingerprint in
`scripts/review/review-eval-run-cell.mjs`. A phase that reaches its answer
without a provider records the empty set — an empty reviewer transcript is
scored with no judge call, and a cell with no claim is classified with none — so
no artifact names a provider its phase never ran. A cache entry whose phase
invokes a changed provider is never found, that cell reruns, and no phase mixes
runtimes; a completed stage result and an entry independent of the changed
provider stay reusable.

Each artifact stores the versions it ran under, and each record reads those
bytes. A later phase rebuilds an earlier artifact's identity from the record's
stored versions, so a judge upgraded between a screen and its holdout still
loads the screen scores. A stage retried after a failure reports the runtime
that produced each artifact, not the runtime of the retry.

`--validate-plan` reports a live difference as `cli_version_drift`, a warning
rather than a problem. `--run` writes one warning line to stderr. The stage
decision names every transition with the cells it touched, screen cells
included once a holdout decision folds them in.

## Alternatives considered

- **Keep the binding in the plan and re-plan after every upgrade.** Rejected. A
  new plan digest changes every cache identity, so the campaign loses every
  cached cell. That is the failure mode observed on 2026-09-02.
- **Bind the planned version into cell identity and infer provenance from
  cache-reuse flags.** Rejected in review. A retried stage relabels artifacts it
  did not produce, and drift is attributed to providers whose phase never ran.

## Consequences

- An upgrade mid-campaign reruns the cells produced after it under the new CLI.
  Their cost is the price of not mixing runtimes.
- A pair that straddles an upgrade is labelled, never refused. The operator
  reads the label and decides whether the comparison stands.
- A provider that auto-updates mid-stage still leaves the cells that ran after
  the update keyed on the versions probed at stage start — probed by `--run`
  when the stage starts, not when the campaign loaded, so a release between the
  two cannot key a cell on a version no cell ran under. `--run` re-probes after
  the arms and after novelty, reading only the providers that stage can invoke,
  and names any change in the decision and the stage payload as
  `runtime_change_during_stage`, keyed by the stage that saw it and never
  attributed to individual cells. A holdout decision folds in the screen
  records, so it carries the screen's change beside its own.
- Stored plans survive provider releases, so a paused campaign resumes.
- ADR 0083 stays active. Only its plan-binding clause is superseded.

## Evidence

- `phaseCliVersions`, `recordRuntimeDrift`, and `stageProbeProviders` in
  `scripts/review/review-eval-experiment-versions.mjs` enforce this decision.
- `scripts/review/review-eval-experiment-contract.test.mjs` and
  `scripts/review/review-eval-experiment-runtime.test.mjs` cover the retry,
  provider-attribution, novelty, and combined-stage cases.
- The runbook passage in `docs/evals/review-skill.md`.
- Issue #2255.
