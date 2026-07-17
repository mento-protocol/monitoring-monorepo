---
title: AI Review Process Integration Plan
status: archived
owner: eng
canonical: false
last_verified: 2026-07-17
archived: 2026-07-17
archived_reason: "All five planned review-process slices shipped in PRs #1034, #1037, #1039, #1040, and #1044; no follow-up PR is planned."
doc_type: plan
scope: ci/process
review_interval_days: 365
garden_lane: notes-plans-archive
---

# AI Review Process Integration Plan

> **ARCHIVED** — All planned slices shipped. This document preserves the
> workstream's intent and sequence; verify current behavior in AGENTS, scripts,
> checklists, and readiness probes before relying on it.

This plan captured the Cloudflare AI code-review integration ideas that fit the
repo's agent workflow. It is intentionally non-canonical.

## Current Baseline

The repo already has a strong review loop:

- `pnpm agent:quality-gate` maps changed paths to local validation commands and
  checklists.
- `pnpm agent:autoreview` runs closeout review at batch boundaries.
- `pnpm --silent pr:feedback-state --pr <number> --json` projects review
  feedback surfaces.
- `pnpm pr:ready-state --pr <number> --json` is the final readiness source of
  truth before all-clear.
- Root `AGENTS.md` requires feedback-surface sweeps, explicit review-comment
  replies, and batch-level sibling audits.

## Target Shape

Adopt the parts of Cloudflare's approach that improve signal without replacing
the repo's existing gates:

1. Classify review materiality as `trivial`, `standard`, or `full` from changed
   path risk and diff size.
2. Detect changes that likely require context updates, especially new commands,
   scripts, env vars, hooks, workflow steps, deploy/codegen steps, and package
   ownership changes.
3. Promote PR feedback into normalized finding identities so follow-up rounds can
   distinguish unresolved, replied, outdated, and current-head findings.
4. Tighten review-specialist prompts with explicit "do not flag" exclusions to
   reduce noisy or speculative findings.
5. Enrich autoreview bundles with shared context files instead of relying on one
   large prompt.

## Shipped PRs

1. PR #1034 shipped a repo-native materiality and context-drift slice:

- Add `scripts/review-materiality.mjs`.
- Expose it as `pnpm agent:review-materiality`.
- Have it classify changed paths against a base ref and emit both human output
  and JSON.
- Flag likely context-update requirements for new root commands, scripts,
  workflows, env examples, package-manager files, AGENTS/checklist files, and
  docs/runbook paths.
- Add tests for the classifier.
- Route script changes through `pnpm agent:quality-gate`.
- Document the new command in `AGENTS.md` and keep this plan as the roadmap.

2. PR #1037 shipped a feedback findings ledger to `pr:feedback-state`:

- Emit `findings[]` entries with stable fingerprints for feedback surfaces.
- Normalize inline review threads, root review comments, and top-level bot
  findings into one list.
- Preserve readiness semantics: `findings[]` explains feedback state but
  `pr:ready-state` remains the final all-clear gate.
- Extract separate entries from multi-finding bot review comments when they use
  table or severity-section formats.
- Include state fields for current-head, outdated, replied, unresolved, and
  blocking status.

3. Prompt-exclusion guidance now lives in
   `docs/pr-checklists/review-prompt-exclusions.md`:

- Translate recurring accepted/rejected review noise into explicit "do not
  flag" guidance.
- Keep prompt changes repo-local unless the user explicitly asks for an
  out-of-repo global skill edit.
- Route review agents from `AGENTS.md` and
  `docs/pr-checklists/recurring-review-patterns.md` to the exclusion checklist.
- Use `findings[]` from `pr:feedback-state` as the feedback-state source of
  truth before reviving older findings.

4. `agent:autoreview` can prepare richer repo-context review bundles:

- Add `pnpm agent:autoreview --prepare-bundle-dir <dir>`.
- Write changed paths, patch files, copied selected checklists, and the
  helper's `autoreview-prompt.md` into an out-of-worktree bundle directory.
- Add `--feedback-pr <number>` to include `pr:feedback-state` JSON for
  feedback-fix batches.
- Keep normal `pnpm agent:autoreview` behavior unchanged.

5. `pr:ready-state` can report a human break-glass override for externally
   blocked Codex approval:

- Accept a PR comment command from a human `OWNER`, `MEMBER`, or
  `COLLABORATOR`:
  `/pr-ready-override gate=codex-description-approval head=<full-head-sha> reason=<why this is safe>`.
- Apply it only to the Codex PR-description approval gate and only for the exact
  current head SHA.
- Report the gate as `overridden` with `readinessOverrides[]` evidence instead
  of pretending Codex approved.
- Keep checks, mergeability, requested changes, unresolved threads, and
  unreplied comments fully blocking.

## Next PR

- None currently planned.

## Later PRs

- None currently planned.

## Non-Goals

- Do not add an external review service before the repo-local gates carry the
  missing state.
- Do not weaken `pr:ready-state`; review materiality affects review depth, not
  final readiness.
- Do not make optional bot lag a required blocker unless branch protection makes
  it required for that PR.
