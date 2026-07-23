---
name: ship
description: '[repo-skill] Ship monitoring-monorepo changes through the repo''s Codex-compatible workflow: preflight, quality gate, closeout review, commit, push, PR create/update, and readiness babysitting. Use when the user says "ship it", "/ship", "push this", "open a PR", "create a PR", "publish this", or "send it" in this repo.'
title: Ship Skill
status: active
owner: eng
canonical: true
last_verified: 2026-07-23
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

## Surface Detection

Policy is identical on every surface — ready-for-review default, PR body
template, quality gate first. Only the GitHub transport branches; the full
gh→MCP mapping lives in
[`docs/notes/github-tooling-surfaces.md`](../../../docs/notes/github-tooling-surfaces.md).

- **Local session or Codex Cloud** (no `CLAUDE_CODE_REMOTE`): use the gh
  commands below as written.
- **Claude cloud session** (`CLAUDE_CODE_REMOTE` set): the platform's GitHub
  credential proxy blocks gh's API paths regardless of tokens or allowlist
  entries. Git commit/push work unchanged through the local git proxy;
  replace each gh call with its MCP equivalent — `pull_request_read` for the
  preflight PR lookup, `create_pull_request` / `update_pull_request` for the
  PR step — and hand post-push readiness to the `babysit-pr` cloud watch
  loop. Exception: in a cloud variant passing the full capability gate —
  repo-scoped REST call, minimal GraphQL query, and `--slurp` support (the
  same gate `babysit-pr` and `.claude/babysit-pr.sh` probe) — use the gh
  commands and the readiness probe, passing `--repo <owner/name>` (or
  setting `GH_REPO`) on PR-scoped calls: gh cannot infer a repository from
  the proxy remote.

## Preflight

1. Read root `AGENTS.md` and the package `AGENTS.md` files for changed paths.
2. Resolve the checkout repository and its upstream base before querying PRs.
   A fork checkout uses its parent as `BASE_REPO`; a non-fork uses itself:

```bash
CURRENT_REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
BASE_REPO=$(gh repo view --json nameWithOwner,parent \
  --jq '.parent.nameWithOwner // .nameWithOwner')
HEAD_OWNER=${CURRENT_REPO%%/*}
CURRENT_BRANCH=$(git branch --show-current)
```

If the user supplied a PR URL, pass that exact URL to `gh pr view`; its
owner/repository overrides the inferred base. For a bare PR number, bind the
lookup to `BASE_REPO`. With no explicit target, query `BASE_REPO` by branch,
then filter same-named fork branches by `headRepositoryOwner`; require zero or
one result after filtering:

```bash
gh pr view <explicit-pr-url> \
  --json number,url,state,isDraft,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner
gh pr view <explicit-pr-number> --repo "$BASE_REPO" \
  --json number,url,state,isDraft,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner
# No explicit target:
gh pr list --repo "$BASE_REPO" --head "$CURRENT_BRANCH" --state open \
  --json number,url,state,isDraft,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner \
  | jq --arg owner "$HEAD_OWNER" \
    '[.[] | select(.headRepositoryOwner.login == $owner)]'
```

Do not discard lookup errors. A failed GitHub query is not evidence that no PR
exists. Carry the resolved PR URL's owner/repository as `BASE_REPO`. For an
existing PR, identify the head repository separately and require a configured
remote that matches it; carry that name as `HEAD_REMOTE`, `baseRefName` as
`BASE_REF`, and `headRefName` as `HEAD_REF`. Stop if the PR head repository has
no matching push remote. With no existing PR, verify `origin` matches
`CURRENT_REPO`, then set `HEAD_REMOTE=origin`, `BASE_REF=main`, and `HEAD_REF`
to the current branch.

For every path, identify a configured remote whose URL matches `BASE_REPO` and
carry its name as `BASE_REMOTE`. Never substitute a fork's `origin` for its
parent repository. If no remote matches, add the parent as `upstream`; do not
overwrite or retarget an existing remote:

```bash
if [ -z "$BASE_REMOTE" ]; then
  if git remote get-url upstream >/dev/null 2>&1; then
    echo "upstream exists but does not match $BASE_REPO" >&2
    exit 1
  fi
  git remote add upstream "https://github.com/${BASE_REPO}.git"
  BASE_REMOTE=upstream
fi
```

3. Fetch the resolved base:

```bash
git fetch "$BASE_REMOTE" "$BASE_REF:refs/remotes/$BASE_REMOTE/$BASE_REF"
if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  git fetch --unshallow "$BASE_REMOTE"
  git fetch "$BASE_REMOTE" "$BASE_REF:refs/remotes/$BASE_REMOTE/$BASE_REF"
fi
```

4. Inspect dirty state, commits, and ancestry against that exact base:

```bash
git status --short
git log "$BASE_REMOTE/$BASE_REF"..HEAD --oneline
git merge-base --is-ancestor "$BASE_REMOTE/$BASE_REF" HEAD
```

In a Claude cloud session, replace the `gh pr view` lookup with
`list_pull_requests` filtered by head branch (or `pull_request_read` when the
PR number is known); the git commands run unchanged.

Hard stop on `main` or `master`. The shallow-repository guard prevents hosted
depth-1 checkouts from producing a false ancestry failure. If an open PR exists,
its repository, `headRefName`, and `headRefOid` are the push target and starting
commit. Before creating the ship commit, verify local `HEAD` equals that OID.
If intended commits already exist locally, require the PR OID to be their
ancestor and inspect the intervening range. Never infer the target from the
local branch name. If the branch is missing current base commits, merge
`"$BASE_REMOTE/$BASE_REF"` into an already-published PR branch; rebase is only
acceptable before first publication. If unrelated dirty changes are mixed with
the intended scope, stop and ask before staging anything.

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

`docs/notes/agent-quality-gate-mechanics.md` owns engine selection, trusted
bundle preparation/verification, runtime-change refusal handling, and the
source-review boundary. Follow that note instead of copying its volatile
adapter internals into this skill. An explicitly selected unavailable engine or
missing helper is a hard stop.

Verify accepted findings before editing. Classify scope growth as in-scope,
follow-up, or stop, create an issue before deferring valid follow-up work, warn
near twice the frozen baseline, and pause for reclassification after two
review-triggered patch cycles. A clean source review is not UI, CLI/API,
generated-artifact, or runtime proof; retain all applicable verification.

3. For UI changes, follow the browser verification protocol in `AGENTS.md`.
   If browser tools are unavailable in the session, say so explicitly and do not
   claim browser verification happened.

4. Deep security scan: the user's local Claude Code ship flow adds a gated
   Claude Security plugin scan (scan-changes job) when the diff adds or
   changes logic on a security-sensitive surface — authn/authz, secrets
   handling, injection surfaces, network-facing handlers, deploy/CI paths, or
   onchain code. The plugin exists only in that local setup. On this adapter's
   surfaces, skip it: do not install or imitate the plugin, direct the quality
   gate and closeout review at those surfaces instead, and record
   `Claude Security scan: skipped (<surface>)` in the final summary so the
   user can run the deep pass from local Claude Code.

## Commit And Push

Stage only the intended files. Use a conventional commit prefix that matches the
change (`fix:`, `feat:`, `docs:`, `chore:`, `test:`, or `refactor:`).

```bash
git status --short
git add <intended-files>
git commit -m "<prefix>: <summary>"
# New PR branch:
git push -u "$HEAD_REMOTE" HEAD:"$HEAD_REF"

# Existing PR branch:
git push "$HEAD_REMOTE" HEAD:"$HEAD_REF"
```

For an existing PR, the remote must resolve to the PR's `headRepositoryOwner`
and `headRepository`; do not assume it is `origin`. Re-read the PR after the
push and require `headRefOid == git rev-parse HEAD` before babysitting. Never
force-push or amend unless the user explicitly requests it.

## PR

Create or update the PR — `gh pr create` / `gh pr edit` locally,
`create_pull_request` / `update_pull_request` in a Claude cloud session — with
this body shape:

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

Follow the operating card's Babysit and Ready-state steps. Before calling the PR
clean, run the feedback projection first and the readiness projection second:

```bash
pnpm --silent pr:feedback-state --pr <number> --repo "$BASE_REPO" --json
pnpm pr:ready-state --pr <number> --repo "$BASE_REPO" --json
```

Always bind `--repo` to the base repository; checkout inference can inspect the
wrong same-number PR on fork PRs or repo-bound checkouts.

In a Claude cloud session without the Surface Detection capability exception,
the probe cannot run; use the `babysit-pr` skill's cloud watch loop (MCP
emulation checklist) and label its result MCP-emulated rather than
probe-verified.

If the user asked for the complete ship loop, invoke the repo `babysit-pr`
skill or follow its workflow until the PR reaches all-clear, merged, closed, or
a clear deadline/escalation state.
