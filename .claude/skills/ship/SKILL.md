---
name: ship
description: Ship monitoring-monorepo changes through the repo's Codex-compatible workflow: preflight, quality gate, closeout review, commit, push, PR create/update, and readiness babysitting. Use when the user says "ship it", "/ship", "push this", "open a PR", "create a PR", "publish this", or "send it" in this repo.
title: Ship Skill
status: active
owner: eng
canonical: true
last_verified: 2026-05-28
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
git fetch origin main
```

3. Inspect branch, dirty state, commits, and PR state:

```bash
git branch --show-current
git status --short
git log origin/main..HEAD --oneline
gh pr view --json number,url,state,isDraft,baseRefName 2>/dev/null
```

Hard stop on `main` or `master`. If unrelated dirty changes are mixed with the
intended scope, stop and ask before staging anything.

## Review And Validation

1. Run the mapped repo gate first:

```bash
pnpm agent:quality-gate --run
```

2. For non-trivial behavioral, workflow, security, data-flow, infrastructure,
   or UI changes, run the closeout review when the helper is available:

```bash
pnpm agent:autoreview
```

If `pnpm agent:autoreview` reports that the global helper is missing, do a
current-session closeout review instead: inspect the diff against the PR base,
read every touched file that carries behavior, check docs/workflow drift, and
state in the PR body/final summary that the structured helper was unavailable.

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

Create or update the PR with:

- concise summary
- validation commands and results
- review/verification caveats
- issue closure references only when the PR fully satisfies the issue

For substantial work, default to a draft PR unless the user asked for a ready
PR.

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
