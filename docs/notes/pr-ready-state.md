---
title: PR Ready State
status: active
owner: eng
canonical: true
last_verified: 2026-06-05
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
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

- Closed-unmerged PRs. Merged PRs are terminal-ready and short-circuit the
  expensive readiness sweep because there is nothing left to fix or wait on.
  Closed-unmerged PRs report only the terminal `state` blocker; review gates are
  non-required because no Codex or reviewer action can unblock a closed PR.
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
- A human break-glass override for the Codex PR-description approval gate only,
  when Codex review is externally blocked after the rest of the required
  readiness surface is clean. The override must be a PR comment from a GitHub
  `OWNER`, `MEMBER`, or `COLLABORATOR` human author:

  ```text
  /pr-ready-override gate=codex-description-approval head=<full-head-sha> reason=<why this is safe>
  ```

  The override is scoped to the exact current head SHA, so any new push expires
  it. It is reported as gate state `overridden` with `readinessOverrides[]`
  evidence; it is not hidden as a normal Codex approval. It never overrides
  failing or pending required checks, merge conflicts, draft state, requested
  changes, unresolved review threads, or unreplied review comments.

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

Some non-required workflows still post review feedback that can become required
repo-policy blockers after the required status surface is already green. For
example, an in-progress `auto-review` job does not block by status alone, but it
can later create inline threads, unreplied review comments, or actionable
top-level bot feedback. The probe result remains the readiness source of truth:
do not block `ready` on those workflows unless branch protection makes them
required. If one is visibly in progress during handoff, report it as optional
lag; when you are still babysitting the PR anyway, rerun `pr:feedback-state`
after it reaches a terminal state so late feedback is not missed.

## Expected CLI contract

`pnpm pr:ready-state` must expose a stable JSON shape for agent loops via
`--json`. Human formatting is allowed as the default for interactive use. Use
`--watch --compact` for low-noise foreground babysitting. `pnpm
pr:feedback-state` is the feedback-only projection for unresolved threads,
unreplied root review comments, blocking top-level bot feedback, contextual
top-level bot comments, normalized `findings[]`, and Codex gates; it is
intended to replace ad hoc read-only `gh api` scraping during review sweeps.

Suggested invocation:

```bash
pnpm pr:ready-state [<number-or-url>] [--pr <number-or-url>] [--repo <[host/]owner/name>] [--json] [--compact] [--watch] [--until-ready]
pnpm --silent pr:feedback-state [<number-or-url>] [--pr <number-or-url>] [--repo <[host/]owner/name>] [--json] [--watch]
```

`--watch --json` emits one JSON summary per poll, separated by newlines. Use
`--watch --compact` for human babysitting and reserve JSON output for machine
consumers that can parse newline-delimited JSON. Use `pnpm --silent` for
feedback-state machine consumers so pnpm does not prepend its run-script
banner. The `pr:feedback-state` Node entry point always prints JSON; in watch
mode it emits one compact JSON object per poll. Add `--until-ready` to
`pr:ready-state --watch` when the foreground loop should exit automatically:
it exits 0 once the summary is ready or the PR is merged, exits nonzero for a
closed-unmerged PR, and otherwise keeps polling. Without `--until-ready`, watch
mode keeps the existing behavior and runs until interrupted.

Expected top-level fields:

```json
{
  "ready": false,
  "pr": {
    "number": 123,
    "url": "https://github.com/mento-protocol/monitoring-monorepo/pull/123",
    "title": "Tighten PR readiness checks",
    "state": "OPEN",
    "isDraft": false,
    "headRefName": "chore/pr-ready-state",
    "headRefOid": "abcdef1",
    "headUpdatedAt": "2026-05-21T13:22:23.000Z",
    "baseRefName": "main",
    "mergeable": "MERGEABLE",
    "reviewDecision": "APPROVED",
    "mergedAt": null,
    "closedAt": null
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
  not flip this to `false`. A PR whose `pr.state` is `MERGED` is terminal-ready;
  a PR whose `pr.state` is `CLOSED` without merge is terminal-blocked with a
  `state` blocker.
- `required.ready`: mirrors the required-only decision and should be the value
  agents use for all-clear.
- `pr.state`: GitHub's PR state (`OPEN`, `MERGED`, or `CLOSED`). The probe uses
  this before fetching comments, reactions, check sources, and branch
  protection so post-merge babysitting exits quickly and does not mistake
  GitHub's post-merge `mergeable: UNKNOWN` for a blocker.
- `pr.mergedAt` / `pr.closedAt`: terminal timestamps when GitHub provides them.
- Terminal closed PR summaries may use gate state `not_applicable` for gates
  that are normally required on open PRs. Agents should act on the terminal
  `state` blocker instead of requesting more review.
- `required.blockers[]`: only required blockers. Every item needs `kind`,
  `name`, `state`, `required: true`, and a URL when GitHub provides one.
- `optional.items[]`: advisory signals worth reporting separately. Every item
  needs `kind`, `name`, `state`, and `required: false`.
- `gates`: named repo-policy gates that are not obvious from raw check status.
  Each gate should say whether it is required for readiness.
- `readinessOverrides[]`: active human break-glass overrides that affected a
  gate. Each entry includes `gate`, exact `head`, `reason`, `author`, URL, and
  timestamp. Empty means no override was applied.
- `pr:feedback-state` adds `findings[]`: normalized review findings from inline
  review threads, root review comments, and actionable top-level bot comments or
  review bodies. Each entry has a stable `fingerprint`, `source`, `sourceId`,
  `author`, URL/location fields, a short `title`/`excerpt`, `state`, and
  booleans for `currentHead`, `outdated`, `replied`, `unresolved`, and
  `blocking`. Use it as the feedback ledger for batching and deduplicating
  review follow-ups; do not treat it as a replacement for the final
  `pr:ready-state` all-clear gate.
- `codexReviewSignal`: current-head Codex review state. Values are
  `missing`, `requested`, `in_flight`, `stale`, and `approved`. `requested`
  means a current-head `@codex review` request exists but no bot reaction or
  review has been observed yet. `in_flight` means the current head has a Codex
  `eyes` reaction, a current-head Codex review, or a current-head Codex
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
   run `pnpm agent:autoreview` as a structured closeout review. The command is
   a repo adapter for the pinned helper at `scripts/agent-autoreview.mjs`.
   Verify accepted findings before editing; if review-triggered fixes change
   code, rerun focused checks and autoreview once for that fixed batch. Inside
   an active Codex sandbox, the adapter defaults to the helper's local
   deterministic engine unless an engine is passed explicitly, because nested
   `codex exec` is unavailable there. For a true fresh-context Codex semantic
   pass, run `pnpm agent:autoreview --prepare-bundle-dir <dir>` and hand the
   generated bundle to the reviewer; use a directory outside the repo worktree
   so local-mode bundles do not include themselves. Add
   `--feedback-pr <number>` when the batch responds to PR feedback so the
   feedback ledger is included.
5. Run `pnpm --silent pr:feedback-state --pr <number> --json` for a feedback-only sweep,
   or `pnpm pr:ready-state --pr <number> --json` for the final readiness
   source of truth. For a foreground wait loop, use
   `pnpm pr:ready-state --pr <number> --watch --compact --until-ready`.
6. If feedback-state `ready` is false, inspect and handle
   `requiredFeedbackBlockers`, `unresolvedReviewThreads`,
   `unrepliedRootReviewComments`, `blockingTopLevelBotComments`, and any
   non-ready required feedback `gates`. Also scan `topLevelBotComments` as
   context; deployment/status bot comments may be informational.
7. If ready-state `ready` is false, fix or wait only on `required.blockers` and
   required `gates`.
8. Report optional lag separately, especially Cursor Bugbot lag and visibly
   in-progress review-producing workflows. If you are still watching the PR when
   one finishes, rerun `pr:feedback-state` to catch late feedback; do not treat
   the optional workflow status itself as a blocker.
9. Signal all-clear only after final ready-state `ready` is true for the
   current head.

Claude Code and Codex intentionally use the same command and readiness fields.
Differences between Claude `Monitor` wiring and Codex polling should stay
outside the readiness decision.

Codex re-reviews new pushes automatically. Do not post `@codex review` as a
routine post-push action, and never post duplicate review requests while an
existing current-head request is `requested`, `in_flight`, or `approved`. A
manual `@codex review` is only a fallback when the current head has no Codex
signal after the normal automatic-review window.
If `chatgpt-codex-connector[bot]` replies that code-review usage limits are
reached, stop posting duplicate `@codex review` requests and inspect whether
the limit reply is the current-head Codex result. If it is current-head and
approval is still missing, treat the Codex PR-description approval as
externally blocked even if `codexReviewSignal` reports `in_flight`; quota or
settings must change, or the gate must be intentionally overridden with the
head-scoped comment syntax above. If the limit reply is only historical and the
current head is `requested` or `in_flight` for another Codex signal, keep
watching until Codex approves, posts new feedback, or the signal becomes stale.

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
