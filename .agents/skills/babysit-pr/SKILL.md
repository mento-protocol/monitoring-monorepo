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

If no PR number is provided, resolve the current branch PR:

```bash
gh pr view --json number,url,title,headRefName,baseRefName
```

For an explicit target, accept a bare number or PR URL. Use `--repo` only when
the PR is not in `mento-protocol/monitoring-monorepo`.

## Watch Loop

Run the shared probe:

```bash
pnpm pr:ready-state --pr <number> --json
```

For a foreground wait, use:

```bash
pnpm pr:ready-state --pr <number> --watch --compact
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
- Merge conflict: fetch the base branch, merge or rebase once according to the
  repo's current workflow, resolve, run focused validation, commit, and push.
- Unreplied review comment or unresolved thread: fetch every feedback surface,
  triage each finding, implement valid fixes, and reply to every comment. In
  Codex, inspect `pnpm pr:ready-state --pr <number> --json` first as a triage
  shortcut for the currently reported blockers: its `unresolvedReviewThreads[]`
  and `unrepliedRootReviewComments[]` entries often include the full comment
  body, URL, path, line, and id needed to understand the finding before making
  raw `gh api` calls. This does **not** replace the required full feedback
  sweep across review comments, review bodies, top-level comments, threads,
  check annotations, and failing check logs before all-clear. Do not resolve a
  thread without a reply first. Use these exact reply shapes:
  - Fixed: `Fixed in <commit> — <what changed>`
  - Won't fix: `Won't fix: <technical reason why>`
- Codex current-head approval missing, stale, or in flight: wait for the
  automatic current-head review path before taking action. Codex re-reviews new
  pushes automatically in this repo; do not post `@codex review` as a routine
  post-push step, and do not treat a `stale` signal immediately after a push as
  permission to comment again. Never post duplicate requests while the probe
  says a current-head request is `requested`, `in_flight`, or `approved`. Use
  one manual request only as a fallback when the current head still has no
  Codex signal after the normal automatic-review window.

Never force-push or amend while babysitting.

## Final Sweep

Before reporting all-clear, rerun:

```bash
pnpm pr:ready-state --pr <number> --json
```

Only report all-clear when `ready` is `true` for the current head. Include the
PR URL, head SHA, required blocker count, unresolved thread count, unreplied
review-comment count, required-check state, and any optional reviewer lag.

In a Claude cloud session, rerun the full MCP emulation checklist from
[Cloud Watch Loop](#cloud-watch-loop-claude-cloud-sessions) instead, report
the same fields, and label the result MCP-emulated.
