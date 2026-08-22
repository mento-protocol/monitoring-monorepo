---
name: ship
description: '[repo-skill] Ship monitoring-monorepo changes through the repo''s Codex-compatible workflow: preflight, quality gate, closeout review, commit, push, PR create/update, readiness babysitting, and required production closeout. Use when the user says "ship it", "/ship", "push this", "open a PR", "create a PR", "publish this", or "send it" in this repo.'
title: Ship Skill
status: active
owner: eng
canonical: true
last_verified: 2026-08-22
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
template, quality gate first. Only the GitHub transport branches: in a Claude
cloud session (`CLAUDE_CODE_REMOTE` set) git commit/push work unchanged and each
gh call has an MCP equivalent, and when the session passes the gh capability
gate, gh works with an explicit `--repo <owner/name>` because it cannot infer a
repository from the proxy remote. The gate and the full gh→MCP mapping live in
[`docs/notes/github-tooling-surfaces.md`](../../../docs/notes/github-tooling-surfaces.md).

## Preflight

1. Read root `AGENTS.md` and the package `AGENTS.md` files for changed paths.
2. Resolve the checkout repository and its upstream base before querying PRs
   (`gh repo view --json nameWithOwner,parent`): a fork checkout uses its parent
   as `BASE_REPO`, a non-fork uses itself as both `CURRENT_REPO` and
   `BASE_REPO`. Then look the PR up in this order of precedence — a
   user-supplied PR URL is passed to `gh pr view` verbatim and its
   owner/repository overrides the inferred base; a bare PR number binds the
   lookup to `BASE_REPO`; with no explicit target, list open PRs on `BASE_REPO`
   for the current branch, filter same-named fork branches by
   `headRepositoryOwner`, and require zero or one result after filtering. Query
   `number,url,state,isDraft,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner`
   on every path. In a Claude cloud session, that lookup is
   `list_pull_requests` filtered by head branch (or `pull_request_read` when the
   number is known); the git commands run unchanged.

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
parent repository. If no remote matches, add the parent as `upstream`; never
overwrite or retarget an existing remote.

3. Fetch `BASE_REF` from `BASE_REMOTE` into its remote-tracking ref. When
   `git rev-parse --is-shallow-repository` reports `true`, run
   `git fetch --unshallow "$BASE_REMOTE"` and fetch the ref again — a hosted
   depth-1 checkout otherwise produces a false ancestry failure.
4. Inspect dirty state, commits, and ancestry against that exact base with
   `git status --short`, `git log "$BASE_REMOTE/$BASE_REF"..HEAD --oneline`, and
   `git merge-base --is-ancestor "$BASE_REMOTE/$BASE_REF" HEAD`.

Hard stop on `main` or `master`. If an open PR exists, its repository,
`headRefName`, and `headRefOid` are the push target and starting commit. Before
creating the ship commit, verify local `HEAD` equals that OID. If intended
commits already exist locally, require the PR OID to be their ancestor and
inspect the intervening range. Never infer the target from the local branch
name. If the branch is missing current base commits, merge
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
missing helper is a hard stop. A clean source review is not UI, CLI/API,
generated-artifact, or runtime proof; retain all applicable verification.

3. For UI changes, follow the browser verification protocol in `AGENTS.md`.
   If browser tools are unavailable in the session, say so explicitly and do not
   claim browser verification happened.

4. Deep security scan: when the diff adds or changes logic on a
   security-sensitive surface — authn/authz, secrets handling, injection
   surfaces, network-facing handlers, deploy/CI paths, or onchain code —
   check whether the `claude-security` plugin's scan-changes job is available
   in this session. The plugin is developer-installed and Claude Code only;
   this repo does not declare it. When available, run the gated scan as the
   user's personal ship flow does. When unavailable (Codex, hosted checkouts,
   or no plugin), do not install or imitate it: direct the quality gate and
   closeout review at those surfaces instead and record
   `Claude Security scan: skipped (<surface>)` in the final summary so the
   deep pass can run from a session that has the plugin.

## Commit And Push

Stage only the intended files. Use a conventional commit prefix that matches the
change (`fix:`, `feat:`, `docs:`, `chore:`, `test:`, or `refactor:`).

For UI changes, capture visual review evidence only after every intended file
and review fix is committed and the worktree is clean. Record the final local
`HEAD` OID before capture. Capture at least one representative before/after
pair for each materially different route or state changed by the PR.

- Render `BASE_REMOTE/BASE_REF` in an isolated worktree for **Before** and the
  recorded final local `HEAD` for **After**. Never simulate the old state with
  DOM edits, stale deployments, or remembered screenshots.
- Use the same route, viewport, theme, authentication state, and deterministic
  fixture data for both images. Crop to the product surface. Do not expose
  secrets, personal data, account identifiers, or unrelated browser chrome.
- Store review images outside the repository. Never add them to the product
  commit unless the repository already owns screenshot fixtures for that
  purpose.
- A new route still needs a pair: show the base route's prior result, such as
  its 404 or nearest parent state, and the new route at the recorded `HEAD`.

If either revision cannot be rendered, stop before publication unless the user
explicitly waives visual evidence for that PR.

Push with `git push "$HEAD_REMOTE" HEAD:"$HEAD_REF"`, adding `-u` only for a
new PR branch.

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

- Maximum three bullets. Explain what the system did before, what failed or
  became difficult, and the concrete effect on users or operators.

## The Solution

- Explain what the system does after this PR, why that behavior improves the
  situation, and any material limit or non-goal.

## Details

- Implementation details, class names, query syntax, exact limits, invariants,
  caveats, and scope boundaries.

## Validation

- Commands and results.
```

Write the opening for an engineer who understands the product but has not read
the diff. Lead with behavior and effect. Put implementation mechanisms under
`## Details`. Before publishing, read only `## The Problem` and `## The
Solution`. Rewrite them if a reader cannot explain the old behavior, new
behavior, concrete benefit, and any material limit without reading the diff.
Use Markdown prose or bullets in these sections. Raw HTML other than comments,
paragraphs that contain it, and code blocks do not satisfy the opening-content
check. HTML comments do not count themselves, but they do not invalidate
adjacent Markdown prose.

`scripts/pr/check-pr-description.mjs` enforces the first two sections and their
order in CI, so no change log or other content may precede them. Put
review/verification caveats, detailed technical notes, and issue closure
references after `The Solution`, and use closure references only when the PR
fully satisfies the issue.

For normal monitoring-monorepo ship requests, especially `ship it` or a complete
ship loop, open or convert the PR as ready-for-review once the local gate passes:
drafts suppress the automated AI reviews this workflow depends on. Use draft
only when the user explicitly asks for draft/PR-only handling or when required
validation/review is intentionally still pending, and state that reason in the
PR body and final summary.

### UI visual evidence

After a UI PR exists and its `headRefOid` matches local `HEAD`, add a
`## Visual comparison` section to the PR description. Place it immediately
after `## The Solution` and before `## Details`. Use the authenticated GitHub
web description editor because `gh` and the public Issues API cannot upload
local image attachments. The section must name the route or state, exact base
and head commits, viewport, and fixture or data source. Label the images
**Before** and **After** and place them side by side in a Markdown table.

Reopen the PR description and verify that both attachment URLs are present,
both images render, and the labels map to the correct revisions. Record the PR
URL and verified base/head pair for the final summary. Do not treat a local
image path, broken Markdown, or an unverified upload as visual evidence. If the
authenticated browser or attachment surface is unavailable, stop and report
the blocker; do not call the UI PR shipped or ready.

## Post-Push And Closeout

Follow the operating card's Babysit and Ready-state steps. Apply the
`babysit-pr` skill's head-bound CodeRabbit exact-head request rule first. Then
run `pnpm --silent pr:feedback-state` followed by `pnpm pr:ready-state`, both
bound with `--repo "$BASE_REPO"` because checkout inference can inspect the
wrong same-number PR. `docs/notes/pr-ready-state.md` owns that contract. In a
Claude
cloud session without the capability gate the probes cannot run: use the
`babysit-pr` skill's cloud watch loop and label its result MCP-emulated. If the
user asked for the complete ship loop, run `babysit-pr` through current-head
all-clear, then present the evidence and wait for the operating card's explicit,
direct merge approval. After that approved merge, resume the loop when Done
means includes deployment or live proof: monitor the deployment, obtain any
separate apply or promotion approval, run the owning package's production
checks, and verify the live acceptance criteria. Pre-merge all-clear is not
completion while that proof remains. Stop only after required production
closeout completes, after merge or closure when no closeout is required, or at
a clear deadline or escalation state.
