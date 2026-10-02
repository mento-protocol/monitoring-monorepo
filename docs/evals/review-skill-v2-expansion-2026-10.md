---
title: Review evaluation expansion, October 2026
status: active
owner: eng
canonical: false
last_verified: 2026-10-02
doc_type: reference
scope: ci/process
review_interval_days: 90
garden_lane: package-readmes-reference
---

# Review evaluation expansion, October 2026

All 32 end-to-end pipelines completed between October 1 and October 2, 2026.
The expanded panel exposes known-root misses and run variation that the earlier
pilot did not show. It does not establish a quality win for GPT-6.1 Sol/high.
The production reviewer model remains unchanged.

This is an experimental result, not a new command contract. The
[v2 runner](review-skill-v2.md) in [PR #2559](https://github.com/mento-protocol/monitoring-monorepo/pull/2559)
remains the opt-in two-family pilot. This expansion used reviewed private
adapters for native internal reviewers, repeated draws, recovered verification
outputs, exact-span grading, and post-hoc adjudication. Those adapters and the
expanded dataset are not shipped by this documentation change. The result does
not prove that the shipped CLI can reproduce the expanded campaign unaided.

## Design and scope

Four PR families each have original and repaired source. Each variant receives
two draws from each internal reviewer: `gpt-5.6-sol/high` and
`gpt-6.1-sol/high`. Both use the same frozen review-skill bytes. Fixed
`claude-opus-5/high` verifies each native report and can add or reject findings.
The same Claude model and effort perform extraction, matching, and novel-claim
grading. Quality results therefore describe the combined workflow.

The panel has seven known roots and four independent family units. Repeated
draws and related variants do not make 32 independent samples. The families
were absent from the inspected earlier eval manifests. Curators had inspected
historical findings and source. Global prior exposure and model-training
exposure are unknown. This is not an unseen holdout or human expert calibration.

Sources, repairs, skill, prompts, model settings, and ordering were frozen
before native execution. Reviewers used source-inspection tools, not executed
tests. Independent agents checked labels and bounded causal proofs. These
checks do not establish production incidence or full application behavior.

## Known-root coverage

Each entry lists matched positive-root records in draw 0 and draw 1. All
original-source cells are included, even when novel claims remain unverified.
These descriptive counts do not replace frozen complete-row recall.

| Family                  | 5.6 draw 0 / draw 1 | 6.1 draw 0 / draw 1 | Roots per draw |
| ----------------------- | ------------------: | ------------------: | -------------: |
| Replay state, #2452     |               2 / 1 |               1 / 1 |              2 |
| Sentry filtering, #2470 |               1 / 1 |               0 / 1 |              1 |
| Alert boundaries, #2527 |               2 / 1 |               1 / 1 |              2 |
| Reserve history, #2558  |               1 / 1 |               1 / 1 |              2 |

Across 14 positive-root opportunities per arm, 5.6 matched 10 and 6.1 matched 7.
Both missed obsolete pagination in both draws. The candidate also missed the
exact-expiry replay and exact-zero alert-overlap roots in both draws. The
zero-overlap product requirement is disputed; recognition of its conditional
mechanism is not proof that the product choice is a defect.

Neither arm accused a repaired variant of a named repaired root. Other defects
remain possible. Repaired #2452 and #2470 entered with provisional whole-diff
clean attestations; later supported findings challenged both. Their clean
rates remain suppressed for both arms. The other repairs are negative controls
for named roots only.

## Novel findings and uncertainty

The primary view applies whole-report disposition and causal deduplication.
The broad sensitivity view retains every extracted claim. Counts below include
all 32 cells and count claim occurrences, not unique bugs. Compound spans can
combine supported and unresolved clauses; no precision or ranking follows.

| All-cell primary view             |  5.6 |  6.1 |
| --------------------------------- | ---: | ---: |
| Model-supported novel occurrences |   22 |   18 |
| Wrong novel occurrences           |    5 |    7 |
| Unsupported novel occurrences     |   22 |   25 |
| Unverified novel occurrences      |   21 |   20 |
| Fully graded cells                | 4/16 | 5/16 |

Broad sensitivity contains 23 and 20 supported novel occurrences, respectively,
and 24 unverified occurrences per arm. The immutable automated grades marked
21 of 32 rows complete. Source adjudication found overconfident grades as well
as resolvable uncertainty: 9 rows are fully graded and 23 retain unverified
claims. Frozen equal-weight family recall remains null for both arms.
Execution completion does not mean every factual question was proved.

Recurring supported causes include bootstrap replay price divergence, specific
ADR inaccuracies, a conditional retention-assertion weakness, Sentry test gaps,
page-size controls missing from consumer branches, partial-history loss on
failed attempts, transient cancellation errors, and a false definite-omission
warning at exactly 100,000 rows. These groups are descriptive, not a unique-bug
total. The retention result concerns one assertion; the same configuration
predicts failures in neighboring positive tests, so it is not a proved
passing-suite escape.

Remaining uncertainty includes real catchable replay failures, actual wallet
event shapes, alert-floor provenance, external sign-off, ordinary same-key abort
triggers, rendered layout effects, and measured chart performance. Conditional
source mechanisms do not prove their ordinary trigger or material consequence.
Full-review checks also found merged independent concerns in alert, history,
and Sentry extraction. Exact spans and clause limits remain in private mappings;
no invented claim IDs were inserted into frozen scores.

## Timing and amendments

Native-review medians were 136.587 seconds for 5.6 and 67.731 seconds for 6.1.
Native sums were 2,189.446 and 1,232.485 seconds. Accepted fixed-Claude
verification sums, grouped by upstream reviewer, were 9,344.293 and 7,921.383
seconds. These are stage-duration observations, not campaign wall time or a
controlled estimate of model speed.

The record contains 32 native reviews and 167 provider CLI invocations:
32 accepted verifications, 6 failed verifications, 33 original grading calls,
and 96 amended grading calls. The last group contains 32 extraction, 32
matching, and 32 novel-classification calls. Native usage is unavailable;
five failed verifications lack terminal usage. Missing usage remains unknown.
Subscription dollar telemetry is not an account charge, and no dollar stop
applied. Subscription quotas still apply.

Material post-observation amendments:

- Native admission first allowed bounded read-only discovery failures, then
  understood effectless syntax errors with complete recovery. All 32 passed
  amended trace checks; only cells 01, 09, 10, and 27 meet the original strict
  rule. No valid native review was rerolled.
- Three original extraction calls failed exact-quote validation. Integer line
  spans then replaced quote transcription in a new grading namespace for all
  32 reviews. Matching and novelty rubrics stayed unchanged. Exact bytes do
  not establish semantic completeness or one distinct claim per span.
- Six incomplete verifier attempts were preserved. Replacements were stateless
  and did not inherit partial transcripts. One replacement received a reviewed
  40-minute host watchdog and finished in 951.723 seconds, below the prior
  20-minute limit. This does not show that the extension caused success.
- Claude 2.1.285 was selected through a process-local shim after the default
  installation changed. Its delegated binary hash was recorded during recovery.
  Host Node changed to 24.21.0 after the earlier path disappeared; nine focused
  compatibility tests passed. Full child-environment equivalence is unproved.

The original ten scores and thirty accepted grading stages remain separate.
All final calls, receipts, stage caches, and score identities joined correctly.
Four fresh-context agents reviewed current claims without model/arm mappings.
Incidental source and review identifiers remained visible. Agent adjudication
is not human expert calibration, and artifact validation does not prove causal
truth. Twenty-three rows retain explicit uncertainty after that review.

## Evidence identity and retention

The campaign helper base is `85e363ce0ab5bbcc8642e3a98826d75429fd682d`.
The private overlay snapshot digest is
`e7e9d2d32b3d13f32f6f9dc9a21c34a77d70b79c0330867b8f8487b32a83cdee`.
Both arms use skill digest
`d5c5964a6278e56fcb15734baec244afd5292c59a485f063afba45c9b2bb4805`.

The following source pins identify the evaluated variants. Repair digests
identify the complete frozen repair input, not a promise that the whole diff
is clean.

| Family  | Base                                       | Original head                              | Repair SHA-256                                                     |
| ------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------ |
| pr-2452 | `a57133c21ea8ef4f998b848b80f64d52b14b75a9` | `7e5cc861f1b2c48108c4699e551a2f6875b62f24` | `df1e7ee0672f2ce7fdae126c47735dc52d14eb242a8594f4c5f42c164e311222` |
| pr-2470 | `fc7c5daac78874f12fc7d6d1808f48113fcae443` | `0704d5191413c47a12d6063c3663fec5597f68a5` | `49dc19ca8690b970a6bbb2b6943df75b74a5e13d29a7010461b1bcdab7ffc80e` |
| pr-2527 | `9bee8a753b28174ed6088e92647491c8354ffafb` | `ddb98a83a4068620f391a90e0132eee84e4da686` | `0b0708cf82aa38adc1b7bc16d50ebffede077de88a1804985ab85398d7ebfdd5` |
| pr-2558 | `3a6161004df5a065e31ca6b9d8140ec6f833525c` | `bebbf03822ef1c72b6bb989d3374a01f4c88dfc6` | `eda3d28de15cf95e07c546466afd752e75ed51c5d1d9eb153231d30ef8033792` |

Full execution artifacts stay private, as the v2 runbook requires. The local
archive set is held with the eval worktree's ignored review artifacts; it is
not a repository attachment or an off-host backup. These hashes locate evidence
and detect changes. They do not authenticate the author or make this report
independently reproducible from the repository alone.

| Artifact                          | SHA-256                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| Frozen plan digest                | `0db9fd0b5ef3135bf07bb66980975aa0e4e893c2216a094021b5ed8688a50e10` |
| Uniform raw score report          | `a018ec6a815d36af8daaed62929e2510d472309211776933cc3a26fbf87bcc28` |
| Accepted decisions                | `cf8d88d0b6540e84ba50c9e69e2ab26eabcf81a34d1129a184ff79f3d9c86ea7` |
| Adjudicated report                | `e5ce4ccf1ab04c25b13df772ecd23de8afbf254886722eab6dc0e88114a33e26` |
| Final adjudication/report archive | `3a4b52b2afe329cf73d4019a1cf0b417e2d32ba35dea9462a32d848e339a3bc9` |

Earlier source, raw-output, failure, and grading checkpoints are also required.
Every final archive member was checked by hash, size, and mode. Source exports
omit Git history, installed dependencies, and submodule contents. An obsolete
preparation generator was not recovered. No full restore rehearsal, tamper-proof
storage, or complete historical reconstruction is claimed.

The earlier pilot remains separate: both arms matched 3/3 known roots and had
7 supported novel occurrences. Those were repeated findings, not seven unique
bugs. Its results are not pooled with this expansion.

## Decision and next design work

Keep the production reviewer unchanged. The expanded eval has headroom, but
this campaign's repeated verification, recovery, and adjudication were too slow
for routine iteration. A smaller repeatable comparison and occasional deep
source adjudication are a better next design to test. Atomic claim extraction
would make compound findings easier to grade consistently. These are proposed
changes, not implemented behavior.
[Issue #2564](https://github.com/mento-protocol/monitoring-monorepo/issues/2564)
tracks the design and validation work.

[Issue #2556](https://github.com/mento-protocol/monitoring-monorepo/issues/2556)
retains expert calibration and genuinely unseen confirmation work. This panel
does not close those requirements. [Issue #2555](https://github.com/mento-protocol/monitoring-monorepo/issues/2555)
owns implementation and execution evidence. PR readiness is a separate live
check; this historical report grants no merge or promotion authority.
