---
title: GitHub Tooling Surfaces — gh CLI vs MCP
status: active
owner: eng
canonical: true
last_verified: 2026-08-29
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# GitHub Tooling Surfaces — gh CLI vs MCP

The GitHub-interacting skills (`ship`, `babysit-pr`) branch on execution
surface. This note is the single canonical mapping between the two paths; the
skills link here instead of duplicating it.

- **Local sessions: repository-helper first before cutover.** The shared probes
  (`pnpm pr:ready-state`, `pnpm pr:feedback-state`, `pnpm issue:claim`) are the
  source of truth on the legacy gh surface. The first structured broker does
  not run these helpers or implement their GraphQL projections. After cutover,
  keep each unsupported step unavailable until a trusted structured equivalent
  exists. Do not give a repository helper an installation token.
- **Codex Cloud: evidence-dependent.** Use the gh path only when the cloud
  credential is proved to be an approved repository-scoped App installation
  token. Otherwise keep the surface read-only.
- **Claude cloud sessions: MCP-first.** The gh binary is not installed by
  default in cloud containers, and even where it is obtained, GraphQL stays
  blocked (the probes rely on it — `pnpm pr:ready-state` fails on its first
  call because `gh pr view --json` rides on GraphQL). GitHub work goes through
  the GitHub MCP tools, and monitoring goes through PR webhook subscription
  plus scheduled self-check-ins.

## Local credential identity

ADR 0078 separates the local agent identity from the human merge identity.
The checked-in source defines the target state. It does not prove that the
server ruleset or credential cutover is live.

After the separately approved activation, a local agent submits one structured
operation to the root-owned broker. The broker mints a short-lived installation
token for the selected-repository App, performs that operation with a fixed
permission profile, and returns only normalized operation output. The App PEM,
JWT, and installation token never enter the agent process or a caller-controlled
child.

The fixed profiles separate reads, pull-request and issue mutation, future Git
publication, and future issue-board mutation. The last two are source-disabled.
A read profile has no write permission. Workflow write is absent from every
normal profile. It needs a root-owned,
human-controlled capability that ordinary agent input cannot select. The
broker stays unavailable when the host cannot enforce this contract. The exact
protocol and activation procedure are in
[`local-agent-github-app-credential.md`](local-agent-github-app-credential.md).

The checked-in broker supports only its named REST operations. It does not run
`gh`, Git, `pnpm`, a repository hook, or a repository helper with a token. Git
publication, merge, workflow publication, the two PR readiness projections,
and transactional #2111 claim/release remain unavailable. Use an approved
human or proved MCP lane for a required unsupported step. Report that handoff
as a limit. Do not infer `READY` from the smaller REST response.

The human merge credential and the write-capable platform PAT stay outside
every agent OS, keychain, browser, environment, credential proxy, and command
surface. The agent OS also has no operator platform tfvars file. A human Team
member uses the merge credential only from a human-only terminal for the
approved `pnpm pr:merge` step. Do not
infer local identity from an App installed for Codex Cloud, Claude, Sentry, or
another workflow. An installed cloud App does not authenticate local `gh`.

Before cutover, report the local credential as human-derived and treat the
local wrapper as the live merge control. After cutover, prove the installation
ID, absence of Contents permission, fixed permission-denial result, exact live
ruleset JSON, and Team merge through the credential runbook's proof phase. The
App denial proves its permission ceiling, not lifecycle-ruleset evaluation. Do
not claim activation from Terraform source or an App registration alone.

After cutover, use a fresh dedicated agent OS account or container with no
operator Git configuration or credential. Do not run an authenticated direct
gh or Git network command from the agent process. Use only a structured broker
operation. Do not put an installation token in the parent shell. Git
publication remains on the separate human lane until a root-owned clean mirror
or equivalent trusted implementation passes its activation proof.

Claude cloud remains MCP-first. Codex Cloud can remain gh-first only after its
credential is proved to be a repository-scoped App installation token with no
lifecycle bypass. A platform-provided credential name is not proof. A cloud
surface that cannot prove this identity must remain read-only and outside the
credential cutover.

## Surface detection

1. `CLAUDE_CODE_REMOTE` is set → Claude cloud session → MCP-first. Keep a
   writable surface disabled until its connector identity is proved to be an
   approved App installation with no lifecycle bypass.
2. Local session after approved cutover → named structured broker operations
   only. Do not run a direct authenticated gh or Git network probe from the
   agent process. Hand off a helper or projection that the broker does not
   implement.
3. Local session before cutover → legacy gh-first path. Report that the server
   identity boundary is not active.
4. Codex Cloud → gh-first only after identity proof. Otherwise keep the surface
   read-only.

For an allowed cloud gh surface, run `command -v gh` first. Cloud containers do
not ship a gh binary by default. When gh is present, require repository REST,
minimal GraphQL, and pagination-slurping capability before selecting the gh
path. Probe `--slurp` by capability, not version. `--slurp` is valid only with
`--paginate` on a real endpoint. Do not use `gh auth status` or `/user`
reachability as the signal. A cloud proxy can serve `/user` and `/rate_limit`
while GraphQL remains blocked.

## Why gh cannot work in Claude cloud sessions

The empirical surface has moved between verification passes and is
version/session-dependent — re-verify before relying on a specific claim
below rather than treating any one pass as permanent.

Current empirical findings (2026-08-24, two independent cloud containers):

- **The gh binary is not installed by default.** The documented capability
  gate fails at "command not found" before it reaches the `gh api` calls it
  is meant to evaluate; the probe must start with `command -v gh` (see
  Surface detection above).
- **Obtaining a gh binary is itself unreliable.** A release-tarball fetch
  from `github.com` can 403: the platform's GitHub credential proxy scopes
  `github.com` access to session-attached repositories, and a release asset
  is not one.
- **REST `/repos/*` calls succeeded.** This contradicts the 2026-07-22 finding
  below that every `/repos/*` path 403s. Treat the REST surface as
  version-dependent rather than a fixed blanket block.
- **GraphQL and the gh binary remain the reliably observed blockers.**
  `pnpm pr:ready-state` and `pnpm pr:feedback-state` fail on their first call
  regardless of REST behavior, because `gh pr view --json` rides on GraphQL
  and no cloud container has been observed with a working gh binary.

Superseded findings (2026-07-22, two independent cloud containers) — kept for
history; the REST `/repos/*` claim below is contradicted by the 2026-08-24
pass above:

- Outbound TLS to `github.com` / `api.github.com` is intercepted by the
  platform's GitHub credential proxy (CONNECT succeeds; responses are the
  proxy's, not the gateway's). This layer is independent of the environment's
  network-access setting: **allowlist entries for GitHub hosts are inert by
  design.**
- The proxy injects its own credential and **overrides the client
  `Authorization` header entirely**. A valid `GH_TOKEN`/PAT in the environment
  changes nothing; a bare unauthenticated curl to `/user` returns the session
  owner's identity either way.
- Allowed: `git` transport (via the local credential proxy the origin remote
  points at), `github.com` web pages and `raw.githubusercontent.com` for
  session-attached repos, and `api.github.com` `/user` + `/rate_limit`.
- ~~Blocked with structured 403s: every `api.github.com/repos/*` path~~ —
  superseded 2026-08-24 above. All GraphQL except an internal pinned
  operation set that serves the platform's own PR tooling stays blocked.
  `pnpm pr:ready-state` fails on its first call (`gh pr view --json` rides on
  GraphQL).
- The 403 body's remedy text ("an org admin must connect the Claude GitHub
  App") is misleading: the app being installed org-wide does not change this —
  the gate is per-session platform policy, and the supported API path in these
  sessions is the GitHub MCP server.

Regardless of REST behavior, MCP-first stands as the default for Claude cloud
sessions: the gh binary is not reliably available, GraphQL stays blocked, and
the probes the skills depend on need both. The proved Codex Cloud identity and
capability gate in Surface detection is the one gh-first exception. No cloud
container has yet satisfied it. Do not build a gh-over-MCP shim for that gate;
the skills document the two native paths.

## gh → MCP mapping

| gh-first (local)                               | MCP-first (Claude cloud)                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `gh pr view --json number,state,mergeable,...` | `pull_request_read` method `get` (includes `mergeable_state`, head SHA, draft/state)                    |
| `gh pr checks` / status rollup                 | `pull_request_read` methods `get_status` and `get_check_runs`                                           |
| review threads via GraphQL `reviewThreads`     | `pull_request_read` method `get_review_comments` (threads with `isResolved`/`isOutdated`)               |
| `gh api .../reviews`                           | `pull_request_read` method `get_reviews`                                                                |
| `gh api .../issues/<n>/comments`               | `pull_request_read` method `get_comments`                                                               |
| `gh pr create`                                 | `create_pull_request`                                                                                   |
| `gh pr edit` / body updates                    | `update_pull_request`                                                                                   |
| `gh pr merge --update-branch` equivalents      | `update_pull_request_branch`                                                                            |
| reply to a review comment                      | `add_reply_to_pull_request_comment`                                                                     |
| reply to a top-level PR comment                | `add_issue_comment` (pass the PR number as the issue number)                                            |
| resolve a review thread (GraphQL)              | `resolve_review_thread`                                                                                 |
| failing-check log reads                        | `get_job_logs`, `get_check_run`                                                                         |
| `gh issue edit` / labels / comments            | `issue_write`, `issue_read`, `add_issue_comment`                                                        |
| `pnpm pr:ready-state --watch` foreground loop  | `subscribe_pr_activity` webhook events + scheduled self check-ins (e.g. `send_later`); never sleep-poll |

## Exact workflow-run selection

Resolve the expected workflow path to exactly one workflow database ID. Stop if
the path has zero or multiple matches. Then resolve the full target commit SHA,
select runs with both IDs, and bind every claim to the returned run
`databaseId`:

```bash
gh workflow list --all --limit 1000 --json id,path,state \
  --jq '.[] | select(.path == "<expected-workflow-path>")'
gh run list --workflow <workflow-database-id> --all --commit <full-sha> \
  --limit 1000 \
  --json databaseId,headSha,workflowDatabaseId,status,conclusion,url
gh run view <databaseId>
gh run watch <databaseId> --exit-status
```

Use the unique workflow row's `id` as `<workflow-database-id>`. Require each
run's `headSha` to equal the target SHA and `workflowDatabaseId` to equal that
ID. A workflow display name, branch filter, or list position is not sufficient
evidence because each can select an older or unrelated run. For pull requests,
keep `pnpm pr:ready-state` and `gh pr checks` as the canonical probes on a
credential surface that can run them. The first local App broker cannot run
them. Its REST operations do not replace their verdict.

## Issue workboard transitions

`pnpm issue:claim`, `issue:review`, and `issue:release` shell out to gh. They
also use `gh api graphql` for Project #12 status and the Claim ID ownership
field. They cannot run in Claude cloud sessions without the capability-gate
exception. They also cannot run through the first local App broker. Its
`issue-board-write` profile rejects every operation before token minting until
the transactional #2111 adapter exists. The fallback is a partial MCP
emulation plus an explicit gh-capable handoff:

1. Perform the label transition with `issue_write` (send the full resulting
   label set, e.g. swap `agent-ready` for `agent-active` on claim, or
   `agent-active` for `in-pr` when the PR opens).
2. Post the matching helper-format comment with `add_issue_comment` (claim
   comments include the `Claim ID:` and `Claimed at:` lines, plus `Branch:`
   when known), and state in it that Project #12 fields were not set from this
   session.
3. The Project Claim ID race guard is absent on this path, so the claim
   comment is the ownership record; check for a fresher competing claim
   comment before starting work.
4. Hand off to a gh-capable surface. Run
   `pnpm issue:board backfill --issue <n> --dry-run`, then rerun it without
   `--dry-run` only when the proposed ownership-field writes are correct. The
   helper reads the newest valid trusted claim comment. It fills empty Project
   fields as follows: `Claim ID`, `Agent`, and `Claimed At`. It fills `Branch`
   only when the claim supplies it. It preserves Project Status and rejects
   non-empty conflicts.
   Before every field write, it re-reads the lifecycle, exact trusted claim
   snapshot, Project field types, and current values. GitHub provides no
   compare-and-swap operation. A concurrent write can still occur after that
   read and before the mutation. The helper does not roll back because a
   rollback could erase concurrent state. Run `pnpm issue:board sync --dry-run`
   separately to preview status reconciliation. This command is
   repository-wide and does not accept issue-number scope. Obtain explicit
   authority for a repository-wide mutation before you rerun the command
   without `--dry-run`. The apply re-reads live state, so a clean preview does
   not narrow its mutation scope. The authority must cover the full projection,
   including unrelated items.

## Known MCP gaps

- **No arbitrary GraphQL.** Anything the probes derive from GraphQL-only data
  is unavailable or approximate.
- **No comment-reaction reads.** The Codex PR-description approval gate is a
  bot `+1` reaction on a comment; MCP cannot read reactions, so this gate
  cannot be verified from a cloud session — only inferred from Codex's visible
  reviews/comments for the current head.
- **No branch-protection or ruleset reads.** Required-vs-optional check
  classification is approximate; use the `get_status` rollup plus known
  required contexts, and say so when reporting.
- **Bounded pagination.** MCP tools page at ≤100 items with cursors; sweep all
  pages before declaring a surface clean.

Because of these gaps, a cloud-session readiness sweep is an emulation of
`pnpm pr:ready-state`, not a substitute. Any all-clear reported from the MCP
path must be labeled **MCP-emulated** rather than probe-verified, and the final
probe-verified all-clear belongs to a surface where the probe runs (local
babysitter or CI).

## Watching a PR from a cloud session

`pnpm pr:ready-state` cannot run here, so the watch is event-driven rather than
polled. Do not foreground-poll and never sleep-poll.

1. Subscribe to PR events (`subscribe_pr_activity`) so comments, reviews, and CI
   failures arrive as webhook activity. An edit to an existing bot comment (for
   example CodeRabbit or Codex updating its own summary in place) re-fires a
   PR-activity wake the same as a new comment. Dedupe by comment id plus its
   updated content, not by event count, or an edited-in-place summary reads as
   new findings every time it changes.
2. Arm a scheduled self check-in (for example `send_later`) before ending the
   turn, every 15-20 minutes against the operating card's one-hour default
   deadline. Webhooks do not cover CI success, new pushes, or merge-conflict
   transitions, so a check-in that fired only at the deadline would miss a
   mid-window green. Re-arming is bounded by that same deadline: at it, report
   the current state and stop or escalate rather than re-arming silently. Stop
   when the PR is merged or closed.
3. On every event or check-in, run the MCP emulation of the readiness sweep
   using the mapping above: PR state and head SHA, head check runs, unresolved
   review threads (page to the end), unreplied root review comments, and
   top-level comments. Three readings the mapping does not make for you:
   - The latest per-reviewer state from `get_reviews`: an outstanding
     `CHANGES_REQUESTED` is a required blocker until approved or dismissed.
     GitHub's aggregate review decision persists across new pushes, so do not
     discard it for being on an older commit. Whether an approval is required at
     all rides on branch protection, which MCP cannot read — name it unverified.
   - The Codex current-head signal from Codex's visible reviews and comments.
     The reaction-backed PR-description approval gate is not readable over MCP;
     report it as unverified rather than assumed.
   - The CodeRabbit current-head signal from `get_reviews` and top-level
     comments — the MCP reading of the closeout contract
     [`pr-ready-state.md`](pr-ready-state.md) owns. Count a CodeRabbit review
     whose body contains `**Run ID**` and whose review commit equals the
     current full head. Also count a trusted top-level clean-run block when
     `<!-- recent_review_start -->` and `<!-- recent_review_end -->` enclose
     it, it contains a Run ID, its full reviewed commit range ends at the
     current head, and its comment update time is at or after the current head
     update time. Ignore empty reply-only reviews, skipped runs, and rate-limit
     notices. After the optional CodeRabbit check becomes terminal, refresh
     once. If the signal is missing or stale and no trusted top-level comment
     contains both `@coderabbitai review` and
     `<!-- coderabbit-final-head-review:<full-head-sha> -->`, use
     `add_issue_comment` to post `@coderabbitai review`, a blank line, and that
     exact marker. A marker comment is trusted only when its author association
     is `OWNER`, `MEMBER`, or `COLLABORATOR`, or its author login is `claude`,
     `claude[bot]`, `chatgpt-codex-connector`, or
     `chatgpt-codex-connector[bot]`. When the head-update time is available,
     require the request comment to be at or after it, and recheck the current
     full head immediately before the write. The marker detects completed
     requests and provides best-effort duplicate suppression; the issue-comment
     API has no atomic claim.
4. **A fork head stops the run on this surface too.** The repo gate that refuses
   fork heads (`.claude/babysit-pr.sh`) cannot run here, so establish
   `isCrossRepository` from the PR payload before the first repo command and
   refuse the same way rather than proceeding unguarded.
5. Blocker handling, reply shapes, and Codex-request discipline are identical
   to the local path — see [`pr-operating-card.md`](pr-operating-card.md)
   steps 6 and 7 — using the MCP write tools named above in place of `gh`.
   Reply before resolving, always. **Checkout binding carries a cloud
   exception, and it applies to every adapter call the repo-identity preflight
   governs on this surface — the quality gate and a hosted ship as much as a
   babysit blocker fix**: the canonical-`origin` requirement cannot hold here,
   because a Claude cloud `origin` is a credential-proxy URL, not a canonical
   GitHub URL. Bind by content instead — for a same-repository target,
   `headRepository.nameWithOwner` must equal the session-attached repository;
   local `git rev-parse HEAD` must equal the MCP-resolved `headRefOid` before
   editing; the verified proxy `origin` serves as both `HEAD_REMOTE` and
   `BASE_REMOTE`; and the post-push guard re-resolves with
   `pull_request_read` method `get` in place of `gh pr view` and requires the
   returned `headRefOid` to equal local `HEAD`. Every other binding rule
   (clean worktree, explicit refspec, no force-push) applies unchanged.
6. Label any all-clear **MCP-emulated**, never probe-verified. It is a status
   report, not a terminal state: keep the step-2 loop armed, name the gates the
   sweep could not verify as unverified rather than clear, and hand the final
   probe-verified decision to a gh-capable surface.
