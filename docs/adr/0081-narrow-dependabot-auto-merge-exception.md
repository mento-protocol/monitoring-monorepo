---
title: Narrow Dependabot auto-merge exception
status: active
owner: eng
canonical: true
last_verified: 2026-08-31
scope: ci/process
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0081 — Narrow Dependabot auto-merge exception

**Status:** Accepted (Aug 2026), in force.
**Scope:** ci/process

## Context

[ADR 0083](0083-github-ui-operator-merge.md) routes ordinary merges directly
through GitHub after current-head all-clear and explicit approval. Every routine
dependency update would otherwise wait for the same operator-authorized merge after
all required checks pass.

The repository already limits Dependabot to the GitHub Actions ecosystem.
Dependabot groups GitHub-owned `actions/*` minor and patch updates separately,
delays routine releases for seven days, and keeps major updates, other
publishers, and review-sensitive actions on the operator-authorized path. This gives one
small update class a stable machine-checkable boundary. The user accepted an
automatic merge for that class. The user did not authorize a general automatic
merge path.

A write job on `pull_request_target` is not suitable. Dependabot-triggered
`pull_request_target` runs receive a read-only token. Expanding that design
would also combine pull-request classification and repository write authority
in one event surface. A `workflow_run` workflow loads from the default branch
and can hold write authority after an unprivileged upstream run completes. Its
upstream payload and artifacts remain untrusted inputs.

## Decision

Add one unattended merge exception for routine GitHub-owned `actions/*` updates
in the `actions-minor-patch` Dependabot group. Keep every other merge on the
operator-authorized GitHub path in ADR 0083.

Use two workflows as one pinned security boundary:

1. `.github/workflows/dependabot-auto-merge-candidate.yml` runs on
   `pull_request` for `opened` and `synchronize`. It has only read permissions.
   It checks the repository, actor, triggering actor, PR author, base, same-repo
   head, exact Dependabot group branch, and first run attempt. The pinned
   `dependabot/fetch-metadata` action must report the `github_actions`
   ecosystem, root directory, `main` target, `actions-minor-patch` group,
   minor or patch update, and no maintainer changes. Every dependency must use
   the GitHub-owned `actions/*` namespace. The list must not include
   `actions/create-github-app-token`. The workflow does not check out code,
   read secrets, or write repository state. Its concurrency key binds the head
   repository and PR number before cancellation can occur.
2. `.github/workflows/dependabot-auto-merge.yml` runs on completion of the
   named classifier. It treats the event as an untrusted signal. It re-reads
   the workflow identity and run by ID. It requires the exact repository,
   workflow ID, path, name, event, successful conclusion, first attempt,
   Dependabot actor and triggering actor, group branch, and 40-character head
   SHA. It reads the first attempt's jobs with pagination. Every returned page
   must be an object with a safe integer `total_count` and a `jobs` array. The
   shared `total_count` must equal the flattened job count. Exactly one
   `classify` job must exist, and the event, metadata, and eligibility steps
   must have succeeded.
3. The writer looks up exactly one open same-repository PR by owner and head
   branch. It binds the PR to the run head, `main`, Dependabot author, and
   non-draft state. The pinned metadata action derives `maintainer-changes`
   from the exact case-sensitive `Maintainer changes` marker in the PR body.
   The writer applies that same rule to the current authoritative PR body. It
   reads the complete issue-event history with pagination. Every page must be
   an array, and every event must be an object with a string event type. Any
   `closed` or `reopened` event refuses the merge. A recorded human close
   therefore remains a durable veto if someone reopens the same PR at the same
   head. The writer also reads every commit and file with pagination. Every
   commit must be verified and Dependabot-authored. GitHub caps the pull-request
   commit endpoint at 250, so the writer rejects a reported count above 250 and
   requires the returned count to match exactly. Every file must be a modified
   top-level workflow YAML file. The classifier and writer files are always
   excluded from this lane.
4. The writer refuses when `main` has a merge queue. It waits for every
   required check with `gh pr checks --required --watch --fail-fast`, then
   verifies a non-empty passing required-only projection. The wait is an
   untrusted delay. The writer repeats the complete workflow, run, job, PR,
   head, maintainer-change body, close-history, commit, file, and queue proof
   after it.
5. The writer calls `PUT /repos/{owner}/{repo}/pulls/{number}/merge` with the
   verified head SHA and squash method. This synchronous endpoint cannot
   enqueue or create an auto-merge request. Head-repository-and-branch-scoped
   concurrency cancels a stale writer when a newer run for the same Dependabot
   branch starts. A fork that reuses the branch name has a separate group.

The writer never checks out code, downloads artifacts, restores caches, or
executes pull-request content. `pnpm tf:test` pins the parsed semantics of both
workflows. The autofix trust checker continues to reject every
`pull_request_target` workflow and requires the writer's explicit
`sentry-autofix/*` exclusion.

The writer uses the repository's built-in `GITHUB_TOKEN` for authoritative
reads and the final merge write. The workflow passes that token through
`GH_READ_TOKEN` and `FINAL_MERGE_TOKEN`. This keeps a testable code boundary:
all evidence reads must use the read variable, and only the synchronous
exact-head REST request may use the final-write variable. It does not provide
credential separation because both variables resolve to `github.token`.

The repository accepts this residual risk for a small, mostly
single-contributor project and this bounded update class. It will not add a
`merge-operators` Team, credential broker, dedicated merge App, protected merge
Environment, or controlled lifecycle ruleset for this lane. Issue #2091 was
closed as not planned after this decision.

## One-time cutover

The retired workflow used native auto-merge. Its standing requests can outlive
the workflow version that created them. Complete this cutover when PR #2137 is
merged:

1. Disable the legacy `dependabot-auto-merge.yml` workflow on GitHub and verify
   that its state is inactive. This prevents a new legacy run during cutover.
2. Require every queued or running legacy run to reach a terminal state.
3. List every open Dependabot PR with a limit of 1,000 and include
   `autoMergeRequest` in the result. Require every value to be `null`. If a
   value is not `null`, disable auto-merge for that PR and repeat the audit.
4. Merge PR #2137 immediately through the normal operator-authorized GitHub path.
5. Enable the replacement workflow on GitHub and verify that its state is
   active.
6. Repeat the open-PR audit after the merge. Disable any request that appeared
   before the legacy workflow stopped, then repeat the audit until every value
   is `null`.

The pre-merge and post-merge audits close the transition from standing native
requests to synchronous exact-head merge requests. They do not add a recurring
operator step after the cutover is complete.

## Alternatives considered

- **Keep every Dependabot merge manual.** This preserves one policy for every
  PR. Rejected because the user chose automatic merge for the bounded routine
  group and accepted its stated residuals.
- **Use one `pull_request_target` workflow.** Rejected because Dependabot runs
  do not receive the required write token and because the design combines
  untrusted PR classification with the write surface.
- **Pass classifier outputs or artifacts to the writer.** Rejected because
  pull-request-controlled outputs and artifacts would become inputs to a
  privileged workflow. The writer re-reads authoritative GitHub state instead.
- **Use native auto-merge to wait for required checks.** Rejected. It creates a
  standing request that can survive a later trusted maintainer push. A merge
  queue activated after the queue read can also turn the CLI request into an
  enqueue. The synchronous exact-head REST endpoint has neither behavior.
- **Add a separate GitHub-side merge identity and lifecycle controls.** Rejected
  as disproportionate for this repository and update class. The rejected design
  included a `merge-operators` Team, credential broker, dedicated merge App,
  protected merge Environment, and controlled lifecycle ruleset.
- **Auto-merge every Dependabot update.** Rejected. Major, security,
  maintainer-changed, other-ecosystem, non-`actions/*`, and
  `actions/create-github-app-token` updates retain human review and an
  operator-authorized merge. That path includes load-bearing gate actions such as
  `re-actors/alls-green` and credential actions such as
  `google-github-actions/auth`.

## Consequences

- Routine GitHub-owned `actions/*` minor and patch groups can merge after all
  required checks pass. The seven-day cooldown applies before Dependabot opens
  the version update. Security updates bypass cooldown and remain outside this
  group.
- The exact-head REST request rejects a later push. The complete proof repeated
  after required-check waiting also rejects changed classifier, PR, commit,
  file, or maintainer-change body state before the write.
- The writer refuses while `main` has a merge queue. A future queue rollout
  must keep this lane disabled until a new reviewed design defines its queue
  behavior. The final endpoint cannot enqueue, so a queue activated after the
  last read cannot create deferred merge state.
- The REST payload pins the head but cannot pin the base branch. The final
  complete proof checks `main` immediately before the write. A retarget in the
  remaining request window can still change the target branch.
- The writer waits for required checks for at most 60 minutes. A longer or
  failed check leaves the PR open and requires a later eligible classifier run.
- A merge made with the built-in `GITHUB_TOKEN` does not start `push` event
  workflows. Required pull-request checks are the final automated evidence for
  this lane. The repository accepts this behavior for the bounded routine
  group.
- The writer identifies the classifier by its stable GitHub workflow ID, path,
  run shape, and job shape. A future classifier policy change must drain all
  in-flight runs from the prior version or add an explicit runtime version
  binding before the new writer becomes active.
- Closing an eligible PR is a durable human veto on every later authoritative
  read. Reopening it, including at the same head, does not restore automatic
  eligibility. Dependabot must open a new eligible PR before this lane can
  merge that update automatically.
- The final issue-event read is the last authoritative read before the merge
  request. The REST merge endpoint cannot pin issue-event history. A close and
  reopen after that read but before the write remains a narrow residual race.
- ADR 0083 governs every ordinary, major, security, maintainer-changed,
  excluded-publisher, and other-ecosystem merge. This ADR qualifies it with one
  named machine exception. It does not authorize an agent session to merge a
  PR.

## Evidence

- `.github/dependabot.yml` defines the group, exclusions, and seven-day
  cooldown.
- `.github/workflows/dependabot-auto-merge-candidate.yml` and
  `.github/workflows/dependabot-auto-merge.yml` enforce the two-stage boundary.
- `scripts/production-infra-identity-contract/workflow-inventory.mjs` pins both
  parsed workflows and grants paired merge write scopes only to the exact
  writer. Its fixture suite rejects changes to either workflow and incomplete
  pairs.
- `scripts/workflows/check-autofix-ci-trust.mjs` rejects
  `pull_request_target` and checks the writer's `workflow_run` autofix
  exclusion.
- Historical PR #1872 showed that a Dependabot `pull_request` run can have an
  empty `pull_requests` list while its run head SHA still matches the PR head.
  The writer therefore performs a strict owner-and-head PR lookup instead of
  trusting that list.
- PR #2137 records the implementation and focused validation. Issue #2091 was
  closed as not planned after the repository accepted the remaining
  `GITHUB_TOKEN` risk and declined separate lifecycle controls.
