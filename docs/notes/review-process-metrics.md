---
title: Review process metrics evaluation
status: archived
owner: eng
canonical: false
last_verified: 2026-07-17
doc_type: report
scope: ci/process
review_interval_days: 365
garden_lane: notes-plans-archive
---

# Review process metrics evaluation

The one-time evaluation around PRs #1034–#1045 is complete. Issues #1066 and
#1067 collected the first 10 and first 20 merged PRs after PR #1045; neither
cohort is pending.

The evidence and conclusion live in:

- [`review-process-after-1045-comparison-2026-07-07.md`](../metrics/review-process-after-1045-comparison-2026-07-07.md)
- `docs/metrics/review-process-baseline-pre-1034-2026-07-03.json`
- `docs/metrics/review-process-after-1045-first-10-2026-07-07.json`
- `docs/metrics/review-process-after-1045-first-20-2026-07-07.json`

The first-20 comparison supported keeping the review-process changes: reply
coverage improved, median commits after the first review fell from two to one,
and median open-to-merge time fell from 8.89 hours to 1.27 hours. The report
also records the manual finding classification and the Codex usage-limit
caveat.

`scripts/review-process-metrics.mjs` remains available for a newly scoped
evaluation. A future experiment should define a new boundary, cohort, and
tracking issue rather than treating these completed cohorts as recurring work.
