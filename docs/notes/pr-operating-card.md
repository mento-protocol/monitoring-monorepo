---
title: PR Operating Card
status: active
owner: eng
canonical: true
last_verified: 2026-08-13
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# PR Operating Card

The one-card loop for taking an agent task from claim through any required
production closeout. It replaces the old habit of reading the full stack of
operating runbooks up front: work the steps here, and open an authority doc only
when a specific step's decision needs its depth. Each step is terse on purpose
and names its owning authority. Root [`AGENTS.md`](../../AGENTS.md) routes here
first; the hard invariants below and in the Non-negotiables section are binding
even when you never open an authority.

## The loop

1. **Claim.** Before substantive edits, claim from the ready queue:

   ```bash
   pnpm issue:claim --count 3 --agent codex
   ```

   Claiming moves the issue out of the ready queue; if you cannot continue,
   release it with `pnpm issue:release --issue <n>` (add `--needs-grooming`
   when clarity is missing; default restores `agent-ready`). Authority:
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
   cache-hits. Run `git fetch origin main` first: the base commit is part of
   that stamp, the hook fetches before it runs the gate, and a stamp warmed
   against a stale `origin/main` is invalidated by that fetch, so the push pays
   for the full gate a second time. It does not run `trunk fmt` — run
   `./tools/trunk fmt` (the checked-in launcher; a global `trunk` may not exist)
   before committing so the required Code Quality CI stays green. The gate never
   deploys and never applies Terraform. It **refuses package-script,
   package-manager, or lockfile changes until their lifecycle risk is reviewed
   and explicitly acknowledged** — do not bypass the refusal; review the surface
   and pass `--allow-package-script-changes`. Do not run a competing dashboard
   server or browser suite alongside the gate; a second `--run` gate is handled
   for you — it takes a machine-wide lock and queues behind the first, naming
   the holder while it waits. Background the `--run` gate and the `git push`; a
   600s foreground kill discards the freshness stamp. Authority:
   [`agent-quality-gate-mechanics.md`](agent-quality-gate-mechanics.md).

4. **Autoreview.** Freeze the scope baseline first — the initial request,
   target/owner, changed-file set, and non-test changed-line count — as the
   reference Babysit (step 6) checks new additions against. Then, for a
   non-trivial completed batch, run the closeout review. Outside an active
   Codex session — the standalone helper or `--engine claude` — a bare
   `pnpm agent:autoreview` is the closeout, matching the `ship` skill and root
   [`AGENTS.md`](../../AGENTS.md). Inside an active Codex session, a bare
   invocation silently selects the local deterministic engine — the `ship`
   skill's bare closeout is NOT sufficient there; use the prepared-bundle
   fresh-context flow so a separate reviewer inspects every pass:

   ```bash
   pnpm agent:autoreview --prepare-bundle-dir <dir>  # publish the review bundle
   pnpm agent:autoreview --verify-bundle-dir <dir>   # pre-review manifest check
   pnpm agent:autoreview --verify-bundle-dir <dir> \
     --expected-bundle-manifest <digest-from-pre-review-check>  # post-review check
   ```

   Prepare the bundle, run `--verify-bundle-dir` immediately before review,
   retain its printed digest outside the bundle, and pass that digest to the
   post-review check above so bundle replacement or drift during review
   cannot go undetected. Autoreview reviews the complete branch-local
   target without truncation, but it is **source review only**: it runs no
   tests and proves no behavior, so the mapped gate, browser,
   generated-artifact, and runtime checks still apply. One fresh-context
   reviewer must inspect every prepared-bundle pass, with manifest
   verification before and after review. Capture, bundle-integrity,
   sensitive-input, runtime-trust, and explicitly-selected-unavailable-engine
   failures all fail closed. For merge-review provenance, the `babysit-pr`
   skill binds `origin`, the immutable base, and protected `main` before any
   adapter call. It invokes an absolute wrapper and explicit helper through
   `/bin/bash`, never through the package manager. If either review axis changes
   `scripts/agent-autoreview.sh`, `scripts/agent-autoreview.mjs`, or
   `scripts/agent-autoreview-core.mjs`, use the last independently reviewed
   compatible pre-change runtime. After every semantic review and bound
   postverification, run the sequential suite through `/bin/bash` as separate
   behavior evidence. Authority:
   [`agent-quality-gate-mechanics.md`](agent-quality-gate-mechanics.md).

5. **Ship.** Open the PR through the `ship` skill on every surface, including
   hosted sessions — do not hand-roll PR creation. The description starts with
   `## The Problem` (at most three plain-language bullets) then `## The
Solution` (approach before implementation detail). PRs open **ready for
   review, never as drafts**; use draft only when the user asks or required
   validation is intentionally pending, and state that reason in the body. Link
   the issue with `Closes #N` **only when the issue's Done means is fully
   satisfied**; otherwise use `Refs #N`. For issue-backed work, once the PR is
   open, run `pnpm issue:review --pr <pr> --issue <issue>` to move the issue
   out of `agent-active` and into review. Authority:
   [`agent-issue-workflow.md`](agent-issue-workflow.md).

   **Bind the checkout to the target before publishing.** Resolve the PR's head
   repository, `headRefName`, and `headRefOid`; require a configured remote that
   serves that head repository and a local `HEAD` equal to that OID; push with an
   explicit `git push <head-remote> HEAD:<headRefName>` refspec, never an implicit
   target or the local branch name. Re-read the PR afterwards and require the new
   `headRefOid` to equal local `HEAD` before treating anything as published. A
   fork checkout uses its parent as `BASE_REPO`; never substitute a fork's
   `origin` for its parent, and stop if the head repository has no matching push
   remote.

6. **Babysit.** Run the `babysit-pr` skill. Sweep every feedback surface:
   top-level comments, review bodies, inline comments and threads, annotations,
   and failing logs. **Reply before resolving**, on the correct surface, in
   these exact forms:
   - `Fixed in <commit> — <what changed>`
   - `Won't fix: <technical reason why>`

   After finding one instance of a hazard, audit its sibling surfaces — bots
   sample, they do not enumerate; review is a batch-boundary verifier, not the
   inner edit loop. Never force-push or amend while babysitting,
   and `git fetch` before every push because reviewers push mid-session. Check
   new additions against the scope baseline frozen at step 4; classify each as
   in-scope, follow-up, or stop; **file a GitHub issue before deferring any valid
   follow-up** and link it from the PR's `## Deferrals` section. Warn as the
   diff approaches twice the baseline. Do not pause solely for cycle count
   before five review-triggered patch cycles are complete; pause for
   reclassification before starting a sixth. Authority:
   [`agent-issue-workflow.md`](agent-issue-workflow.md) for the deferral and
   issue-lifecycle rules.

   The same checkout binding as step 5 applies before any blocker fix mutates
   files: clean worktree, local `HEAD` equal to the resolved `headRefOid`,
   explicit push refspec, re-verified OID afterwards. If binding fails, move to a
   clean dedicated checkout rather than editing an unbound one.

   **Bound the watch.** One hour of wall clock by default unless the user set a
   different budget, and roughly three attempts at the same recurring item before
   handing it back. `pnpm pr:ready-state --watch` polls until ready, merged, or
   closed, so a permanently blocked PR otherwise consumes the session. At the
   deadline, report where the PR stands and stop or escalate.

   **Stacked PRs are the normal case here**, typically after a `/ship` batch.
   When a watched PR merges or a base moves, re-evaluate every open PR that
   depended on it — including ones the user never named — before calling a batch
   healthy. A squash merge rewrites the commits a dependent branch still carries,
   so expect conflicts there. A ready verdict on a still-open PR is revocable:
   any change to it or its base returns it to full evaluation against the new
   head.

7. **Ready-state.** Before signalling all-clear, run both projections with
   `<BASE_REPO>` resolved from the PR URL — as the `babysit-pr` skill does —
   so a fork PR or a switched checkout cannot bind the query to the wrong
   repository:

   ```bash
   pnpm --silent pr:feedback-state --pr <number> --repo <BASE_REPO> --json
   pnpm pr:ready-state --pr <number> --repo <BASE_REPO> --json
   ```

   Run them in that order and preserve the two-projection contract: the
   feedback ledger must be clean **first**, then the subsequent current-head
   `pr:ready-state` must report ready — including the current-head
   `chatgpt-codex-connector[bot]` PR-description approval, unless a documented
   human break-glass comment applies:
   `/pr-ready-override gate=codex-description-approval head=<full-head-sha>
reason=<why this is safe>`. Do not block on slow optional bots that branch
   protection does not require, and do not post routine or duplicate `@codex
review` requests. Authority:
   [`pr-ready-state.md`](pr-ready-state.md).

8. **Merge hygiene.** **Never merge a PR without the user's explicit, direct
   approval of that specific merge.** Green CI, bot approvals, a READY
   ready-state, and "ship it" do not authorize a merge. Drive the PR to ready,
   present the evidence, then stop and ask. If the merge itself satisfies Done
   means, sync the issue state and workboard afterward per
   [`agent-issue-workflow.md`](agent-issue-workflow.md). If live proof remains,
   continue to production closeout first.

9. **Production closeout when required.** When Done means includes deployed or
   live behavior, merge is an intermediate state. Monitor the owning deployment
   to a terminal result, obtain any separate apply or promotion approval, and
   run the owning package's production checks. Report merge, deployment, and
   live proof as separate facts; a successful workflow alone does not prove the
   runtime behavior. Use `Refs #N` instead of `Closes #N` when proof can happen
   only after merge. Close the issue and run `pnpm issue:board sync` only after
   the live acceptance criteria pass.

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
  foreground that a kill would truncate, and do not start a dashboard server or
  browser suite alongside a gate. A second `--run` gate queues on the gate's own
  machine-wide lock instead of racing.
- **Secrets are IaC-owned and Terraform apply needs human approval** — plan
  first, never one-off `gh secret set` / `vercel env add` /
  `gcloud secrets versions add`.

## Authority map

| Step                     | Authority doc                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Claim, defer, merge-sync | [`agent-issue-workflow.md`](agent-issue-workflow.md)                                                           |
| Gate, autoreview         | [`agent-quality-gate-mechanics.md`](agent-quality-gate-mechanics.md)                                           |
| Ready-state              | [`pr-ready-state.md`](pr-ready-state.md)                                                                       |
| Docs and drift           | [`../context-standards.md`](../context-standards.md)                                                           |
| Ship                     | steps 2-9 here; entry points in [`codex-agent-skills.md`](codex-agent-skills.md#claude-global-store-shadowing) |
| Babysit                  | steps 6-7 here; entry points in [`codex-agent-skills.md`](codex-agent-skills.md#claude-global-store-shadowing) |
| UI visual evidence       | [`dashboard-verification.md`](dashboard-verification.md)                                                       |
| Production closeout      | [`../deployment.md`](../deployment.md) and the owning package runbook                                          |
