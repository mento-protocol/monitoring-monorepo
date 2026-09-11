---
title: Non-ledger finder probes
status: active
owner: eng
canonical: true
last_verified: 2026-09-10
scope: ci/process
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0096 — Non-ledger finder probes

**Status:** Accepted (Sep 2026), in force. Narrows
[ADR 0083](0083-non-ledger-review-eval-experiments.md) on one point.
**Scope:** ci/process

## Context

The review-skill eval binds one finder, `gpt-5.6-sol@high`, into its contract.
Asking whether another finder model or reasoning effort does better, with the
skill, verifier, judge and fixtures held equal, had two routes and neither
worked:

- A canonical full run on an edited contract costs 27 cells, of which the 18
  `replay` and `control` cells never call the finder, and it opens a new
  comparability-key lineage for every model tried.
- The staged experiment lane of ADR 0083 compares two skills. Its `screen` and
  `holdout` stages replay frozen sol reports through both arms, and its
  `live-paired` stage runs one finder from the contract argv for both arms.
  A finder swap is invisible to it, and teaching the lane a per-arm finder is
  a larger change than the question deserves.

ADR 0083 requires non-ledger experiments to use that lane, keep artifacts
outside the repository, and not import the ledger. Read literally, it forbids
a finder probe inside `run-eval.sh`, which is the only place that executes the
exact pipeline cell the ledger measures.

## Decision

`pnpm review:eval:run --kind finder --finder MODEL@EFFORT` is a third run kind
of the canonical runner, next to `full` and `canary`. It plans the nine
pipeline cells alone, one draw per fixture, with the contract's finder argv
rewritten for that plan and nothing else changed. It is non-ledger evidence
under these rules, each enforced in code:

- `--kind auto` never selects it; the freshness workflow never plans it.
- The plan records `inputs.finder_override`, and `finder_argv_digest` covers
  the overridden argv. The contract file is never modified. The scorer applies
  an override only to a `finder` plan and refuses any other kind that carries
  one, so a full or canary plan cannot smuggle an uncontracted finder into
  ledger evidence.
- The run scores into its detail directory and stops: baseline `null`, no
  pairing, verdict `EXPERIMENT`, which is outside the ledger verdict set.
  `--validate --append` refuses a `finder` plan, and the lifecycle abort path
  writes no failed row for one. The comparability key is unchanged by the
  override, so a probe cannot start a lineage either.
- `--against` and `--pr` are refused with a probe. The detail directory name
  carries the finder argv digest and the provider CLI versions, so two probes
  on one day, or a rerun after a CLI upgrade, never share evidence.
- Probe artifacts live under the operator's checkout in
  `docs/evals/review-skill-runs/` like any run's, and are never committed: no
  ledger row references them, and `--check-ledger` is row-driven, so a
  committed probe directory is inert. This is the one departure from ADR
  0083's "outside the repository" rule, taken so the runner's resume, cell
  cache and source-snapshot machinery apply unchanged.
- `pnpm review:eval:finder-compare` reads two detail directories offline. It
  refuses arms whose contract, scorer or calibration-set digests differ, an
  arm whose judge failed calibration or that records a suspected leak, and
  warns on key, skill, judge and orchestrator differences.
  `--allow-scorer-drift` downgrades the scorer refusal alone to a warning,
  because every scoring-module edit moves that digest whether or not matching
  changed.

One draw per fixture rejects a finder; it never promotes one. A finder that
wins a probe still needs a canonical full run on an updated contract, which is
the path ADR 0083 and [ADR 0091](0091-promote-needs-replay-corroboration.md)
already require.

## Alternatives considered

- **Per-arm finder in the experiment lane.** Keeps ADR 0083 literal. Needs a
  new plan input, a new stage, per-arm cache identities and a decision rule,
  for a question that a nine-cell run answers well enough to reject a finder.
  Rejected on size; it stays the route if probes ever need paired draws.
- **Edit the contract and run `--kind full`.** No code change, but 18 cells of
  every run buy nothing and each model tried orphans the lineage. Rejected.
- **Widen ADR 0083 to allow any non-ledger kind in the runner.** Too broad;
  the value of 0083 is that ledger evidence has one producer. This ADR admits
  one kind under named guards instead.

## Consequences

- A finder can be screened for nine cells and about 30 minutes against the
  anchor's pipeline cells, with the skill, verifier and judge identical. The
  five probes of 2026-09-10 metered $20 to $24 each: $14 to $17 for the nine
  Claude verifier cells and $5 to $7 for the judge pass. The codex finder call
  is not metered by the harness; it runs on the operator's Codex plan. The
  planner's warning of $3.68 per Claude cell ($33 for nine) is a budget
  ceiling, not the recorded spend.
- `run-eval.sh` and the scoring modules changed, so the comparability key
  moved; the next canonical run is a first row on its key. The runbook names
  the files that move it.
- ADR 0083's "artifacts outside the repository" and "separate lane" rules now
  read: for experiments that compare two skills. Finder probes are the named
  exception; everything else in 0083 stands.

## Evidence

- PR #2380 (issue #2379): `scripts/review/run-eval.sh`,
  `scripts/review/review-eval-run-plan.mjs`,
  `scripts/review/review-eval-finder-override.mjs`,
  `scripts/review/review-eval-run-score.mjs`,
  `scripts/review/review-eval-run-detail.mjs`,
  `scripts/review/review-eval-finder-compare.mjs`, and the finder subsection
  of `docs/evals/review-skill.md`.
- First probes against the 2026-09-10 anchor on key 74e08ffb are recorded on
  issue #2379.
