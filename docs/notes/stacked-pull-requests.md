---
title: Stacked pull request workflow
status: active
owner: eng
canonical: true
last_verified: 2026-09-09
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Stacked pull request workflow

Use a small native GitHub stack when one reviewable change depends on another.
Native stacks are opt-in while the real-feature pilot is incomplete. Independent
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

1. Prepare, validate, review, and publish each PR through operating-card steps
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
4. Hand the verified ordered set to babysit. A successful link request alone
   does not establish readiness.

Use the current [GitHub API reference](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests-apis-and-webhooks)
for preview request shapes. If native creation is unavailable, keep the
published PRs as ordinary dependent PRs and report that native adoption remains
unverified. Do not install or upgrade CLI tooling implicitly to enable it.

## Watch with babysit-pr

Discover the full native stack at entry and after each parent or membership
change. Run `pr:feedback-state` and `pr:ready-state` for each open layer. A
single PR's ready result describes that layer only. Report each PR's head,
bases, and blockers. Call the stack ready only when every open layer has clean
current feedback and required readiness on a stable membership snapshot.

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

After each merge, re-evaluate remaining layers before proposing the next
merge. Keep any deployment or soak boundary. Approval for one PR never grants
approval for another PR or production action. Ordinary PR merges continue to
use operating-card step 8 and ADR 0084.

## Complete the real-feature pilot

Use the next authorized low-risk helper-and-consumer change. Record its actual
PRs and evidence in the rollout issue. Capture required CI selection,
automatic review delivery, local worktree behavior, a necessary parent fix if
one occurs, and the child transition after a separately approved parent merge.
Do not manufacture a fix or merge approval to satisfy the checklist. Mark
unexercised cases explicitly.

Record review turnaround, repeated check runs, manual rebase or reconciliation
work, and agent mistakes. Compare with an ordinary dependent change of similar
scope; report the limits of that comparison. Expand use only after reviewing
that evidence. Until then, report tooling shipped and live pilot outstanding
as separate results. Keep the rollout issue open when live acceptance remains.
