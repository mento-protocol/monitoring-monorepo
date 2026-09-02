---
title: Review Prompt Exclusions
status: active
owner: eng
canonical: true
last_verified: 2026-09-02
doc_type: checklist
scope: repo-wide
review_interval_days: 90
garden_lane: pr-checklists-process
---

# Review Prompt Exclusions

Use this checklist as repo-local "do not flag" guidance for human and agent
reviews. It is intentionally narrow: each exclusion exists because the repo has
a more precise source of truth, gate, or operating rule elsewhere.

These exclusions do not suppress findings when the underlying assumption has
changed. If a reviewer has current evidence that an exclusion no longer holds,
flag the concrete regression and cite the evidence.

## Feedback State

- Do not treat stale, outdated, resolved, or replied findings as current
  blockers when `pnpm --silent pr:feedback-state --pr <number> --json` marks
  them non-blocking. Use the ledger's `findings[]` state fields instead of
  re-reading old review text as if it applies to the current head.
- Do not require a fresh review reply for a comment that already has an
  explicit fixed or won't-fix reply. If new code reintroduces the same issue,
  open a new finding against the current diff instead of reviving the old one.
- Do not count clean, informational, or advisory top-level bot comments as
  review blockers. They are part of the required feedback sweep, but they only
  block when they contain actionable current-head findings or when branch
  protection marks the related check as required.
- Do not block all-clear on optional bot lag. `pnpm pr:ready-state --pr
<number> --json` is the readiness source of truth, and its required-only
  result decides readiness. Advisory lag should be reported separately.

## Scope And Ownership

- Do not flag a repo PR for failing to edit the global `~/.agents/skills/review`
  skill. This repo can ship repo-local context and wrappers; global skill
  changes belong in the owning skill store unless the user explicitly asks for
  an out-of-repo edit.
- Do not flag non-canonical roadmap files, such as `docs/PLAN-*`, as live
  operating truth. They can drift as planning artifacts. Canonical review
  context lives in `AGENTS.md`, package `AGENTS.md` files, `docs/pr-checklists/`,
  scripts, workflows, and tested command behavior.
- Do not require a GitHub issue for a well-evidenced won't-fix decision. The
  deferral rule requires issues for knowingly deferred work, not for findings
  that are rejected because they are false, obsolete, already covered by an
  existing gate, or outside the repo's ownership boundary.
- Do not require browser verification for docs-only or non-UI tooling changes.
  Browser verification is mandatory when a PR changes UI behavior, frontend
  build/runtime paths, browser tests, visual output, or dashboard interaction
  flows.

## Existing Guardrails

- Do not ask for another ad hoc quality command when the PR records every
  applicable author check from step 3 of the
  [PR operating card](../notes/pr-operating-card.md) and every extra check from
  the scoped `AGENTS.md`. Flag a missing check only when a matching trigger or
  scoped instruction has no recorded result.
- Do not flag a missing context-doc update solely because a file under
  `docs/PLAN-*` changed. Flag context drift when the diff introduces or changes
  commands, scripts, env vars, hooks, deploy/codegen steps, ownership routing,
  required workflow order, or checklist behavior without updating the canonical
  docs that agents actually read.
- Do not treat weekly or advisory gates as per-PR blockers unless the workflow is
  branch-protection-required for the PR. Examples include mutation testing,
  duplication reports, and schema-diff job summaries when their check status is
  advisory.

## Repo-Specific False Positives

- Do not flag pool-level `PoolDailySnapshotsAll` composition as a scalability
  issue solely because it reduces daily rows in the client. On 2026-07-26,
  public production measured 30 pools and 3,197 rows across five pages; the
  largest chain used three pages, 2,429 rows, and 686 ms first-load pagination.
  Re-open the concern when pool count exceeds 40, one chain returns 3,500 or
  more rows or requires four or more pages, all chains together return 6,000 or
  more rows or require eight or more pages, or one complete chain pagination
  reaches 1,500 ms on two consecutive measurements. [ADR 0051](../adr/0051-dashboard-volume-scale-bounds.md)
  owns the reproducible request details. This is not a cost or quota claim.
- Do not apply that pool-snapshot evidence to `/volume`. Its public v3 7d hero
  separately measured `VolumeWindowLatest` at 3 rows and
  `VolumeTodayTraders` at 6 rows, each one page. Re-open the concern when the
  rollup exceeds 10 rows or one page, when the current-day partial reaches 100
  rows, or when either primary query reaches 1,000 ms on two consecutive
  measurements. The 1,000-row Hasura cap remains a hard rework boundary for
  the current-day query. [ADR 0051](../adr/0051-dashboard-volume-scale-bounds.md)
  owns the reproducible request details.
- Neither exclusion waives Hasura row caps for hero or table queries. If a
  query shape approaches a cap or mixes deploy-window-sensitive schema fields
  into a primary page query, use the SWR/Hasura checklist.

## Reviewer Workflow

- Start from current state: base branch, current head SHA, `pr:feedback-state`,
  `pr:ready-state`, and the changed files. Avoid carrying forward stale
  conclusions from older pushes.
- When a repeated false positive appears, prefer adding a narrow exclusion here
  and linking the precise source of truth over broad prompt wording that could
  hide real regressions.
- When an exclusion relies on an assumption, name the assumption and the
  evidence that would invalidate it. A future reviewer should know when to stop
  applying the exclusion.
