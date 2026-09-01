---
title: Agent Issue Workflow
status: active
owner: eng
canonical: true
last_verified: 2026-08-30
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Agent Issue Workflow

GitHub Issues are the active-work queue for agent-addressable tasks. The ready
queue is:

```text
is:issue is:open label:agent-ready -label:agent-active -label:in-pr
```

The repo pilot workboard is:

```text
https://github.com/orgs/mento-protocol/projects/12
```

Labels authorize lifecycle state. Project Agent, Branch, Claim ID, Claimed At,
and PR fields record ownership. These five fields are mutex-tool-owned. Every
repo-owned write to them uses the per-issue mutex. Project Status is human-owned
and unchanged by the helpers. A sweep claim reads it as a separate blocker
check. Use `Needs Grooming` for unclear work and `Blocked` for an external
dependency or human decision.

Do not edit an owner field while a helper can run for that issue. Project V2 has
no conditional field write. A direct external write to the same field between a
helper read and write can be overwritten without detection. Stop the helpers and
prove that they cannot resume before manual owner-field repair.

`BACKLOG.md` is transition storage only. When an item is migrated, the active
task should live in one issue, not in both places.

## Labels

State labels are mutually exclusive:

- `needs-grooming` — the issue is missing scope, acceptance criteria,
  dependencies, or a human decision.
- `agent-ready` — the issue body is enough for an agent to implement.
- `agent-active` — an agent owns the issue before or while opening a PR.
- `in-pr` — a PR is open or its merge still needs production closeout.

Routing labels:

- `source:backlog` — migrated or derived from `BACKLOG.md`.
- `pkg:*` — package or ownership area.
- `kind:*` — work type.
- `risk:*` — implementation risk: low, medium, or high.

## Lifecycle

1. Create or migrate the issue with the Agent Task issue form.
2. Add routing/risk labels and exactly one state label.
3. Put ready issues in `agent-ready`; put unclear issues in `needs-grooming`.
4. When an agent starts work, run `pnpm issue:claim --count <n> --agent <name>`
   before substantive edits. It moves the issue to `agent-active`, records
   ownership, and prints the Claim ID in success and partial errors. Keep that
   token. Pass `--claim-id <token>` with one explicit issue only when the caller
   must select it before mutation.
5. When opening a PR, run `pnpm issue:review --pr <pr> --issue <issue>` for
   each represented issue. It moves the issue to `in-pr` when the PR head
   matches the stored Branch. If the PR branch was created after claim, use
   `pnpm issue:review --pr <pr> --issue <issue> --claim-id <claim-id> --rebind-branch`.
   This owner-checked path proves and stores the new branch binding.
6. On merge, GitHub closes issues referenced with closing keywords. For an ad
   hoc closeout, run `pnpm issue:board sync --dry-run` after merge. A scheduled
   job can run the sync under its established authority. The command is
   repository-wide. It scans every issue with a queue label and does not accept
   issue-number scope. It adds missing open Project items and clears all queue
   labels from closed issues. It does not change Project Status, including
   `Done`. Inspect the ad hoc preview. Then obtain explicit authority for a
   repository-wide mutation before you rerun the command without `--dry-run`.
   The apply re-reads live state, so a clean preview does not narrow its
   mutation scope. The authority must cover the full projection, including
   unrelated items and closed issues that have no Project item.
   It re-reads and reclassifies each issue before it changes the Project item or
   labels. After each open-state projection, it re-reads the issue and
   reprojects bounded concurrent state changes. After closed-label cleanup, it
   verifies that the issue remains closed and has no queue label. If the issue
   reopened, it restores a queue label confirmed immediately before cleanup and
   projects the open state. If the confirmed state is ambiguous, or if only an
   older enumerated queue label is known, it uses `needs-grooming`. If a
   post-cleanup check fails, it makes bounded attempts to restore this retry
   state before exit. This keeps the issue visible without granting stale
   claim, review, or release authority. A concurrent conflict with a fallback
   `needs-grooming` label stays visible and fails closed for manual resolution.
   It fails if a closed issue retains a queue label or if state does not settle
   within the bounded attempts. A per-issue failure does not stop later issues.
   The command exits nonzero after it lists the successful and failed issue
   numbers. When Done means still requires post-merge production proof, use
   `Refs`, keep the issue open and `in-pr`, and retain its current owner through
   the live checks. Close and sync only after acceptance passes.
   When the closed issue is listed in an editable canonical parent or tracker,
   mark it complete and remove stale open-state text. Keep an immutable body
   unchanged; put terminal evidence in a comment or linked follow-up.
7. If the PR closes unmerged, run
   `pnpm issue:release --issue <issue> --claim-id <claim-id> --closed-unmerged-pr`
   after it closes. Add `--needs-grooming` when the remaining work is unclear.
   General release refuses `in-pr` and a claimed Branch with an open PR.
8. If a merged PR completes one stage but the open issue has more work, update
   the issue body with the completed stage and remaining criteria. Then run
   `pnpm issue:release --issue <issue> --claim-id <claim-id> --merged-pr --needs-grooming`.
   This #2071-compatible path clears the proven owner and moves the issue only
   to `needs-grooming`.

For other partial work, keep the issue open. Do not clear `in-pr` or its owner
by hand. A later claim can start the next stage after an operator confirms the
revised scope.
Generated documentation-garden issues are the exception. Their marked packet
bodies are immutable until closure. After a partial merge, set
`needs-grooming`; record work in comments and PR links. A human can resume the
packet or create a linked ordinary follow-up.
Do not release a production-closeout issue merely because its PR merged; retain
`in-pr` until live proof passes or the owner explicitly releases work they
cannot continue.

For a final follow-up PR on an existing `in-pr` issue, do not churn labels when
`issue:review` refuses the non-`agent-active` issue. Link the PR in a new issue
comment, use a closing keyword, and use the repository-wide sync preview and
apply sequence above after merge.

[ADR 0082](../adr/0082-persistent-issue-board-mutation-mutex.md) owns the mutex,
ownership snapshot, Status boundary, transaction compensation, recovery, and
Issue #2071 compatibility details for these commands.

## Workboard Commands

```bash
pnpm issue:claim --count 3 --agent codex
pnpm issue:claim --issue 901 --agent claude
pnpm issue:claim --issue 901 --agent codex --branch fix/901 --claim-id sweep-901 --sweep-eligible --body-sha256 <digest>
pnpm issue:review --pr 123 --issue 901
pnpm issue:review --pr 123 --issue 901 --claim-id <claim-id> --rebind-branch
pnpm issue:release --issue 901 --claim-id <claim-id>
pnpm issue:release --issue 901 --claim-id <claim-id> --needs-grooming
pnpm issue:release --issue 901 --claim-id <claim-id> --closed-unmerged-pr
pnpm issue:release --issue 901 --claim-id <claim-id> --merged-pr --needs-grooming
pnpm issue:board sync --dry-run
pnpm issue:board sync
pnpm issue:board backfill --issue 901 --dry-run
pnpm issue:board:test
```

These helpers shell out to gh. In Claude cloud without the capability-gate
exception, use the MCP and gh-capable handoff in
[`github-tooling-surfaces.md`](github-tooling-surfaces.md).

Claim can use the live ready queue or explicit issue numbers. Review can infer
same-repository `closingIssuesReferences` only when the first 100-reference page
is complete. Pass `--issue` or `--issues` for larger PRs, `Refs`, or mixed
complete and partial scope.

`--sweep-eligible` requires an explicit issue, Claim ID, `--branch`, and
`--body-sha256`. The backlog sweep computes the digest from the body in the same
JSON snapshot that it classified. The helper rechecks machine-readable
eligibility and the expected body digest while it holds the issue mutex. It
checks the body before and after the transition. It does not classify body
text. A direct GitHub body edit does not acquire the mutex. An edit after the
final check remains visible because the helper never writes the body. A manual
claim can use the checked-out branch.
Retry one ordinary nonzero claim only with the same token and branch.
When comments are enabled, this retry verifies a matching trusted claim comment
and creates it when it is missing. It does not duplicate an existing match.
Never retry `ISSUE_MUTATION_LOCK_STALE`, an unknown mutex outcome, a stale
`LOCK`, or a candidate `LOCK` or `UNLOCK`. Prove that the original helper cannot
resume. Then read the current ref and board state and follow ADR 0082 recovery.

Run `issue:board backfill --issue <n> --dry-run` before MCP ownership recovery.
Backfill snapshots all five owner fields before each write and during final
verification. It writes Claim ID, Agent, Branch, and Claimed At only when its
latest snapshot reports them as missing. It never writes PR or Status.

## PR Body Rules

Use a closing keyword only when the PR fully satisfies Done means:

```text
Closes #123
```

Use a non-closing reference for partial, dependency, or exploratory work:

```text
Refs #123
```

One PR may close multiple issues only when every listed issue is fully
satisfied. Mixed complete/partial PRs should use `Closes` for complete issues
and `Refs` for partial ones.

## Issue Body Rules

Agent-ready issues need enough context to implement without re-reading
`BACKLOG.md`. Keep the body current and concise:

- goal
- context and links
- acceptance criteria
- expected files or package area
- verification commands
- risks and non-goals
- dependencies or blockers
- done means, including which issue numbers a PR may close

Do not put `@claude` in the issue template by default. The Claude workflow
listens for that token on issues and comments.

## Durable Context

Durable lessons do not belong in issue comments or `BACKLOG.md`. Promote them to
`AGENTS.md`, `docs/pr-checklists/`, `docs/notes/`, or tests as part of the PR
that learned them.
