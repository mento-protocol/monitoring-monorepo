---
title: GitHub Tooling Surfaces — gh CLI vs MCP
status: active
owner: eng
canonical: true
last_verified: 2026-07-22
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

1. `CLAUDE_CODE_REMOTE` is set → Claude cloud session → MCP-first. This is the
   same gate `scripts/claude-code-web-setup.sh` uses.
2. Otherwise → local (or Codex Cloud) → gh-first.
3. Runtime confirmation when in doubt: run
   `gh api repos/<owner>/<repo> --jq .full_name`. **Do not use
   `gh auth status` or `/user` reachability as the signal** — in Claude cloud
   sessions the proxy serves `/user` and `/rate_limit` (so `gh auth status`
   succeeds) while every `/repos/*` path and GraphQL query is still blocked.
   Only a successful repo-scoped call proves gh-backed flows can work.

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
