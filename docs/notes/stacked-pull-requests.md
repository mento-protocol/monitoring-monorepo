---
title: Stacked pull request workflow
status: active
owner: eng
canonical: true
last_verified: 2026-09-10
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Stacked pull request workflow

Use a small native GitHub stack when one reviewable change depends on another.
Native stacks remain opt-in after the first real-feature pilot. Independent
work stays in independent PRs. The [operating card](pr-operating-card.md) owns
author checks, reviews, publication, merge approval, and production closeout.
This runbook adds dependency handling to those steps.

## Select the work

Start with two layers, or three when the dependency is clear. Each layer needs
a coherent problem, its own tests and necessary docs, and an independently
reviewable diff. Shared helper followed by a consumer is a suitable pilot.
Large line counts alone do not justify a split. Generated fixtures and bulk
deletions can inflate a small conceptual change.

Record the ordered PRs, dependency reason, and any deployment or soak boundary
in the task plan. Keep a separate worktree and branch for each PR. Preserve the
issue workflow's existing one-PR ownership binding; record related PR links in
the issue instead of repeatedly rebinding ownership between layers. Do not
create synthetic PRs to test stacking. Do not use review-control changes,
production migrations, or a release requiring a soak as the first pilot.

Keep one coordination receipt for the batch. Record each tracker, per-layer
issue and full claim token, branch, worktree, published head, immediate parent
head, protection base SHA, and original scope baseline. Preserve these SHAs
after a parent merges or its branch disappears. Never refreeze a scope baseline
to absorb recovery work.

Before parallel implementation, compare shared paths across the planned layers
and independent stacks. Reserve ADR numbers through the coordinator. Land a
common generator or catalog-format repair once before dependent work branches;
keep each feature's generated catalog changes limited to its own entries.
Run trusted bootstrap before package-manager claim helpers, then claim before
substantive edits. Inspect package artifact, Compose, documentation-navigation,
and infrastructure-contract check requirements early. If new resources or CI
graph changes need an independent control audit, prepare its exact input and
owner handoff during planning. Reuse consent already given for that audit scope;
do not widen a blocking control in the feature session.

## Bind two bases

For each native layer, record:

- **Diff base:** its immediate parent branch (`baseRefName`). Use this for
  changed-file checks, author checks, scope baselines, and closeout review.
- **Protection base:** the stack target, usually `main`. Required checks and
  branch protections come from this branch.

Read native membership from GitHub. A PR body, branch naming convention, or
ordinary parent branch is insufficient to prove native membership. Resolve the
repository and both remotes before invoking repository tools. All layers must
belong to the same non-fork repository and form one linear chain. If membership
or either base cannot be verified, do not claim native stack readiness.

Ordinary dependent PRs remain supported. They have no native membership and
use their actual PR base for protection lookup. Diagnose missing CI against
that base and the workflow branch filters. Do not treat absent checks as a
pass, widen workflow filters for convenience, or assume GitHub's native stack
workflow behavior applies to an ordinary dependent PR. When required workflows
only target `main`, state in the child description: "Required CI will run after
this PR is retargeted to main." Keep that missing-CI state blocking. After the
parent squash-merges, verify the child diff, retarget it to `main`, and require
fresh CI on the resulting current head and main base.

## Publish with ship

1. Prepare and review child layers locally in parallel. Publish the bottom PR
   first and wait for its required CI and review feedback to settle. Then publish
   the reviewed descendants and register the initial chain together. Do not wait
   for main-filtered CI on an unregistered middle layer: registration must happen
   first. This reduces replay work; later parent changes can still require recovery. Prepare, validate, review, and publish each PR through operating-card steps
   2–5. Use its bound diff base. Open each PR ready for review with the normal
   template and its own validation evidence.
2. Re-read the repository, PR numbers, heads, and bases. Confirm the proposed
   chain contains exactly the intended PRs. Use `POST /repos/{owner}/{repo}/stacks` with
   `{"pull_requests": [<bottom-pr>, <next-pr>, <top-pr>]}` to link the
   explicit PR numbers in bottom-to-top order (omit the third for two layers). Do not
   let commit-based creation infer new PR boundaries from an existing branch.
3. Read back the resulting native membership, order, and protection base.
   Record the stack and dependency links in the PR descriptions. Check that
   each layer has the expected required CI and automatic reviews.
4. Verify workflow delivery after registration. A child opened before native
   membership may not receive main-filtered CI retroactively. A body edit only
   triggers workflows that subscribe to that event; it is not a CI repair.
   When an owned child lacks required runs, a coordinated close/reopen can
   deliver the supported lifecycle event. Before and after, verify the same
   repository, head, base, native membership and claim binding. Preserve any
   pending merge request; do not close a PR with one. Do not use dummy commits
   or broaden CI triggers. Missing required runs remain blocking.
5. Hand the verified ordered set to babysit. A successful link request alone
   does not establish readiness.

Use the current [GitHub API reference](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests-apis-and-webhooks)
for preview request shapes. If native creation is unavailable, keep the
published PRs as ordinary dependent PRs and report that native adoption remains
unverified. Do not install or upgrade CLI tooling implicitly to enable it.

## Watch with babysit-pr

Discover the full native stack at entry and after each parent or membership
change. Start a generic watcher with every open native member, not only the
parent. Its merged-PR path can finish before the repository hook runs, and its
branch-based dependent lookup can miss a child GitHub has already retargeted.
After `MERGED`, rediscover native membership and resume watches for every
remaining open member, even if the parent watcher has exited.
Run `pr:feedback-state` and `pr:ready-state` for each open layer. A
single PR's ready result describes that layer only. Report each PR's head,
bases, and blockers. Call the stack ready only when every open layer has clean
current feedback and required readiness on a stable membership snapshot.
The repository babysit hook enforces this through
`scripts/pr/pr-stack-ready-state.mjs`: it runs both projections for every open
layer, compares their stack snapshots, and rechecks the selected PR before
returning `PASS`. Unavailable, malformed, or changed snapshots return
`PENDING`. This helper is internal to the hook; manual watches must establish
the same complete and stable evidence. A verdict is a bounded observation:
GitHub does not provide an atomic snapshot of reviews and checks across PRs.
Topology revalidation detects changed membership and heads; it cannot rule out
a same-head review or check update after a layer was read. Recheck the selected
bottom layer immediately before an approved merge as described below.

A parent fix, base change, stack edit, or merge revokes dependent ready
verdicts. Re-read membership and every affected head and base. Reapply the
operating card's affected author checks and review requirements before a new
ready verdict. Include a cumulative integration check when the layers cross a
package or stateful-data boundary; layer-local review alone cannot establish
that integration behavior.

Never run `gh stack sync`, amend, or force-push while babysitting. Fetch before
every push. For ordinary stacks, merge an updated parent into a published
child and apply the operating card's base-integration review. Native stacks
require a linear chain; do not use a parent merge commit as an assumed native
restack. A parent fix can require coordinated restacking before merge. Handle
that outside the babysit loop with the operator or owning author, preserving
local work and the existing published-history boundaries. Re-read every
affected head and repeat affected validation and reviews afterward. GitHub
can also rebase the next remaining layer after a partial merge.
Treat that as a new head, invalidate old evidence, and reconcile the local
worktree before any edit or push. Preserve local changes and commits. If the
remote rewrite cannot be reconciled without discarding work or rewriting
published history, stop that mutation and report the exact conflict.

## Recover a failed child transition

After a parent merge, verify both the child's expected base and its head. A
retarget alone does not prove GitHub replayed the child. Compare ancestry,
mergeability and the published-parent boundary from the receipt. If GitHub
rewrites the child successfully, compare trees and patches before reusing local
validation. Fresh head-bound CI and review are still required.

If the child retains obsolete parent ancestry or conflicts, leave the normal
watch loop and give one coordinator ownership of recovery. The user's existing
conflict-repair authorization covers routine preparation and scoped publication;
it does not grant merge authority. Preserve the original worktrees and tips.
Use the local-only helper to prepare a separate candidate:

```bash
node scripts/pr/pr-stack-recover.mjs --old-parent <full-parent-sha> --old-head <full-child-sha> --new-base <full-base-sha> --worktree <new-absolute-path> --branch <new-candidate-branch>
```

The helper preserves pinned inputs, replays only the linear child range and
writes a recovery receipt under `<worktree>.receipt`, including an isolated
`comparison.git` reader that does not load source diff-driver configuration.
It never fetches, publishes or merges a PR. Resolve any reported conflict in the
candidate and preserve the conflict evidence. The receipt's `remaining` list
starts with the failed commit: after resolving it with `git cherry-pick --continue`,
replay the listed suffix explicitly. That command alone does not finish the range.
Refresh both review diffs against the final clean candidate after manual work.
A patch
already present in the new base may be skipped only with recorded equivalence
proof. Review the candidate against both the new base and the prior published
child. Distinguish ancestry repair from real shared-file integration. Regenerate
generated files with their owner command rather than hand-merging rows.

Run the union of affected checks once. Reuse evidence only when its reviewed
inputs and scope remain identical; compare independent audit inputs separately
from the unchanged control patch. Record any changed audit inputs honestly.
Before publication, fetch and re-read the live PR state, head, base, membership,
and protection branch. If they differ from the pinned recovery inputs, stop and
recompute. Publish the reviewed candidate with an exact old-head lease; use one
atomic push with an exact lease for each ref when rewriting dependent layers.
Do not publish after the PR has merged. Resume the full stack watch afterward.

## Merge only an approved bottom layer

The default handoff remains ALL_CLEAR. A user must explicitly approve the
specific PR merge. Native GitHub merging an upper layer also merges unmerged
layers below it. During this rollout, agents merge only the bottommost
unmerged PR, even if several PRs have approval. This avoids relying on a
selected-head SHA to bind other unmerged heads.

Immediately before an approved merge, read back the ordered membership and
confirm the selected PR is still bottommost. Re-run both readiness projections
on its exact head. Submit GitHub's asynchronous merge request with
`merge_method: "squash"` and `sha: "<verified-full-head-sha>"`. Abort on a
mismatch. On HTTP 202, poll the returned operation UUID to a terminal result, then verify
the PR's merge record. Acceptance of the request is not merge completion.
Do not resubmit while an operation is pending. HTTP 409 can mean an existing
operation has different options; inspect it before further action. Merge
operation records expire after 24 hours, so retain the terminal result and PR
merge record in the task evidence. Follow the current
[API reference](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests-apis-and-webhooks)
for the asynchronous endpoint and status response.

Coordinate batch merges one at a time, including independent stacks that touch
shared files. Before handing over a merge order, check prospective shared-path
conflicts. After each actual merge, integrate the resulting protection base and
re-evaluate remaining layers before proposing the next merge. Keep any deployment or soak boundary. Approval for one PR never grants
approval for another PR or production action. Ordinary PR merges continue to
use operating-card step 8 and ADR 0084.

Do not infer progress from a GitHub “merging” spinner. Read the PR state,
current head, protection branch, `mergeStateStatus`, required checks and pending
merge setting. `BEHIND` requires a base update, even when mergeability says
`MERGEABLE`. A pending merge setting records intent, not completion. Preserve
an existing request during authorized repair and verify its state afterward;
do not cancel or resubmit it merely to discover an operation UUID. A head update
may invalidate the request. Report that result rather than silently replacing it.
When strict freshness repeatedly blocks the final PR, pause other batch merges
until it lands. Confirm completion from the PR merge record and merged tree.

Cancelled duplicate CI runs are not source failures by themselves. Inspect the
exact head, workflow, run, attempt and job state, then identify any replacement
run. Keep required checks blocking until passing evidence satisfies the probe.
Do not edit source or retry a cancelled duplicate merely to change its display.

## Measure adoption after the pilot

The 2026-09-10 pilot used seven PRs across three stacks: #2361/#2362,
#2360/#2367 and #2358/#2366/#2369. Three initial parent merges retargeted
children without completing their rebases; a later #2366 → #2369 transition
rebased correctly with an identical tree. Independent stacks also conflicted in
the generated documentation catalog. These are distinct failure classes.
The #2369 pending merge completed after its stale base was repaired and new CI
passed, without cancelling or replacing the user's request.

The pilot proves grouping, ordering and a successful automatic transition. It
does not establish a net time saving or the cause of the failed transitions.
These observations sharpen the existing revalidation rule; they do not promise
that native stacks eliminate squash-merge conflicts. Keep the next pilot small
and compare it with an ordinary dependent change of similar scope.

Record parent corrections, manual replays, shared-file repairs, workflow-delivery
recoveries, repeated CI/review runs and setup failures separately. Successful
automatic rebases also create new heads and repeat CI/review, so do not attribute
all repeated checks to failed stacking. Preserve exact receipts rather than
estimating total time. Keep merge, deployment and live acceptance separate.
