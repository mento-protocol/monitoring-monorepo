---
name: ship
description: '[repo-skill] Ship monitoring-monorepo changes through the repo''s Codex-compatible workflow: preflight, quality gate, closeout review, commit, push, PR create/update, and readiness babysitting. Use when the user says "ship it", "/ship", "push this", "open a PR", "create a PR", "publish this", or "send it" in this repo.'
title: Ship Skill
status: active
owner: eng
canonical: true
last_verified: 2026-07-16
doc_type: skill
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# Ship

Use this repo-local adapter for shipping `monitoring-monorepo` work from Codex
Cloud or any checkout that does not have the user's personal skills installed.
It preserves the local `/ship` contract while relying only on repo-visible
commands and GitHub tooling.

## Preflight

1. Read root `AGENTS.md` and the package `AGENTS.md` files for changed paths.
2. Fetch the base branch:

```bash
git fetch origin main:refs/remotes/origin/main
if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  git fetch --unshallow origin
  git fetch origin main:refs/remotes/origin/main
fi
```

3. Inspect branch, dirty state, commits, and PR state:

```bash
git branch --show-current
git status --short
git log origin/main..HEAD --oneline
git merge-base --is-ancestor origin/main HEAD
gh pr view --json number,url,state,isDraft,baseRefName 2>/dev/null
```

Hard stop on `main` or `master`. The shallow-repository guard prevents hosted
depth-1 checkouts from producing a false ancestry failure. If
`git merge-base --is-ancestor origin/main HEAD` still fails, the branch is
missing commits from current `origin/main`; merge or rebase before pushing
unless you intentionally created a fresh branch from that same fetched base. If
unrelated dirty changes are mixed with the intended scope, stop and ask before
staging anything.

## Review And Validation

1. Run the mapped repo gate first:

```bash
pnpm agent:quality-gate --run
```

2. Freeze the original request, target/owner, changed files, and non-test
   changed-line count as the scope baseline. For non-trivial behavioral,
   workflow, security, data-flow, infrastructure, or UI changes, run the
   closeout review:

```bash
pnpm agent:autoreview
```

The repo-local helper reviews the complete branch-local target without
truncation. Direct semantic engines fail closed if the target needs more than
one prompt; prepared bundles retain bounded lossless passes that one
fresh-context reviewer must inspect completely.
Semantic engines run from an isolated empty workspace with restricted project
configuration and environment; sensitive inputs fail closed. Direct
supplemental evidence must be repo-relative, except for adapter-generated PR
feedback inside its trusted bundle directory. A quiet reviewer emits a
60-second heartbeat. Do not pass the removed `--parallel-tests` option; the
quality gate owns test execution.

If direct semantic execution refuses a multi-pass target, run
`pnpm agent:autoreview --prepare-bundle-dir <dir>` with a directory outside the
worktree and have one fresh-context reviewer inspect every pass listed by the
bundle index.

Inside an active Codex sandbox, the adapter may choose the local deterministic
engine only when no engine was explicitly selected. An explicitly selected
unavailable semantic engine, or a missing repo helper, is a hard stop: report
the blocker rather than silently substituting local or current-session review.

Verify accepted findings before editing. Classify scope growth as in-scope,
follow-up, or stop, create an issue before deferring valid follow-up work, warn
near twice the frozen baseline, and pause for reclassification after two
review-triggered patch cycles. A clean source review is not UI, CLI/API,
generated-artifact, or runtime proof; retain all applicable verification.

3. For UI changes, follow the browser verification protocol in `AGENTS.md`.
   If browser tools are unavailable in the session, say so explicitly and do not
   claim browser verification happened.

## Commit And Push

Stage only the intended files. Use a conventional commit prefix that matches the
change (`fix:`, `feat:`, `docs:`, `chore:`, `test:`, or `refactor:`).

```bash
git status --short
git add <intended-files>
git commit -m "<prefix>: <summary>"
git push -u origin HEAD
```

Never force-push or amend unless the user explicitly requests it.

## PR

Create or update the PR with this body shape:

```markdown
## The Problem

- Maximum three bullets that explain the problem in plain English.

## The Solution

- Simple explanation of how this PR solves it, understandable before reading
  the diff.

## Details

- Implementation details, invariants, caveats, and scope boundaries.

## Validation

- Commands and results.
```

Rules:

- The first two sections are mandatory and must appear in that order.
- Do not start with an implementation change log.
- Put review/verification caveats, detailed technical notes, and issue closure
  references after `The Solution`.
- Use issue closure references only when the PR fully satisfies the issue.

For normal monitoring-monorepo ship requests, especially `ship it` or a complete
ship loop, open or convert the PR as ready-for-review once the local gate passes.
Use draft only when the user explicitly asks for draft/PR-only handling or when
required validation/review is intentionally still pending, and state that reason
in the PR body and final summary.

Include this marker when practical:

```markdown
## Ship Checklist

- [x] ship skill used
- [x] local review/gate run
- [x] PR readiness probe planned
```

## Post-Push

Run the shared readiness probe before calling the PR clean:

```bash
pnpm pr:ready-state --pr <number> --json
```

If the user asked for the complete ship loop, invoke the repo `babysit-pr`
skill or follow its workflow until the PR reaches all-clear, merged, closed, or
a clear deadline/escalation state.
