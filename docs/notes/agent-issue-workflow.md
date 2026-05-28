---
title: Agent Issue Workflow
status: active
owner: eng
canonical: true
last_verified: 2026-05-28
---

# Agent Issue Workflow

GitHub Issues are the active-work queue for agent-addressable tasks. The ready
queue is:

```text
is:issue is:open label:agent-ready -label:agent-active -label:in-pr
```

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
4. When an agent starts work, remove `agent-ready` and add `agent-active` before
   substantive edits.
5. When opening a PR, remove `agent-active` and add `in-pr`.
6. On merge, GitHub closes issues referenced with closing keywords.
7. If the PR closes unmerged, remove `in-pr` and restore `agent-ready` only when
   the remaining work is still clear; otherwise use `needs-grooming`.

For partial work, keep the issue open. Remove `in-pr` after merge and set
`agent-ready` or `needs-grooming` based on the remaining acceptance criteria.

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
