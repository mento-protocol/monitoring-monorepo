---
title: File-size watchlist scheduling is repository-owned and issue-only
status: active
owner: eng
canonical: true
last_verified: 2026-08-10
scope: ci/process
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0059 — File-size watchlist scheduling is repository-owned and issue-only

**Status:** Accepted (Aug 2026), in force.
**Scope:** ci/process

## Context

An external Claude trigger owned the monthly file-size check. Its prompt copied
the repository's thresholds and exclusions, read and wrote `BACKLOG.md`, and
used raw line counts as hard-cap verdicts. That copy stayed enabled after the
repository added a lint-aware reporter and routed active work to GitHub Issues,
so its August run opened PR #1724 with generated and exempt files in the report.

The repository already owns the executable policy in
`scripts/repo-health/file-size-watchlist.mjs`, its tests, the passive watch list, and the
recurring-review checklist. Keeping the cadence outside the repository would
leave a second policy copy that normal review and drift checks cannot update.

## Decision

The repository owns one monthly, issue-only file-size schedule:

- `.github/workflows/file-size-watchlist.yml` runs at 07:13 UTC on the first day
  of each month and supports manual dispatch.
- Every run scans a separate checkout of the current default branch and
  executes `node scripts/repo-health/file-size-watchlist.mjs --format issue`. A manual
  branch dispatch may validate unreleased scheduler logic, but it cannot change
  the source commit used for the report.
- `scripts/repo-health/file-size-watchlist-issue.mjs` opens or updates one marked issue for
  an effective hard/near-hard row, a new effective soft-cap row, or growth above
  100 raw lines while the file remains over the effective soft cap. Rough counts
  determine cap status; raw counts describe growth only.
- The durable `file-size-watchlist` label narrows lookup, and an immutable body
  marker identifies the owned issue. Multiple marked issues fail closed.
- An actionable issue carries `agent-ready`, `kind:refactor`, `priority:p2`, one
  `pkg:*` per package area its actionable rows touch, and one `risk:*`. Risk is
  `risk:medium` unless the issue already carries a stricter label, which the
  upsert keeps. The job never writes `risk:low`: `agent-ready` plus one
  `risk:low` plus one `pkg:*` is the sweep predicate, and
  [`docs/notes/backlog-sweep.md`](../notes/backlog-sweep.md) reserves that last
  label for a human, so an unattended job cannot route its own issue into the
  unattended sweep.
- Reruns never overwrite an issue carrying `agent-active`, `in-pr`, or
  `needs-grooming`. An unclaimed issue closes when the actionable rows clear and
  reopens if drift returns.
- `publish_report=true` forces the current-main report through the issue path
  for live verification. A no-drift verification issue closes in the same run.
- The workflow can read contents and write Issues only. It uses pinned actions,
  one non-cancelling concurrency group, no model, no provider credential, and no
  repository-content or pull-request mutation.
- External copies of this monthly schedule remain disabled while the
  repository workflow is active.

## Alternatives considered

- **Repair the external Claude trigger** — rejected. Its prompt would remain a
  second copy of repository policy, outside code review and the checks that
  enforce documentation and workflow drift.
- **Refresh only `docs/notes/file-size-watch.md`** — rejected. A committed report
  is passive guidance and cannot provide a claimable action queue when a file
  reaches an actionable threshold.
- **Open a new issue every month** — rejected. Healthy months and unchanged
  findings would accumulate duplicate work. One synchronized issue preserves
  history without growing the queue.
- **Let the schedule open a pull request** — rejected. The report does not
  change runtime behavior, and generated PRs previously routed the result to the
  wrong source of truth.

## Consequences

- Thresholds, scope, cadence, and issue behavior now change through one reviewed
  repository diff.
- Healthy scheduled runs are silent. Operators can still produce auditable live
  evidence with a forced manual dispatch.
- A claimed or blocked issue intentionally keeps its published scope until a
  human or agent completes or releases it.
- The external trigger must stay disabled to prevent two monthly routines from
  racing or reopening the obsolete `BACKLOG.md` path.

## Evidence

- [`.github/workflows/file-size-watchlist.yml`](../../.github/workflows/file-size-watchlist.yml)
- [`scripts/repo-health/file-size-watchlist.mjs`](../../scripts/repo-health/file-size-watchlist.mjs)
- [`scripts/repo-health/file-size-watchlist-issue.mjs`](../../scripts/repo-health/file-size-watchlist-issue.mjs)
- [`scripts/repo-health/file-size-watchlist.test.mjs`](../../scripts/repo-health/file-size-watchlist.test.mjs)
- [`docs/notes/file-size-watch.md`](../notes/file-size-watch.md)
- [Issue #1753](https://github.com/mento-protocol/monitoring-monorepo/issues/1753)
- [PR #1724](https://github.com/mento-protocol/monitoring-monorepo/pull/1724)
