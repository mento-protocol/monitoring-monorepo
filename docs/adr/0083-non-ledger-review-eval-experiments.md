---
title: Review-skill experiments use a separate staged non-ledger lane
status: active
owner: eng
canonical: true
last_verified: 2026-09-01
scope: ci/process
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0083 — Review-skill experiments use a separate staged non-ledger lane

**Status:** Accepted (Sep 2026), in force.
**Scope:** ci/process

## Context

The canonical review-skill evaluation has 24 model cells. It supplies the
ledger verdict, baseline, and freshness evidence. This matrix is too slow and
costly for early prompt experiments.

The existing three-cell canary has too few paired P1 opportunities to select a
candidate. A candidate-only live run also mixes finder variance with the skill
change. Repeated experiments use visible development fixtures, so an
experiment cannot replace canonical qualification.

## Decision

[ADR 0086](0086-review-eval-lane-any-grid-multi-draw.md) supersedes this
decision on the panel: the grid is every contract fixture marked `grid: true`,
`--draws N` repeats each fixture, and every number written below as a count —
the fixed PR list, the three-lane panel, 12 P1 opportunities, the 24-cell
manifest, and the promote and reject bars — is derived from the grid and the
draws instead. The harness digest binds every module listed in
`EXPERIMENT_SOURCE_FILES`, which is no longer six. Everything else here stands.

ADR 0085 supersedes this decision on one point: the plan records provider CLI
versions and each cache identity binds the live version of the provider its
phase invokes. The bullet below that names provider CLI versions among what the
plan binds is superseded by that ADR; everything else here stands, so this ADR
keeps `status: active` — the checklist's archive-and-`superseded_by` rule
applies to a whole superseded decision, not to one clause.

Add a small staged experiment lane with these rules:

- The lane writes `plan.json` and content-addressed artifacts under `cache/raw/`,
  `cache/score/`, `cache/novel/`, and `cache/stage/` in an artifact directory
  outside the repository. Its implementation does not import the canonical
  ledger. It cannot update a baseline or freshness clock.
- The lane emits only `PROMISING`, `REJECT`, or `INCONCLUSIVE`. It never emits
  the canonical ledger verdicts `GREEN`, `AMBER`, `RED`, `PROMOTE`, or
  `INCOMPLETE`.
- One campaign compares one candidate with one incumbent. The runner writes and
  validates the complete campaign plan before it starts a model process. The
  plan binds the contract digest, fixture head and base SHAs, truth,
  finder-report and prompt digests, skill digests, model and effort settings,
  provider CLI versions, scorer, the six-module experiment harness digest,
  complete lane set, treatment order, and a canonical 24-cell rerun manifest.
- The screen uses the first frozen finder report for each of the three grid
  fixtures. The holdout uses each complementary report. The optional
  `live-paired` stage generates one current finder output per fixture and gives
  the same final UTF-8 suffix of at most 30,000 bytes to both verifier arms.
- Each fixture lane runs its two verifier arms sequentially in the planned
  `AB` or `BA` order. The runner can process at most three fixture lanes at
  once.
- The screen needs at least two net known matches, no net P1 loss, and a
  non-negative known-match delta on at least two PRs. A known-match net of
  minus two or less, or any P1 net loss, returns `REJECT`. Other misses return
  `INCONCLUSIVE`. If claim inflation requires classification, more than one
  extra wrong claim also returns `REJECT`.
- The holdout adds six verifier arms. Its decision combines the six screen arms
  and six holdout arms. It needs at least three net known matches, at least 9 of
  12 candidate P1 matches, at least two net P1 matches, gains on at least two
  PRs, and at most one extra wrong claim. A known-match net of minus two or
  less, any net P1 loss, or more than one extra wrong claim returns `REJECT`.
  Other threshold misses return `INCONCLUSIVE`.
- Every planned arm must be present. An empty candidate arm or candidate hard
  leak returns `REJECT`. Other missing, malformed, empty, or leaked paired
  evidence returns `INCONCLUSIVE`.
- Scoring extracts claims and matches frozen defects first. Novel-claim
  classification runs only when claim inflation requires it or the candidate
  reaches the holdout finalist decision. Claim inflation needs at least three
  extra claims and a ratio of at least 1.25. Deferred `wrong_claims` fields stay
  absent from the arm records.
- Raw output, known-match scoring, novelty scoring, and completed stage results
  use separate content-addressed identities. Each identity includes the plan
  digest. A live raw identity also includes the delivered finder-report digest.
  A score identity includes the raw artifact digest. A novelty identity includes
  the score artifact digest. The runner verifies the identity and content digest
  before reuse. It publishes complete JSON through a temporary file and an
  exclusive hard link to the final name. Readers ignore incomplete temporary
  files.
- A failed stage writes no completed `cache/stage/` entry. Raw, score, or novelty
  entries completed before the failure remain available. The operator reruns
  the same stage. The runner reuses exact entries and repeats missing or changed
  work. A completed stage entry blocks a second sample for that stage.
- The experiment runner does not implement crash-lineage recovery, retry
  journals, a campaign lock, calibration receipts, provider executable pinning,
  process-group control, or a host sandbox. The operator runs one command for a
  campaign at a time. The runner reuses the canonical fixture builder, scorer,
  and Claude call wrapper. The live finder has no experiment-specific deadline
  or process-group control. The runner is an operator-started local experiment,
  not an unattended service or an adversarial containment boundary.
- The canonical rerun manifest is planning data only. No canonical importer
  exists, and the manifest disables experiment-artifact reuse. A selected
  candidate must rerun all 24 canonical cells.
- The current fixtures are development data. A broad generalization claim
  needs a new holdout whose truth did not guide the candidate change.

## Alternatives considered

- **Run the canonical matrix for every edit** — rejected because its cost and
  duration prevent rapid experiments.
- **Shrink the canonical matrix** — rejected because that changes the score of
  record and breaks comparison with existing ledger rows.
- **Promote from the existing canary** — rejected because three cells provide
  too little paired P1 evidence.
- **Run only the candidate through a live finder** — rejected because finder
  sampling would confound the skill comparison.
- **Build an unattended crash-safe evaluation service** — rejected for this
  lane because recovery receipts, locks, process containment, and calibration
  publication add more code and defect classes than the experiment needs.
- **Write experiment results to the canonical ledger** — rejected because an
  experiment could then affect baseline selection or freshness.

## Consequences

- A weak candidate can stop after six verifier arms. A promising candidate adds
  six holdout arms. Optional live confirmation adds three finder calls and six
  verifier arms.
- Exact cache keys avoid repeat spend when the measured inputs are unchanged.
  A restarted live stage generates new finder reports, so prior raw entries are
  reusable only when the delivered report digest is also unchanged.
- A host crash can require operator inspection and a stage restart. The lane
  makes no process-lineage or hostile-host guarantee.
- The smaller runner reuses the canonical fixture and scorer contracts. It has
  fewer independent publication and recovery rules to validate.
- Experiment results remain selection aids. The canonical evaluation remains
  the final authority.

## Evidence

- Issue #2187
- `docs/evals/review-skill.md`
- `scripts/review/review-eval-experiment.mjs`
- `scripts/review/review-eval-experiment-cache.mjs`
- `scripts/review/review-eval-experiment-contract.mjs`
- `scripts/review/review-eval-experiment-decision.mjs`
- `scripts/review/review-eval-experiment-runtime.mjs`
- `scripts/review/review-eval-experiment-versions.mjs`
- `scripts/review/review-eval-experiment*.test.mjs`
- `scripts/review/review-eval-fixtures.mjs`
- `scripts/review/review-eval-run-execution.mjs`
- `scripts/review/review-eval-run-plan.mjs`
- `scripts/review/review-eval-score.mjs`
