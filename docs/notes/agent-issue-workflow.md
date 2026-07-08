---
title: Agent Issue Workflow
status: active
owner: eng
canonical: true
last_verified: 2026-07-08
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
- `in-pr` — an implementation PR is open; agents should not pick this up as new
  work.

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
   `in-pr` issues that are already on Project #12 to `Done` and clear the
   queue label.
7. If the PR closes unmerged, run `pnpm issue:release --issue <issue>` and
   restore `agent-ready` only when the remaining work is still clear; otherwise
   run `pnpm issue:release --issue <issue> --needs-grooming`.

For partial work, keep the issue open. Remove `in-pr` after merge and set
`agent-ready` or `needs-grooming` based on the remaining acceptance criteria.

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
pnpm issue:board:test
```

`pnpm issue:claim` can claim from the live ready queue or claim explicit issue
numbers. `pnpm issue:review` can infer same-repository issues from
`closingIssuesReferences` when a PR uses closing keywords, but agents should
pass explicit `--issue` arguments when the PR uses `Refs` or has mixed
complete/partial scope.

The helper requires a text Project field named `Claim ID` before it will claim
issues; this field is the ownership token that prevents two agents from both
winning the same issue. It also populates optional Project fields named `Agent`,
`Branch`, `Claimed At`, and `PR` when those fields exist.

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
