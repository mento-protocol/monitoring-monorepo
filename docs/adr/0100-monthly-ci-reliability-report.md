---
title: Monthly CI reliability report is an issue-only scheduler
status: active
owner: eng
canonical: true
last_verified: 2026-09-14
scope: ci/process
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0100 — Monthly CI reliability report is an issue-only scheduler

**Status:** Accepted (Sep 2026), in force.
**Scope:** ci/process

## Context

Nothing in the repository measures re-runs, cancellations, or per-step CI
time on a recurring basis. That gap was visible in this repo's own CI-cost
audit: its standing figures for the `scripts` job (27% flake, p90 49 min)
described a suite PR #2296 deleted on 2026-09-04, and nothing surfaced that
the numbers had moved. After a runner migration every timing changes at
once, and without a recurring baseline a real flake regression is
indistinguishable from migration noise.

A per-run job/step read costs one Actions API call per run. Scoping it to
every workflow for a full month risks the per-hour `GITHUB_TOKEN` rate limit,
and a naive repo-wide runs listing can hit the API's ~1,000-result pagination
ceiling for a busy workflow. The report also needs a stable per-workflow,
per-job timeout-minutes cap to classify a cancellation as a genuine
supersession or a timeout-cap kill; the nearest existing cap map
(`EXPECTED_TIMEOUTS` in `check-ci-contract.mjs`) is keyed by `ci.yml` job id,
not display name, and does not cover any other workflow.

## Decision

`.github/workflows/ci-reliability-report.yml` runs monthly (and on manual
dispatch), least-privilege (`permissions: {}` at the workflow level; the job
grants itself `actions: read`, `contents: read`, `issues: write`), on
`ubuntu-24.04-arm`, following the `file-size-watchlist.yml`
scheduling shape (ADR 0059) and the `m6-canary.yml` `github-script` shape for
reading the Actions API through the injected, auto-paginating Octokit client
rather than a `gh api` shell-out.

`scripts/workflows/report-ci-reliability.mjs` does the work:

- Per-workflow run counts, attempt>1 rate, and cancellation rate come from
  the runs-listing endpoint, queried **per workflow** (not repo-wide) to stay
  under the pagination ceiling, and cover every run in the 30-day window.
- Per-job duration/queue percentiles, CI per-step minutes, and cap
  comparisons need one job-list call per run, so they sample at most 60
  `pull_request` runs, at random, for `CI` and `PR Description` only — the
  two workflows worth the token spend. `push`/`workflow_call` runs are
  excluded from sampling so a small, uneven fraction of `CI`'s volume cannot
  outweigh its dominant event once merged; the report states the sample size.
- Timeout-minutes caps are parsed directly from every workflow YAML file,
  keyed by workflow `name:` + job `name:`, defaulting to GitHub's implicit
  360-minute cap. This does not import `EXPECTED_TIMEOUTS`.
- A cancelled or failed job counts as a cap kill when its wall duration is at
  or above its own cap — exact, not a heuristic band, because a job cannot
  exceed `timeout-minutes` except by being killed at it.
- The report publishes as the job summary and upserts one
  `ci-health-report`-labeled issue per calendar month, keyed by an immutable
  body marker, the same upsert shape as
  `scripts/repo-health/file-size-watchlist-issue.mjs`.

The report is advisory: it names a re-run rate, a cancellation rate, and a
failing-step rate, but does not gate CI or open per-step deflake issues. Two
of those readings graduate to a stated budget in
[`docs/pr-checklists/ci-workflow-gates.md`](../pr-checklists/ci-workflow-gates.md):
`CI` `pull_request` wall p90 duration, and no single CI step failing in more
than 1% of sampled runs by distinct run.

## Alternatives considered

- **Reuse `EXPECTED_TIMEOUTS` as the cap source.** Rejected: it is an
  unexported `const` keyed by `ci.yml` job id, while the Actions API returns
  job display names, and it does not cover the workflows outside `ci.yml`
  that also show cap-adjacent cancellations.
- **Query the repo-wide runs listing.** Rejected: a shared list call for
  every workflow risks the ~1,000-result pagination ceiling for `CI` alone in
  a busy month, and mixes events that a per-workflow query keeps separable.
- **Fetch job/step data for every run in the window.** Rejected on cost: at
  current volume this is roughly 1,450 API calls for `CI` alone across 30
  days, most of it spent on rows the report never uses. Sampling at random,
  stated in the report, keeps the read cheap and still exact for the
  timeout-cap classifier.
- **Auto-open a per-step deflake issue on budget breach.** Rejected for this
  change: the report has no track record yet, and an unattended writer
  opening issues against a rate it has measured once risks the same
  incomplete-grooming failure ADR 0059 already guards its own report
  against. A human reads the monthly issue and files a deflake issue if one
  is warranted.

## Consequences

- One new scheduled job/month (~1 boot). `ci.yml`'s `scripts` job gains one
  `node --test` step for the reporter's tests, rotating `CI_GRAPH_HASH`; no
  new required check.
- The report is the first recurring measurement of CI retries, cancellations,
  and per-step time in this repository; a stale audit figure like the one
  that motivated this ADR should surface within a month instead of going
  unnoticed indefinitely.
- The sampled sections (duration, step minutes, cap comparisons, failing
  steps) are month-to-month estimates, not exact counts; the report states
  its sample size so a reader can weigh that.

## Evidence

- Issue #2407, PR implementing `scripts/workflows/report-ci-reliability.mjs`,
  `scripts/workflows/report-ci-reliability.test.mjs`,
  `.github/workflows/ci-reliability-report.yml`.
- `scripts/workflows/check-ci-contract.mjs:48` (`EXPECTED_TIMEOUTS`, job-id
  keyed, `ci.yml`-only) and `scripts/repo-health/file-size-watchlist-issue.mjs`
  (the issue-upsert precedent) are the two files this decision departs from
  and follows, respectively.
- Removal commit `078284fe` (PR #2296) is the stale-figure case this report
  is meant to catch on a future recurrence.
