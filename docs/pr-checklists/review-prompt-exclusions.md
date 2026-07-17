---
title: Review Prompt Exclusions
status: active
owner: eng
canonical: true
last_verified: 2026-07-03
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

- Do not ask for another ad hoc quality command when `pnpm agent:quality-gate
--run` has mapped and executed the applicable local checks for the changed
  paths. Flag missing targeted checks only when the gate mapping is incomplete
  for the diff or when a package-specific `AGENTS.md` requires an extra command.
- Do not flag a missing context-doc update solely because a file under
  `docs/PLAN-*` changed. Flag context drift when the diff introduces or changes
  commands, scripts, env vars, hooks, deploy/codegen steps, ownership routing,
  required workflow order, or checklist behavior without updating the canonical
  docs that agents actually read.
- Do not treat weekly or advisory gates as per-PR blockers unless the workflow is
  branch-protection-required for the PR. Examples include mutation testing,
  duplication reports, and schema-diff comments when their check status is
  advisory.

## Repo-Specific False Positives

- Do not flag the current dashboard snapshot-query aggregation path as a
  scalability issue while expected scale remains roughly 30-50 pools and the
  current polling setup has no observed latency or cost regression. Re-open the
  issue only if pool count, polling frequency, data volume, or production
  performance changes materially.
- Do not flag client-side aggregation for the existing 24h volume tiles/table on
  scale grounds under the same assumptions. If the query shape changes to cross
  Hasura row caps or starts mixing deploy-window-sensitive schema fields into a
  primary page query, use the SWR/Hasura checklist instead.

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
