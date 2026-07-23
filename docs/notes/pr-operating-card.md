---
title: PR Operating Card
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# PR Operating Card

The one-card loop for taking an agent task from claim to merge. It replaces the
old habit of reading the full stack of operating runbooks up front: work the
steps here, and open an authority doc only when a specific step's decision needs
its depth. Each step is terse on purpose and names its owning authority. Root
[`AGENTS.md`](../../AGENTS.md) routes here first; the hard invariants below and
in the Non-negotiables section are binding even when you never open an
authority.

## The loop

1. **Claim.** Before substantive edits, claim from the ready queue:

   ```bash
   pnpm issue:claim --count 3 --agent codex
   ```

   Claiming moves the issue out of the ready queue; if you cannot continue,
   release it with `pnpm issue:release` and choose `agent-ready` versus
   `needs-grooming` from how much clarity remains. Authority:
   [`agent-issue-workflow.md`](agent-issue-workflow.md).

2. **Implement.** Work in a dedicated per-PR worktree and unique branch, never
   directly on `main`. Keep the diff surgical: touch only what the task needs,
   match existing style, do not smuggle in adjacent cleanup. Read the scoped
   `AGENTS.md` for the package you are editing (see the root Package Routing
   Index) before touching it. A change to stateful data flow across indexer,
   GraphQL, or UI first applies
   [`../pr-checklists/stateful-data-ui.md`](../pr-checklists/stateful-data-ui.md);
   an architecture change that constrains future work records an ADR in the
   same PR. When a change adds or alters a command, script, env var, hook, or
   ordered runbook, audit every live entry point and runbook in the same PR.
   Before touching or moving docs, read
   [`../context-standards.md`](../context-standards.md).

3. **Gate.** Before opening or updating an agent-authored PR, inspect then run
   the mapped local-only checks:

   ```bash
   pnpm agent:quality-gate          # inspect mapped commands and checklists
   pnpm agent:quality-gate --run    # execute the safe local mapped commands
   ```

   `--run` maps changed paths to the safe local checks (lint, typecheck, tests,
   browser suite) and stamps freshness so a later pre-push `--skip-if-fresh`
   cache-hits. It does not run `trunk fmt` — run `trunk fmt` (or Prettier)
   before committing so the required Code Quality CI stays green. The gate never
   deploys and never applies Terraform. It **refuses package-script,
   package-manager, or lockfile changes until their lifecycle risk is reviewed
   and explicitly acknowledged** — do not bypass the refusal; review the surface
   and pass the acknowledgement flag. Do not run a competing dashboard server,
   browser suite, or second gate in the same worktree. Background the `--run`
   gate and the `git push`; a 600s foreground kill discards the freshness stamp.
   Authority:
   [`agent-quality-gate-mechanics.md`](agent-quality-gate-mechanics.md).

4. **Autoreview.** For a non-trivial completed batch:

   ```bash
   pnpm agent:autoreview                       # non-trivial completed batch
   pnpm agent:autoreview --verify-bundle-dir <dir>  # pre-review manifest check
   ```

   Run `--verify-bundle-dir` immediately before review, retain its printed
   digest outside the bundle, and pass that digest to the post-review check.
   Autoreview reviews the complete branch-local target without truncation, but
   it is **source review only**: it runs no tests and proves no behavior, so the
   mapped gate, browser, generated-artifact, and runtime checks still apply. One
   fresh-context reviewer must inspect every prepared-bundle pass, with manifest
   verification before and after review. Capture, bundle-integrity,
   sensitive-input, runtime-trust, and explicitly-selected-unavailable-engine
   failures all fail closed. Authority:
   [`agent-quality-gate-mechanics.md`](agent-quality-gate-mechanics.md).

5. **Ship.** Open the PR through the `ship` skill on every surface, including
   hosted sessions — do not hand-roll PR creation. The description starts with
   `## The Problem` (at most three plain-language bullets) then `## The
Solution` (approach before implementation detail). PRs open **ready for
   review, never as drafts**; use draft only when the user asks or required
   validation is intentionally pending, and state that reason in the body. Link
   the issue with `Closes #N` **only when the issue's Done means is fully
   satisfied**; otherwise use `Refs #N`.

6. **Babysit.** Run the `babysit-pr` skill. Sweep every feedback surface:
   top-level comments, review bodies, inline comments and threads, annotations,
   and failing logs. **Reply before resolving**, on the correct surface, in
   these exact forms:
   - `Fixed in <commit> — <what changed>`
   - `Won't fix: <technical reason why>`

   After finding one instance of a hazard, audit its sibling surfaces — bots
   sample, they do not enumerate; review is a batch-boundary verifier, not the
   inner edit loop. Never force-push or amend while babysitting,
   and `git fetch` before every push because reviewers push mid-session. Freeze
   the review baseline (user request, target/owner, changed files, non-test
   changed lines) before the first pass; classify each addition as in-scope,
   follow-up, or stop; **file a GitHub issue before deferring any valid
   follow-up** and link it from the PR's `## Deferrals` section. Warn as the
   diff approaches twice the baseline, and pause for reclassification after two
   review-triggered patch cycles rather than starting a third. Authority:
   [`agent-issue-workflow.md`](agent-issue-workflow.md) for the deferral and
   issue-lifecycle rules.

7. **Ready-state.** Before signalling all-clear, run both projections:

   ```bash
   pnpm --silent pr:feedback-state --pr <number> --json
   pnpm pr:ready-state --pr <number> --json
   ```

   Run them in that order and preserve the two-projection contract: the
   feedback ledger must be clean **first**, then the subsequent current-head
   `pr:ready-state` must report ready — including the current-head
   `chatgpt-codex-connector[bot]` PR-description approval, unless a documented
   break-glass signal applies. Do not block on slow optional bots that branch
   protection does not require, and do not post routine or duplicate
   `@codex review` requests. Authority:
   [`pr-ready-state.md`](pr-ready-state.md).

8. **Merge hygiene.** **Never merge a PR without the user's explicit, direct
   approval of that specific merge.** Green CI, bot approvals, a READY
   ready-state, and "ship it" do not authorize a merge. Drive the PR to ready,
   present the evidence, then stop and ask. After merge, sync the issue state
   and workboard per [`agent-issue-workflow.md`](agent-issue-workflow.md).

## Non-negotiables

These bind regardless of which step you are on:

- **Never merge without explicit approval** for that specific merge (step 8).
- **Reply before resolving** every feedback item, in the two forms above; a
  clear reply stops re-raising bots from looping.
- **`Closes #N` only when Done means is fully met**, else `Refs #N`.
- **Knowingly deferred work needs a GitHub issue first**, linked from
  `## Deferrals`. An evidence-backed won't-fix is not a deferral.
- **Package-script, package-manager, and lockfile changes require explicit
  acknowledgement** through the gate; never bypass the refusal.
- **Background long `--run` gates and pushes**; do not run them in a 600s
  foreground that a kill would truncate, and do not start a second gate or
  dashboard suite in the same worktree.
- **Secrets are IaC-owned and Terraform apply needs human approval** — plan
  first, never one-off `gh secret set` / `vercel env add` /
  `gcloud secrets versions add`.

## Authority map

| Step                     | Authority doc                                                        |
| ------------------------ | -------------------------------------------------------------------- |
| Claim, defer, merge-sync | [`agent-issue-workflow.md`](agent-issue-workflow.md)                 |
| Gate, autoreview         | [`agent-quality-gate-mechanics.md`](agent-quality-gate-mechanics.md) |
| Ready-state              | [`pr-ready-state.md`](pr-ready-state.md)                             |
| Docs and drift           | [`../context-standards.md`](../context-standards.md)                 |
| Ship, babysit            | `ship` and `babysit-pr` skills                                       |
