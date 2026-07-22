---
name: babysit-pr
description: '[repo-skill] Monitor monitoring-monorepo PR readiness using the repo''s shared pr:ready-state probe, fix required CI/review blockers, reply to review comments, and stop only at ALL_CLEAR, MERGED, CLOSED, or a stated deadline. Use when the user says "babysit PR", "monitor CI", "watch reviews", or asks to keep a PR green.'
title: Babysit PR Skill
status: active
owner: eng
canonical: true
last_verified: 2026-07-22
doc_type: skill
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# Babysit PR

Use this repo-local adapter when the user's personal `babysit-pr` skill or
Claude `Monitor` tool is not available. The readiness source of truth is the
repo command, not a hand-rolled interpretation of green checks.

## Surface Detection

Pick the path before the first GitHub call; the full gh→MCP mapping and the
reasoning live in
[`docs/notes/github-tooling-surfaces.md`](../../../docs/notes/github-tooling-surfaces.md).

- **Local session or Codex Cloud** (no `CLAUDE_CODE_REMOTE`): gh works. Use
  the sections below as written — `pnpm pr:ready-state` is the readiness
  source of truth.
- **Claude cloud session** (`CLAUDE_CODE_REMOTE` set): the platform's GitHub
  credential proxy blocks gh's API paths regardless of tokens or allowlist
  entries, and `pnpm pr:ready-state` cannot run. Follow
  [Cloud Watch Loop](#cloud-watch-loop-claude-cloud-sessions) instead. Do not
  trust `gh auth status` as a capability signal; only a successful
  `gh api repos/<owner>/<repo>` call proves the gh path works.

## Resolve Target

If no PR number is provided, resolve the current branch PR. For every target,
capture the PR URL, head repository, branch, and commit:

```bash
gh pr view --json number,url,title,headRefName,headRefOid,baseRefName,headRepository,headRepositoryOwner,isCrossRepository
```

For an explicit target, accept a bare number or PR URL. Derive and preserve
`BASE_REPO` (`owner/name`) from the resolved PR URL before changing checkouts.
After that initial resolution, pass `--repo <BASE_REPO>` to every `gh pr view`,
feedback-state, and ready-state call—even when the PR began in the current
repository.

Before any blocker fix mutates files or Git history, bind the checkout to that
resolved target:

- Select `HEAD_REMOTE` only after verifying that its repository equals
  `headRepository.nameWithOwner`. For a cross-repository PR, use a dedicated
  checkout with the fork as `HEAD_REMOTE`; keep a separately verified
  `BASE_REMOTE` for `BASE_REPO` and never swap their roles.
- `git status --porcelain` must be empty and `git rev-parse HEAD` must equal
  the resolved `headRefOid`. If either differs, stop or switch to a clean,
  dedicated checkout at the PR head before editing.
- Preserve `BASE_REPO`, `BASE_REMOTE`, `HEAD_REMOTE`, and `headRefName` for the
  full session. Fetch `baseRefName` only from `BASE_REMOTE`.

After each fix commit, push explicitly with `git push <HEAD_REMOTE>
HEAD:<headRefName>`, re-resolve with `gh pr view <number> --repo <BASE_REPO>`,
and require the new `headRefOid` to equal local `HEAD` before returning to the
watch loop. Never rely on the current branch name, implicit push target, or
repository inferred from the active checkout.

Before the first review pass, freeze the request, target/owner, changed files,
and non-test changed-line count as the scope baseline. Classify later additions
as in-scope, follow-up, or stop; create an issue before deferring valid work.

## Feedback and Watch Loop

Use the normalized feedback projection instead of ad hoc API scraping:

```bash
pnpm --silent pr:feedback-state --pr <number> --repo <BASE_REPO> --json
```

Inspect `requiredFeedbackBlockers`, `unresolvedReviewThreads`,
`unrepliedRootReviewComments`, `blockingTopLevelBotComments`,
`topLevelBotComments`, and `findings`. Informational deployment/status bot
comments are context, not blockers.

Use the shared readiness probe for the final decision:

```bash
pnpm pr:ready-state --pr <number> --repo <BASE_REPO> --json
```

For a foreground wait, use:

```bash
pnpm pr:ready-state --pr <number> --repo <BASE_REPO> --watch --compact --until-ready
```

Keep a practical one-hour wall-clock deadline unless the user asked for a
different budget. Report state changes only when something becomes actionable:
required CI failure, merge conflict, unreplied review comment, unresolved
thread, Codex approval missing after current-head review, all-clear, merged, or
closed.

## Cloud Watch Loop (Claude cloud sessions)

Do not foreground-poll and never sleep-poll. Instead:

1. Subscribe to PR events (`subscribe_pr_activity`) so comments, reviews, and
   CI failures arrive as webhook activity.
2. Arm a scheduled self check-in (for example `send_later`, roughly an hour
   out) before ending the turn; webhook events do not cover CI success, new
   pushes, or merge-conflict transitions. Re-arming is bounded by the same
   babysitting deadline as the local loop (one hour unless the user set a
   different budget): at the deadline, report the current state and stop or
   escalate instead of re-arming silently. Stop when the PR is merged or
   closed.
3. On every event or check-in, run the MCP emulation of the readiness sweep
   (tool mapping in
   [`docs/notes/github-tooling-surfaces.md`](../../../docs/notes/github-tooling-surfaces.md)):
   - PR state via `pull_request_read` method `get`, including
     `mergeable_state`, draft state, and current head SHA;
   - head check runs via methods `get_check_runs` and `get_status`;
   - unresolved review threads via method `get_review_comments` (page to the
     end);
   - unreplied root review comments and top-level comments via methods
     `get_review_comments`, `get_reviews`, and `get_comments`;
   - the Codex current-head signal from Codex's visible reviews/comments for
     the current head. The reaction-backed PR-description approval gate is
     not readable over MCP; report it as unverified rather than assumed.
4. Blocker handling, reply shapes, and Codex-request discipline are identical
   to the local path (see below); use the MCP write tools
   (`add_reply_to_pull_request_comment` for inline review comments,
   `add_issue_comment` for top-level PR conversation comments,
   `resolve_review_thread`, `update_pull_request`) in place of `gh`
   commands. Reply before resolving, always.
5. Label any all-clear as **MCP-emulated readiness**, never as
   probe-verified: `pnpm pr:ready-state` did not run, and the Codex approval
   gate plus required-context classification are approximations. An
   MCP-emulated all-clear is a status report, not a terminal state: keep the
   step-2 loop armed, name the gates the sweep could not verify (for example
   the Codex reaction approval) as unverified rather than clear, and hand
   the final probe-verified readiness decision to a gh-capable surface
   (local babysitter or CI).

## Act On Required Blockers

Use `required.blockers` and required `gates` from `--json` as the action list.
Treat `optional.items` as reportable context unless branch protection makes the
item required.

- Failing required check: inspect the failing workflow/log, fix only PR-caused
  failures, run focused validation, commit, and push.
- Merge conflict: fetch `baseRefName` from the verified `BASE_REMOTE` and merge
  that remote-tracking ref into the already-published PR branch. Resolve, run
  focused validation, commit, and push through `HEAD_REMOTE`. Do not rebase a
  published PR because the resulting force-push violates this workflow.
- Feedback blocker: triage every normalized finding, implement valid fixes,
  and sweep review bodies, top-level comments, threads, annotations, and
  failing logs before all-clear. Reply before resolving a thread, using:
  - Fixed: `Fixed in <commit> — <what changed>`
  - Won't fix: `Won't fix: <technical reason why>`
- Codex approval missing or stale: wait for the automatic current-head review.
  Never post a duplicate request while state is `requested`, `in_flight`, or
  `approved`; use one manual request only when the normal automatic-review
  window ended with no current-head signal.

Batch sibling findings before pushing. Run the mapped quality gate once for
each fix batch and `pnpm agent:autoreview` for a non-trivial batch. If two
review-triggered patch cycles have completed, pause for scope reclassification
instead of automatically starting a third.

Never force-push or amend while babysitting. If target binding fails, move to a
clean dedicated checkout and repeat the guard before editing; do not continue
in the unbound checkout.

## Final Sweep

Before reporting all-clear, rerun both projections:

```bash
pnpm --silent pr:feedback-state --pr <number> --repo <BASE_REPO> --json
pnpm pr:ready-state --pr <number> --repo <BASE_REPO> --json
```

If an optional review-producing workflow finishes while watching, rerun
feedback-state to catch late findings. Only report all-clear when the feedback
ledger has no required blocker and ready-state `ready` is `true` for the
current head. The Codex approval exception is only the exact head-scoped
break-glass contract in `docs/notes/pr-ready-state.md`; it waives no other
gate. Include the PR URL, head SHA, required blocker count, unresolved thread
count, unreplied review-comment count, required-check state, and optional lag.

In a Claude cloud session, rerun the full MCP emulation checklist from
[Cloud Watch Loop](#cloud-watch-loop-claude-cloud-sessions) instead, report
the same fields, and label the result MCP-emulated.
