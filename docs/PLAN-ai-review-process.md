---
title: AI Review Process Integration Plan
status: draft
owner: eng
canonical: false
---

# AI Review Process Integration Plan

This plan captures the Cloudflare AI code-review integration ideas that fit this
repo's current agent workflow. It is intentionally non-canonical: treat it as a
roadmap and verify current repo behavior before copying anything into AGENTS,
skills, or gates.

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

## Next PR

Teach `agent:autoreview` to prepare a richer review bundle directory with
changed paths, patch files, selected checklists, and any feedback ledger.

## Later PRs

- Consider a human-only break-glass readiness override that is reported by
  `pr:ready-state`, not silently treated as all-clear.

## Non-Goals

- Do not add an external review service before the repo-local gates carry the
  missing state.
- Do not weaken `pr:ready-state`; review materiality affects review depth, not
  final readiness.
- Do not make optional bot lag a required blocker unless branch protection makes
  it required for that PR.
