---
title: GitHub Tooling Surfaces — gh CLI vs MCP
status: active
owner: eng
canonical: true
last_verified: 2026-08-25
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# GitHub Tooling Surfaces — gh CLI vs MCP

The GitHub-interacting skills (`ship`, `babysit-pr`) branch on execution
surface. This note is the single canonical mapping between the two paths; the
skills link here instead of duplicating it.

- **Local sessions (and Codex Cloud): gh-first.** The gh CLI works, so the
  shared probes (`pnpm pr:ready-state`, `pnpm pr:feedback-state`,
  `pnpm issue:claim`) are the source of truth.
- **Claude cloud sessions: MCP-first.** The platform's GitHub credential proxy
  blocks the API paths gh needs, so GitHub work goes through the GitHub MCP
  tools, and monitoring goes through PR webhook subscription plus scheduled
  self check-ins.

## Surface detection

1. `CLAUDE_CODE_REMOTE` is set → Claude cloud session → MCP-first, unless
   the variant passes the full capability gate in step 3 — then gh-first
   applies with `--repo <owner/name>` on PR-scoped calls. This is the same
   gate `scripts/bootstrap/claude-code-web-setup.sh` and `.claude/babysit-pr.sh`
   use.
2. Otherwise → local (or Codex Cloud) → gh-first.
3. The capability gate: a repo-scoped `gh api repos/<owner>/<repo>` call, a
   minimal GraphQL query (`gh api graphql -f query='query{viewer{login}}'`),
   and `gh api --slurp` support must all succeed. **Do not use
   `gh auth status` or `/user` reachability as the signal** — in Claude cloud
   sessions the proxy serves `/user` and `/rate_limit` (so `gh auth status`
   succeeds) while every `/repos/*` path and GraphQL query is still blocked.

## Why gh cannot work in Claude cloud sessions

Empirical findings (2026-07-22, verified in two independent cloud containers):

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
- Blocked with structured 403s: every `api.github.com/repos/*` path (including
  the attached repo) and all GraphQL except an internal pinned operation set
  that serves the platform's own PR tooling. `pnpm pr:ready-state` fails on
  its first call (`gh pr view --json` rides on GraphQL).
- The 403 body's remedy text ("an org admin must connect the Claude GitHub
  App") is misleading: the app being installed org-wide does not change this —
  the gate is per-session platform policy, and the supported API path in these
  sessions is the GitHub MCP server.

Do not build a gh-over-MCP shim; the skills document the two native paths.

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

Resolve the full target commit SHA before querying GitHub Actions. Select runs
with the commit, then bind every claim to the returned `databaseId`:

```bash
gh run list --workflow <expected-workflow> --commit <full-sha> --limit 1000 \
  --json databaseId,headSha,workflowName,status,conclusion,url
gh run view <databaseId>
gh run watch <databaseId> --exit-status
```

Require `headSha` to equal the target SHA and `workflowName` to equal the
expected workflow. A workflow display name, branch filter, or list position is
not sufficient evidence because each can select an older or unrelated run. For
pull requests, keep `pnpm pr:ready-state` and `gh pr checks` as the canonical
probes.

## Issue workboard transitions

`pnpm issue:claim`, `issue:review`, and `issue:release` shell out to gh —
including `gh api graphql` for Project #12 status and the Claim ID ownership
field — so they cannot run in Claude cloud sessions absent the
capability-gate exception. The cloud fallback is a
partial MCP emulation plus an explicit gh-capable handoff:

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
   rollback could erase concurrent state. Run `pnpm issue:board sync`
   separately to reconcile status.

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
   failures arrive as webhook activity.
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
