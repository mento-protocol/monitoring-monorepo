---
title: PR Ready State
status: active
owner: eng
last_verified: 2026-05-21
---

# PR Ready State

`pnpm pr:ready-state` is the shared readiness probe for Claude Code and Codex
PR babysitting. It should answer one question: is the PR ready to report as
all-clear right now?

The command must be the source of truth before either agent signals all-clear.
Agent-specific loops can still gather extra context or post replies, but their
final readiness decision should come from this command so Claude and Codex do
not drift.

## Readiness model

Readiness is driven by the raw GitHub status rollup plus required review gates.
Do not block on slow optional signals unless GitHub branch protection makes
them required for the current PR.

Required blockers:

- Required check runs or status contexts that are failing, pending, queued, or
  missing from the branch-protection rollup.
- Required GitHub review state, including requested changes.
- Unreplied review comments that repo policy requires agents to answer.
- The Codex PR-description approval gate for the current head.

Optional signals:

- Cursor Bugbot or other advisory bot reviews when they are not required by
  branch protection.
- Non-required check runs, flaky advisory jobs, or lint/report jobs configured
  outside the required status rollup.
- Older bot comments or reviews that do not apply to the current head, provided
  every required current-head comment has been handled.

Cursor Bugbot commonly lags behind the raw status rollup. Treat that lag as a
separate advisory state: report it in the readiness output, but do not hold the
all-clear on it unless the Cursor check or review is required by branch
protection.

## Expected CLI contract

`pnpm pr:ready-state` must expose a stable JSON shape for agent loops via
`--json`. Human formatting is allowed as the default for interactive use, but
Claude and Codex babysitters should always pass `--json`.

Suggested invocation:

```bash
pnpm pr:ready-state [<number-or-url>] [--pr <number-or-url>] [--repo <owner/name>] [--json]
```

Expected top-level fields:

```json
{
  "ready": false,
  "pr": {
    "number": 123,
    "url": "https://github.com/mento-protocol/monitoring-monorepo/pull/123",
    "title": "Tighten PR readiness checks",
    "isDraft": false,
    "headRefName": "chore/pr-ready-state",
    "headRefOid": "abcdef1",
    "baseRefName": "main",
    "mergeable": "MERGEABLE",
    "reviewDecision": "APPROVED"
  },
  "required": {
    "ready": false,
    "blockers": [
      {
        "kind": "check",
        "name": "trunk",
        "state": "pending",
        "required": true,
        "url": "https://github.com/..."
      }
    ]
  },
  "optional": {
    "ready": false,
    "items": [
      {
        "kind": "review",
        "name": "Cursor Bugbot",
        "state": "pending",
        "required": false,
        "url": "https://github.com/..."
      }
    ]
  },
  "gates": {
    "codexDescriptionApproval": {
      "ready": false,
      "required": true,
      "state": "missing"
    },
    "reviewCommentReplies": {
      "ready": true,
      "required": true,
      "unrepliedCount": 0
    }
  },
  "summary": "Required check trunk is still pending; Cursor Bugbot is advisory and still pending."
}
```

Field expectations:

- `ready`: `true` only when every required blocker is clear. Optional lag must
  not flip this to `false`.
- `required.ready`: mirrors the required-only decision and should be the value
  agents use for all-clear.
- `required.blockers[]`: only required blockers. Every item needs `kind`,
  `name`, `state`, `required: true`, and a URL when GitHub provides one.
- `optional.items[]`: advisory signals worth reporting separately. Every item
  needs `kind`, `name`, `state`, and `required: false`.
- `gates`: named repo-policy gates that are not obvious from raw check status.
  Each gate should say whether it is required for readiness.
- `summary`: one concise human-readable sentence suitable for a babysitter
  status update.

## Agent workflow

1. Sweep feedback surfaces and reply to all review comments.
2. Run `pnpm pr:ready-state --pr <number> --json`.
3. If `ready` is false, fix or wait only on `required.blockers` and required
   `gates`.
4. Report optional lag separately, especially Cursor Bugbot lag.
5. Signal all-clear only after `ready` is true for the current head.

Claude Code and Codex intentionally use the same command and readiness fields.
Differences between Claude `Monitor` wiring and Codex polling should stay
outside the readiness decision.
