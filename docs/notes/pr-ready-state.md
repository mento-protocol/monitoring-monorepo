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
- Branch-protection context lookup failures caused by unreadable or
  unauthorized protection data; the probe fails closed rather than guessing
  required-vs-optional status. If the classic branch-protection endpoint returns
  GitHub's `Branch not protected (HTTP 404)` response, the probe reads active
  branch rulesets and derives required status contexts from any
  `required_status_checks` and named `workflows` rule before using the fallback
  split.
- Required GitHub review state, including requested changes or required review
  still pending.
- Unreplied review comments that repo policy requires agents to answer.
- The Codex PR-description approval gate for the current head. The bot `+1`
  reaction must be created at or after the current-head update lower bound:
  the head commit's GitHub push timestamp when available, otherwise the first
  current-head check/status observation timestamp.

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
`--json`. Human formatting is allowed as the default for interactive use. Use
`--watch --compact` for low-noise foreground babysitting.

Suggested invocation:

```bash
pnpm pr:ready-state [<number-or-url>] [--pr <number-or-url>] [--repo <[host/]owner/name>] [--json] [--compact] [--watch]
```

`--watch --json` emits one JSON summary per poll, separated by newlines. Use
`--watch --compact` for human babysitting and reserve JSON output for machine
consumers that can parse newline-delimited JSON.

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
    "headUpdatedAt": "2026-05-21T13:22:23.000Z",
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
    "codexReviewSignal": {
      "ready": true,
      "required": false,
      "state": "in_flight",
      "fallbackAction": "wait"
    },
    "reviewCommentReplies": {
      "ready": true,
      "required": true,
      "unrepliedCount": 0
    },
    "reviewThreads": {
      "ready": true,
      "required": true,
      "unresolvedCount": 0
    }
  },
  "requiredStatusContexts": [
    {
      "context": "ci",
      "integrationId": 15368
    }
  ],
  "codexReviewSignal": "in_flight",
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
- `codexReviewSignal`: current-head Codex review-request state. Values are
  `missing`, `requested`, `in_flight`, `stale`, and `approved`. `requested`
  means a current-head `@codex review` request exists but no bot reaction or
  review has been observed yet. `in_flight` means the current-head request has
  a Codex `eyes` reaction, a current-head Codex review, or a current-head Codex
  top-level result. `approved` means the final PR-description `+1` gate is
  present. `stale` means only older-head Codex signals exist.
- `requiredStatusContexts[]`: required check contexts from classic branch
  protection or branch rulesets. Ruleset-derived entries include status-check
  rules and required-workflow rules when their check names are present in the
  ruleset or resolvable from local workflow metadata. Entries preserve
  `integrationId` so a same-name check from the wrong GitHub App does not
  satisfy readiness.
- `summary`: one concise human-readable sentence suitable for a babysitter
  status update.

## Agent workflow

1. Sweep feedback surfaces and reply to all review comments.
2. Batch review fixes locally, auditing sibling surfaces before pushing.
3. Run the mapped local gate once for the batch.
4. For non-trivial behavioral, workflow, security, data-flow, or UI batches,
   run `pnpm agent:autoreview` as a structured closeout review. Verify accepted
   findings before editing; if review-triggered fixes change code, rerun focused
   checks and autoreview once for that fixed batch.
5. Run `pnpm pr:ready-state --pr <number> --json`. For a foreground wait loop,
   use `pnpm pr:ready-state --pr <number> --watch --compact`.
6. If `ready` is false, fix or wait only on `required.blockers` and required
   `gates`.
7. Report optional lag separately, especially Cursor Bugbot lag.
8. Signal all-clear only after `ready` is true for the current head.

Claude Code and Codex intentionally use the same command and readiness fields.
Differences between Claude `Monitor` wiring and Codex polling should stay
outside the readiness decision.

Codex re-reviews new pushes automatically. Do not post `@codex review` as a
routine post-push action, and never post duplicate review requests while an
existing current-head request is `requested`, `in_flight`, or `approved`. A
manual `@codex review` is only a fallback when the current head has no Codex
signal after the normal automatic-review window.

## Babysitting Speed Discipline

- Build a feedback ledger before editing, then batch sibling fixes before the
  next push.
- Avoid broad bot review as an inner loop; use review at batch boundaries.
- Use `pnpm agent:autoreview` for local structured closeout on non-trivial
  batches before pushing, not as a replacement for `pr:ready-state`.
- Cap manual Codex fallback to one request per head.
- If `codexReviewSignal` is `requested` or `in_flight`, wait instead of posting
  another `@codex review`.
- Declare all-clear from the required-only readiness result, not from optional
  reviewer lag clearing first.
