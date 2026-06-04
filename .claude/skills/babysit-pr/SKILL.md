---
name: babysit-pr
description: Monitor monitoring-monorepo PR readiness using the repo's shared pr:ready-state probe, fix required CI/review blockers, reply to review comments, and stop only at ALL_CLEAR, MERGED, CLOSED, or a stated deadline. Use when the user says "babysit PR", "monitor CI", "watch reviews", or asks to keep a PR green.
title: Babysit PR Skill
status: active
owner: eng
canonical: true
last_verified: 2026-05-28
---

# Babysit PR

Use this repo-local adapter when the user's personal `babysit-pr` skill or
Claude `Monitor` tool is not available. The readiness source of truth is the
repo command, not a hand-rolled interpretation of green checks.

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
  check annotations, and failing check logs before all-clear. Use the root
  `AGENTS.md` reply templates. Do not resolve a thread without a reply first.
- Codex current-head approval missing or in flight: wait for the existing
  signal. Do not post duplicate `@codex review` requests while the probe says a
  current-head request is `requested`, `in_flight`, or `approved`.

Never force-push or amend while babysitting.

## Final Sweep

Before reporting all-clear, rerun:

```bash
pnpm pr:ready-state --pr <number> --json
```

Only report all-clear when `ready` is `true` for the current head. Include the
PR URL, head SHA, required blocker count, unresolved thread count, unreplied
review-comment count, required-check state, and any optional reviewer lag.
