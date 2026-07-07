---
title: Review Process Metrics After PR 1045
status: active
owner: eng
canonical: false
last_verified: 2026-07-07
---

# Review Process Metrics After PR 1045

Source files:

- `docs/metrics/review-process-baseline-pre-1034-2026-07-03.json`
- `docs/metrics/review-process-after-1045-first-10-2026-07-07.json`
- `docs/metrics/review-process-after-1045-first-20-2026-07-07.json`

The triggers for issues #1066 and #1067 are satisfied: PR #1045 merged at
2026-07-03T17:40:00Z, and more than 20 PRs have merged after it.

## Summary

| Metric                            | Baseline: 20 before #1034 | First 10 after #1045 | First 20 after #1045 |
| --------------------------------- | ------------------------: | -------------------: | -------------------: |
| Median open-to-merge hours        |                      8.89 |                 0.78 |                 1.27 |
| Median commits after first review |                         2 |                    1 |                    1 |
| Top-level comments                |                       129 |                   31 |                   60 |
| Inline review roots               |                        96 |                   28 |                   51 |
| Inline roots without replies      |                         1 |                    0 |                    0 |
| Human review-request comments     |                        35 |                    1 |                    1 |
| Candidate findings                |                       107 |                   36 |                   67 |
| Codex usage-limit comments        |                         0 |                    3 |                    3 |

## Manual Classification

The collector's `candidateFindings` value is intentionally broad: it counts
finding-like top-level bot comments and finding-like inline review comments. I
classified the underlying GitHub comments and their replies in the generated
after-change JSON files.

| Classification  | First 10 | First 20 |
| --------------- | -------: | -------: |
| accepted        |       22 |       45 |
| valid-wont-fix  |        3 |        3 |
| duplicate-stale |        3 |        3 |
| noise           |        8 |       16 |

The most common heuristic-noise source is a top-level Claude review summary
that includes words such as "findings" or "review" but is not itself a
discrete finding. Those summaries can still be useful review rollups; they are
only noisy for `candidateFindings` as a discrete-finding metric.
Duplicate-stale entries were mainly duplicated reports of the same root issue
from multiple bot reviewers.

## Interpretation

Reply coverage improved. The after-change cohorts have zero unreplied inline
roots, compared with one unreplied inline root in the baseline.

Loop count improved. Median commits after first review dropped from 2 to 1 in
both after-change cohorts.

Open-to-merge timing improved materially. The first-20 median fell from 8.89h
to 1.27h. The first-10 median was 0.78h, so the first-20 sample stayed in the
same direction after more PRs landed.

Candidate volume improved, but not all of the change is quality signal. First-20
candidate findings fell from 107 to 67. Of those 67, 45 were accepted fixes, 3
were valid evidence-backed won't-fix decisions, 3 were duplicate/stale reports,
and 16 were heuristic noise from top-level review summaries.

Codex usage-limit comments regressed from 0 to 3. Those comments did not leave
unreplied inline roots in the sampled PRs, but they are a throughput and
readiness risk worth tracking separately from finding quality.

## Recommendation

Keep the review-process changes. The first-20 check-in shows better reply
coverage, fewer post-review commits, faster merge timing, and fewer candidate
findings than the baseline. Do not revert based on this sample.

Follow-up ideas:

- Teach the collector to separate top-level review summaries from discrete
  findings so `candidateFindings` is less noisy.
- Track Codex usage-limit comments as their own reliability metric rather than
  treating them as review-quality findings.
