---
title: Agent Issue Workflow
status: active
owner: eng
canonical: true
last_verified: 2026-08-25
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

Labels remain the source of truth. The Project board is a visibility layer that
the repo helper keeps in sync. `needs-grooming` issues project to
`Needs Grooming`, not `Blocked`; reserve `Blocked` for work that is otherwise
ready but waiting on an external dependency or explicit human decision.

`BACKLOG.md` is transition storage only. When an item is migrated, the active
task should live in one issue, not in both places.

## Labels

State labels are mutually exclusive:

- `needs-grooming` — the issue is missing scope, acceptance criteria,
  dependencies, or a human decision.
- `agent-ready` — the issue body is enough for an agent to implement.
- `agent-active` — an agent has claimed the issue and is working before or while
  opening a PR.
- `in-pr` — an implementation PR is open, or its approved merge still needs
  production closeout; agents should not pick this up as new work.

Routing labels:

- `source:backlog` — migrated or derived from `BACKLOG.md`.
- `pkg:*` — package or ownership area, for example `pkg:dashboard`,
  `pkg:indexer`, `pkg:alerts`, `pkg:terraform`, `pkg:tooling`.
- `kind:*` — work type, for example `kind:bug`, `kind:workflow`,
  `kind:hardening`, `kind:refactor`.
- `risk:*` — implementation risk, usually `risk:low`, `risk:medium`, or
  `risk:high`.

## Lifecycle

1. Create or migrate the issue with the Agent Task issue form.
2. Add routing/risk labels and exactly one state label.
3. Put ready issues in `agent-ready`; put unclear issues in `needs-grooming`.
4. When an agent starts work, run `pnpm issue:claim --count <n> --agent <name>`
   before substantive edits. The helper removes `agent-ready`, adds
   `agent-active`, adds the issue to Project #12, moves the Project item to
   `In Progress`, and posts a claim comment.
5. When opening a PR, run `pnpm issue:review --pr <pr> --issue <issue>` for
   every fully or partially represented issue. The helper removes
   `agent-active`, adds `in-pr`, and moves the Project item into review when
   the Project has an `In Review` status option. With the default GitHub status
   options, it falls back to `In Progress`.
6. On merge, GitHub closes issues referenced with closing keywords. Run
   `pnpm issue:board sync` after merge, or on a schedule, to move closed
   queue-labeled Project #12 items to `Done` and clear all queue labels. The
   helper also clears queue labels from closed issues that have no Project item.
   It re-reads and reclassifies each issue before it changes the Project item or
   labels. After each open-state projection, it re-reads the issue and
   reprojects bounded concurrent state changes. After a Done transition, it
   verifies that the issue remains closed and has no queue label. If the issue
   reopened, it restores a queue label confirmed immediately before cleanup and
   projects the open state. If the confirmed state is ambiguous, or if only an
   older enumerated queue label is known, it uses `needs-grooming`. If a
   post-cleanup check or Done projection fails, it makes bounded attempts to
   restore this retry state before exit. This keeps the issue visible without
   granting stale claim, review, or release authority. A concurrent conflict
   with a fallback `needs-grooming` label stays visible and fails closed for
   manual resolution.
   It fails if a closed issue retains a queue label or if state does not settle
   within the bounded attempts. A per-issue failure does not stop later issues.
   The command exits nonzero after it lists the successful and failed issue
   numbers. When Done means still requires post-merge production proof, use
   `Refs`, keep the issue open and `in-pr`, and retain its current owner through
   the live checks. Close the issue and run board sync only after its live
   acceptance criteria pass.
   When the closed issue is listed in an editable canonical parent or tracker,
   update that body in the same closeout. Mark its checklist item complete and
   remove nearby status text that still treats the child as open. Preserve a
   generated or explicitly immutable body; record its terminal evidence in a
   comment or linked follow-up instead.
7. If the PR closes unmerged, run `pnpm issue:release --issue <issue>` and
   restore `agent-ready` only when the remaining work is still clear; otherwise
   run `pnpm issue:release --issue <issue> --needs-grooming`.

For other partial work, keep the issue open. Remove `in-pr` after merge and set
`agent-ready` or `needs-grooming` based on the remaining acceptance criteria.
Before restoring `agent-ready` after a partial merge, update the issue body:
mark the merged work complete, isolate the remaining acceptance criteria, and
restate the current Done means. Do not return an issue to the ready queue while
its body still presents merged work as pending.
Generated documentation-garden issues are the exception. Their marked packet
bodies are immutable until closure. After a partial merge, do not edit the body
or restore `agent-ready`; set `needs-grooming`. A human can resume the frozen
packet or create a linked ordinary follow-up before closing it. Record merged
work in issue comments and PR links, not in the generated body.
Do not release a production-closeout issue merely because its PR merged; retain
`in-pr` until live proof passes or the owner explicitly releases work they
cannot continue.

If a follow-up PR fully closes an issue that is already labeled `in-pr` from an
earlier partial PR, `pnpm issue:review` will refuse because the issue is no
longer `agent-active`. Do not churn labels just to satisfy the helper. Add a
fresh issue comment linking the final PR, use a closing keyword in the PR body,
and run `pnpm issue:board sync` after merge.

## Workboard Commands

```bash
pnpm issue:claim --count 3 --agent codex
pnpm issue:claim --issue 901 --agent claude
pnpm issue:review --pr 123 --issue 901
pnpm issue:release --issue 901
pnpm issue:release --issue 901 --needs-grooming
pnpm issue:board sync
pnpm issue:board backfill --issue 901 --dry-run
pnpm issue:board:test
```

These helpers shell out to gh and cannot run in Claude cloud sessions absent
the capability-gate exception; use
the MCP fallback and gh-capable handoff in
[`github-tooling-surfaces.md`](github-tooling-surfaces.md) there.

`pnpm issue:claim` can claim from the live ready queue or claim explicit issue
numbers. `pnpm issue:review` can infer same-repository issues from
`closingIssuesReferences` when a PR uses closing keywords, but agents should
pass explicit `--issue` arguments when the PR uses `Refs` or has mixed
complete/partial scope.

The helper requires a text Project field named `Claim ID` before it will claim
issues; this field is the ownership token that prevents two agents from both
winning the same issue. It also populates optional Project fields named `Agent`,
`Branch`, `Claimed At`, and `PR` when those fields exist.

Use `pnpm issue:board backfill --issue <n>` only to recover Project ownership
fields after an eligible MCP claim. It requires one open issue with exactly one
of `agent-active` or `in-pr`, a valid trusted claim comment, and Project fields
with exact types: `Agent`, `Claim ID`, and `Branch` as text; `Claimed At` as a
date. The claim comment may omit `Branch`; the helper then leaves the existing
Project Branch value outside its fill and conflict checks. Start with
`--dry-run`. The helper fills empty fields only. It rejects a non-empty mismatch
and leaves Status unchanged. Before every field write, it re-reads the issue,
exact trusted claim snapshot, Project field types, and Project field values.
GitHub provides no compare-and-swap operation. A concurrent write can occur
after a re-read and before its mutation. The helper does not roll back because a
rollback could erase concurrent state. It reads at most 100 comment pages or
10,000 comments and fails closed rather than use incomplete claim history.

## PR Body Rules

Use closing keywords only when the PR fully satisfies the issue's "Done means":

```text
Closes #123
```

For partial work, dependency work, or exploratory work, use a non-closing
reference:

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
