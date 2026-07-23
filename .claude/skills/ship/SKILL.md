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

In a Claude cloud session, replace the `gh pr view` lookup with
`list_pull_requests` filtered by head branch (or `pull_request_read` when the
PR number is known); the git commands run unchanged.

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
feedback and protected-main checklist copies inside its trusted bundle
directory. The owning-checkout default semantic helper and automatic feedback
run Node modules pinned from that same `origin/main` object, not a PR-selected
base, mutable worktree, or reviewed package scripts; wrapper-owned Node launches
discard `NODE_OPTIONS` and `NODE_PATH`.
Reviewer web search is off by default and requires explicit `--web-search`.
A quiet reviewer emits a
60-second heartbeat. Do not pass the removed `--parallel-tests` option; the
quality gate owns test execution.

If direct semantic execution refuses a multi-pass target, run
`pnpm agent:autoreview --prepare-bundle-dir <dir>` with a directory outside the
worktree whose parent already exists. Every canonical parent ancestor must be
owned by the current user or root; group/other-writable ancestors require
sticky-bit protection. On macOS, write-granting ACLs on parent ancestors or
bundle entries fail preparation or verification. Have one fresh-context reviewer
inspect every pass listed by the bundle index. Run
`pnpm agent:autoreview --verify-bundle-dir <dir>` immediately before review and
retain its printed digest outside the bundle. After review, rerun with
`--expected-bundle-manifest <retained-digest>`; both checks must pass with the
same digest.

If the change edits the executable autoreview runtime and the owning checkout
refuses with `executable autoreview runtime differs from its trusted pre-change
snapshot`, keep that refusal intact. From the reviewed checkout, invoke a clean,
detached, protocol-compatible wrapper/helper from the last independently
reviewed pre-change commit (or protected main when it is compatible):

```bash
reviewed_checkout=/absolute/path/to/reviewed-checkout
trusted_checkout=/absolute/path/to/trusted-pre-change-checkout
bundle_parent=/tmp/autoreview-runtime-review
mkdir -p "$bundle_parent"
(
  cd "$reviewed_checkout"
  AUTOREVIEW_HELPER="$trusted_checkout/scripts/agent-autoreview.mjs" \
    "$trusted_checkout/scripts/agent-autoreview.sh" \
    --prepare-bundle-dir "$bundle_parent/context-bundle" \
    --mode auto --base origin/main --feedback-pr <number>
)
"$trusted_checkout/scripts/agent-autoreview.sh" \
  --verify-bundle-dir "$bundle_parent/context-bundle"
```

Use that same trusted wrapper for the bound post-review manifest check. Never
point either path at the runtime-changing checkout, and never invoke that
checkout's package scripts to bootstrap the review.

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

4. Deep security scan: the user's local Claude Code ship flow adds a gated
   Claude Security plugin scan (scan-changes job) when the diff adds or
   changes logic on a security-sensitive surface — authn/authz, secrets
   handling, injection surfaces, network-facing handlers, deploy/CI paths, or
   onchain code. The plugin exists only in that local setup. On this adapter's
   surfaces, skip it: do not install or imitate the plugin, direct the quality
   gate and closeout review at those surfaces instead, and record
   "Claude Security scan: skipped (<surface>)" in the final summary so the
   user can run the deep pass from local Claude Code.

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

Run the shared readiness probe before calling the PR clean:

```bash
pnpm pr:ready-state --pr <number> --repo <BASE_OWNER/REPO> --json
```

Always pass `--repo` bound to the base repository: without it the probe infers
the repo from the checkout, which inspects the wrong same-number PR on fork
PRs or repo-bound checkouts.

In a Claude cloud session without the Surface Detection capability exception,
the probe cannot run; use the `babysit-pr` skill's cloud watch loop (MCP
emulation checklist) and label its result MCP-emulated rather than
probe-verified.

If the user asked for the complete ship loop, invoke the repo `babysit-pr`
skill or follow its workflow until the PR reaches all-clear, merged, closed, or
a clear deadline/escalation state.
