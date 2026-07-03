---
title: Review Process Metrics
status: active
owner: eng
last_verified: 2026-07-03
---

# Review Process Metrics

This note defines how we verify whether the AI review-process changes improved
review quality and throughput.

## Baseline

The pre-change baseline is the last 20 PRs merged before PR #1034, which was
the first PR in the Cloudflare-inspired review-process workstream.

Baseline file:

```text
docs/metrics/review-process-baseline-pre-1034-2026-07-03.json
```

Recreate it with:

```bash
node scripts/review-process-metrics.mjs \
  --before-pr 1034 \
  --limit 20 \
  --output docs/metrics/review-process-baseline-pre-1034-2026-07-03.json
```

Baseline summary:

| Metric                                   | Value |
| ---------------------------------------- | ----: |
| PRs                                      |    20 |
| Median open-to-merge time                | 8.89h |
| Median commits after first review signal |     2 |
| Top-level comments                       |   129 |
| Inline review roots                      |    96 |
| Inline review replies                    |    97 |
| Inline roots without replies             |     1 |
| Human review-request comments            |    35 |
| Candidate finding comments               |   107 |
| Codex usage-limit comments               |     0 |
| Codex approval comments                  |    12 |
| Claude summary comments                  |    12 |

## Future Check-Ins

Run two after-change check-ins:

1. First 10 PRs merged after PR #1045 — tracked by #1066.
2. First 20 PRs merged after PR #1045 — tracked by #1067.

Collect the first check-in with:

```bash
node scripts/review-process-metrics.mjs \
  --after-pr 1045 \
  --limit 10 \
  --output docs/metrics/review-process-after-1045-first-10-YYYY-MM-DD.json
```

Collect the second check-in with:

```bash
node scripts/review-process-metrics.mjs \
  --after-pr 1045 \
  --limit 20 \
  --output docs/metrics/review-process-after-1045-first-20-YYYY-MM-DD.json
```

Use the PR numbers in each generated `cohort.pullRequestNumbers` list to
sample review threads and classify each candidate finding.

## Manual Classification

The script can count finding-like comments, but it cannot reliably infer
whether a finding was useful. Before drawing conclusions, classify each
candidate finding into exactly one bucket:

- `accepted`: fixed in the PR.
- `valid-wont-fix`: technically valid, explicitly declined for a documented
  reason.
- `duplicate-stale`: duplicate, outdated, or already covered by another
  current-head finding.
- `noise`: speculative, incorrect, or outside the repo's review exclusions.

Keep the classification next to the generated JSON, either as a companion
Markdown note or by extending the JSON with a `manualClassification.results`
array.

## Success Criteria

The review-process changes are working if the after-change cohorts show:

- zero false all-clears from `pr:ready-state`;
- 100% reply coverage for review comments;
- fewer duplicate, stale, or speculative findings;
- fewer commits after first review signal on comparable PRs;
- no drop in accepted P1/P2 finding yield;
- lower median time from PR open to ready/merge after accounting for CI wait and
  Codex quota blockers.

## Caveats

- The baseline was generated from GitHub's current retained PR metadata, not
  from historical per-poll readiness snapshots. It captures comments, review
  submissions, inline review comments, commits, and merge timing, but not every
  transient CI state.
- `candidateFindings` is intentionally broad. Use manual classification before
  treating it as review precision.
- Dependabot and tiny docs PRs should not be compared directly against
  high-risk workflow or cross-layer data-flow PRs. Compare cohort medians and
  inspect outliers.
