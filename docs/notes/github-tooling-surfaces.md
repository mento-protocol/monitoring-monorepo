---
title: GitHub Tooling Surfaces — gh CLI vs MCP
status: active
owner: eng
canonical: true
last_verified: 2026-09-03
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
- **Claude cloud sessions: MCP-first.** The gh binary is not installed by
  default in cloud containers, and even where it is obtained, GraphQL stays
  blocked (the probes rely on it — `pnpm pr:ready-state` fails on its first
  call because `gh pr view --json` rides on GraphQL). GitHub work goes through
  the GitHub MCP tools, and monitoring goes through PR webhook subscription
  plus scheduled self-check-ins.

## Surface detection

1. `CLAUDE_CODE_REMOTE` is set → Claude cloud session → MCP-first, unless
   the variant passes the full capability gate in step 3 — then gh-first
   applies with `--repo <owner/name>` on PR-scoped calls. This is the same
   gate `scripts/bootstrap/claude-code-web-setup.sh` and `.claude/babysit-pr.sh`
   use.
2. Otherwise → local (or Codex Cloud) → gh-first.
3. The capability gate: run `command -v gh` **first**. Cloud containers do not
   ship a gh binary by default, so the gate must fail here in the common case
   rather than at the first `gh api` call below — a probe that skips this
   check reads "command not found" as an evaluation failure instead of the
   absence signal it actually is. When gh is present, a repo-scoped
   `gh api repos/<owner>/<repo>` call, a minimal GraphQL query
   (`gh api graphql -f query='query{viewer{login}}'`), and a flag-support check
   for pagination slurping (`gh api --help | grep -- --slurp`) must all
   succeed. Probe `--slurp` by capability, not by version: `--slurp` is only
   valid alongside `--paginate` on a real endpoint, so a bare `gh api --slurp`
   is not runnable, and distro builds backport flags unevenly — the observed
   floor is that gh 2.45.0 (the default Ubuntu apt build) lacks it while gh
   2.96.0 has it. `scripts/bootstrap/claude-code-web-setup.sh` runs this same
   `--help` grep. **Do not use `gh auth status` or `/user`
   reachability as the signal** — in Claude cloud sessions the proxy serves
   `/user` and `/rate_limit` (so `gh auth status` succeeds) while GraphQL is
   still blocked, and REST `/repos/*` behavior has been observed to vary (see
   below).

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
the probes the skills depend on need both. The capability gate in Surface
detection step 3 is the one exception, and no cloud container has yet
satisfied it. Do not build a gh-over-MCP shim as a substitute for that gate;
the skills document the two native paths.

## gh → MCP mapping

| gh-first (local)                               | MCP-first (Claude cloud)                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `gh pr view --json number,state,mergeable,...` | `pull_request_read` method `get` (includes `mergeable_state`, head SHA, draft/state)                    |
| `gh pr checks` / status rollup                 | `pull_request_read` methods `get_status` and `get_check_runs`                                           |
| complete `pulls/<n>/files` pagination          | `pull_request_read` method `get_files`, paged to the end                                                |
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
keep `pnpm pr:ready-state` and `gh pr checks` as the canonical probes.

## Issue workboard transitions

`pnpm issue:claim`, `issue:review`, `issue:release`, `issue:board sync`, and
`issue:board backfill` shell out to gh. They use GraphQL for Project #12 and the
Git data APIs for the persistent per-issue mutex. The mutex uses GraphQL
`updateRefs` with an exact `beforeOid` on a retained custom ref. The active
credential needs Project write access and repository Contents write access.
Each helper rejects a non-`github.com` `GH_HOST` and a host-qualified `GH_REPO`.
The transport also sets `GH_HOST=github.com` and removes `GH_REPO` before every
gh call. Explicit repository and Project flags cannot authorize another host.
These commands cannot run in Claude cloud sessions absent the capability-gate
exception. On a gh-capable surface, a claim can accept a stable `--claim-id`;
the sweep path requires it. Release requires that token and uses the stored
branch. An explicit review rebind uses the same token, proves the selected open
same-repository PR, and refuses an open PR on the old stored Branch. A merged-PR
continuation proves the stored merged PR and moves the open issue only to
`needs-grooming`. The cloud fallback is a partial MCP emulation plus an explicit
gh-capable handoff:

1. Perform the label transition with `issue_write` (send the full resulting
   label set, e.g. swap `agent-ready` for `agent-active` on claim, or
   `agent-active` for `in-pr` when the PR opens).
2. Post the matching helper-format comment with `add_issue_comment` (claim
   comments include the `Claim ID:` and `Claimed at:` lines, plus `Branch:`
   when known), and state in it that Project #12 fields were not set from this
   session.
3. The persistent Git ref mutex and Project ownership checks are absent on this
   path. The claim comment is the temporary ownership record. Check for a
   fresher competing claim comment before starting work.
4. Hand off to a gh-capable surface. Run
   `pnpm issue:board backfill --issue <n> --dry-run`, then rerun it without
   `--dry-run` only when the proposed ownership-field writes are correct. The
   helper reads the newest valid trusted claim comment. It writes `Claim ID`,
   `Agent`, and `Claimed At` when its latest snapshot reports them as empty. It
   writes `Branch` only when the claim supplies it and the latest snapshot
   reports it as empty. It preserves Project Status and rejects conflicts that
   the snapshot shows.
   Before every field write and during final verification, it re-reads the
   lifecycle, exact trusted claim snapshot, Project field types, and all five
   owner fields, including PR. It never writes PR. The persistent per-issue
   mutex excludes claim, review, release, sync, and another backfill. All
   repo-owned owner-field writes use that mutex. Direct external writes do not.
   A direct external same-field write in the Project read-write gap can be
   overwritten without detection. Stop all helpers before manual owner-field
   repair. The helper does not roll back because a rollback could erase external
   state. Run `pnpm issue:board sync` separately after closure to clear queue
   labels. Sync preserves Project Status. First run
   `pnpm issue:board sync --dry-run`. This command is repository-wide and does
   not accept issue-number scope. Obtain explicit authority for the full
   repository-wide mutation before you rerun it without `--dry-run`. The apply
   re-reads live state, so a clean preview does not narrow its mutation scope.
   The authority must cover the full projection, including unrelated items.

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
     update time. Ignore empty reply-only reviews and rate-limit notices. A
     path-filter skip is `not_applicable` only when the trusted comment carries
     the canonical summary and skip markers, exact path-filter text, one Run
     ID, and one non-empty counted ignored-file block. Page `get_files` to the
     end and require the unique ignored paths, reported count, complete current
     filenames, and PR changed-file count to agree exactly. Re-read the head
     after paging. If MCP cannot prove complete pagination, the current file
     count, or an unchanged head, fail closed and treat the skip as no current
     review signal. Generic no-file, incremental no-change, rate-limit, and
     free-tier replies never count. Before deciding whether to wait, read
     `reviews.auto_review.auto_incremental_review` from the PR head's
     `.coderabbit.yaml` — CodeRabbit reads that file from the source branch, so
     a branch predating the 2026-09-02 change still has it `true`. When it is
     `true`, or the key or file is absent — which falls back to the provider
     default of enabled, so never read a missing value as `false` — **and** the
     org-level Global override does not set the key, wait for the automatic
     attempt to become terminal as before. When it is `false`, or
     when the Global override sets `auto_incremental_review: false` — which
     outranks the head's file and makes the head value ineffective — a push onto
     an already-open PR starts no automatic review, only the opening push does,
     so refresh once the head is stable and send the closeout request instead of
     waiting for a run that cannot start. ADR 0066 records which keys that
     override pins and when the operator applied it. One exception to that second branch: if this PR's opening review
     never completed, coming back as a rate-limit or cap notice rather than a
     review, CodeRabbit may still run and possibly retry it, so wait the
     bounded time as in the `true` branch before posting (PR #2236 observed a
     run on every push with `false` in force; ADR 0066 holds the dated tally).
     If the signal is missing or stale and no
     trusted top-level comment contains both `@coderabbitai review` and
     `<!-- coderabbit-final-head-review:<full-head-sha> -->`, use
     `add_issue_comment` to post `@coderabbitai review`, a blank line, and that
     exact marker. A marker comment is trusted only when its author association
     is `OWNER`, `MEMBER`, or `COLLABORATOR`, or its author login is `claude`,
     `claude[bot]`, `chatgpt-codex-connector`, or
     `chatgpt-codex-connector[bot]`. When the head-update time is available,
     require the request comment to be at or after it, and recheck the current
     full head immediately before the write. The marker detects completed
     requests and provides best-effort duplicate suppression; the issue-comment
     API has no atomic claim. After posting, wait for that closeout attempt to
     become terminal before the final feedback sweep, bounded by the babysit
     deadline, and handle any findings it posts. That wait is procedural: the
     readiness contract still never blocks on the CodeRabbit signal, and a
     review that never starts or is still pending at the deadline is optional
     lag.
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
