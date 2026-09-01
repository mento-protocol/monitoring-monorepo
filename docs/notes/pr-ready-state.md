---
title: PR Ready State
status: active
owner: eng
canonical: true
last_verified: 2026-08-31
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# PR Ready State

`pnpm pr:ready-state` is the shared required-readiness probe for Claude Code and
Codex PR babysitting. It answers whether the current head's required GitHub and
repo-policy gates are clear.

The command is the final required-gate source of truth, not a replacement for
the feedback sweep. Before either agent signals all-clear, `pr:feedback-state`
must have a clean feedback ledger and the subsequent current-head
`pr:ready-state` result must be ready. Agent-specific loops may gather extra
context or post replies, but they must preserve that two-projection contract.

The probe shells out to gh, so it cannot run in Claude cloud sessions whose
proxy blocks GraphQL and where gh is not reliably available. A variant passing
the REST + GraphQL + `--slurp` capability gate runs it as written, with
`--repo <owner/name>` because gh cannot infer the repo from the proxy remote.
Blocked sessions use the MCP emulation in
[`github-tooling-surfaces.md`](github-tooling-surfaces.md) and label their
all-clear MCP-emulated rather than probe-verified.

## Readiness model

Readiness is driven by the raw GitHub status rollup plus required review gates.
Do not block on slow optional signals unless GitHub branch protection makes
them required for the current PR.

Required blockers:

- Closed-unmerged PRs. Merged PRs are terminal-ready and short-circuit the
  expensive sweep, since nothing is left to fix or wait on. A closed-unmerged PR
  reports only the terminal `state` blocker; review gates go non-required
  because no Codex or reviewer action can unblock it.
- Required check runs or status contexts that are failing, pending, queued, or
  missing from the branch-protection rollup.
- Branch-protection context lookup failures from unreadable or unauthorized
  protection data; the probe fails closed rather than guessing
  required-vs-optional status. On GitHub's `Branch not protected (HTTP 404)`
  response from the classic endpoint, it reads active branch rulesets and
  derives required status contexts from any `required_status_checks` and named
  `workflows` rule before using the fallback split.
- Required GitHub review state, including requested changes or required review
  still pending.
- Unreplied review comments that repo policy requires agents to answer. A direct
  reply satisfies this gate from the PR author, the Codex review bot, or a
  different human GitHub `OWNER`, `MEMBER`, or `COLLABORATOR`, so a maintainer
  can take over a teammate's PR without borrowing their credentials. A
  reviewer's reply to their own root comment does not satisfy it, and neither
  does an untrusted contributor or a bot merely carrying a trusted association.
- The Codex PR-description approval gate for the current head. The bot `+1`
  reaction must be created at or after the current-head update lower bound:
  the head commit's GitHub push timestamp when available, otherwise the first
  current-head check/status observation timestamp.
- A human break-glass override, for that Codex gate alone, when Codex review is
  externally blocked and the rest of the required surface is clean. It must be a
  PR comment from a GitHub `OWNER`, `MEMBER`, or `COLLABORATOR` human author:

  ```text
  /pr-ready-override gate=codex-description-approval head=<full-head-sha> reason=<why this is safe>
  ```

  The override is scoped to the exact current head SHA, so any new push expires
  it. It reports gate state `overridden` with `readinessOverrides[]` evidence
  rather than hiding as a normal Codex approval, and never overrides failing or
  pending required checks, merge conflicts, draft state, requested changes,
  unresolved review threads, or unreplied review comments.

Optional signals:

- Legacy Cursor Bugbot checks on PRs opened before its 2026-08-31 disablement,
  when branch protection does not require them.
- Non-required check runs, flaky advisory jobs, or lint/report jobs outside the
  required status rollup.
- Older bot comments or reviews that do not apply to the current head, once
  every required current-head comment has been handled.

Legacy Cursor Bugbot check lag can still appear on PRs opened before its
2026-08-31 disablement. Report the check as advisory, but do not hold the
all-clear on it unless branch protection requires it. Actionable Cursor
feedback and an aggregate `CHANGES_REQUESTED` verdict remain required blockers.

CodeRabbit's `CodeRabbit` check context (ADR 0066) is advisory the same way,
with one added trap: it reports `SUCCESS` even when no review ran. A
rate-limited push gets a PR comment carrying
`<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->`
and the check still passes. That combination means "no review ran," not
"reviewed and clean" — read the comment, not the check conclusion, and rerun
`pr:feedback-state` once a later push clears the rate limit.
`.coderabbit.yaml` leaves `request_changes_workflow` at its `false` default, so
CodeRabbit submits no GitHub `CHANGES_REQUESTED` review today. Turn that on and
such a review will not clear itself on a later clean push; it needs the same
manual fix as any stuck bot verdict:
`gh api repos/<owner>/<repo>/pulls/<pr>/reviews/<review_id>/dismissals -X PUT -f message='<why>' -f event=DISMISS`.

The JSON projections expose `gates.codeRabbitReviewSignal` with `missing`,
`requested`, `stale`, `reviewed`, or `not_applicable`. A `reviewed` signal
requires either a CodeRabbit review body with its `**Run ID**` marker and a
review commit equal to the full current head, or a trusted CodeRabbit top-level
clean-run block enclosed by `<!-- recent_review_start -->` and
`<!-- recent_review_end -->`. The clean-run block must contain the Run ID and a
reviewed commit range that ends at the full current head. Its comment update
time must be at or after the head update time. Empty review records, skipped
runs, and rate-limit notices do not count. A head-bound closeout request uses
this exact body:

```text
@coderabbitai review

<!-- coderabbit-final-head-review:<full-head-sha> -->
```

Only a request from an `OWNER`, `MEMBER`, or `COLLABORATOR`, or from a
recognized repository agent bot, counts as `requested`. A marker quoted by an
outside commenter does not suppress the real closeout request.

After the optional CodeRabbit check becomes terminal, refresh the projection
once. If the signal is `missing` or `stale`, re-resolve `headRefOid` immediately
before posting and require it to equal the marker head. A `requested` signal
suppresses ordinary duplicate posts for the same head. GitHub's issue-comment
API has no conditional-create operation, so the marker detects and suppresses on
a best-effort basis rather than claiming atomically. The CodeRabbit check and
review stay advisory: report a pending or rate-limited result as optional lag.
The rate limit is a shared quota, not a per-PR allowance.
[ADR 0066](../adr/0066-coderabbit-replaces-bugbot-third-reviewer.md) records
the two tiers: the free OSS tier meters per repository on a star-scaled 1–10
reviews/hour, a paid seat per developer identity across every PR that identity
opened. This org runs a paid Pro+ seat, so the ceiling is the identity's,
currently about 4 reviews/hour at this repo's volume. Either way, watching
several PRs draws down one allowance, so a re-request inside the window queues
or no-ops on whichever PR hits the limit first — do not tight-loop
`@coderabbitai review` posts waiting for a faster turnaround. If a requested
review finishes while the PR is still watched, rerun `pr:feedback-state` and
handle its findings before all-clear.

Some non-required workflows still post feedback that becomes a repo-policy
blocker after the required status surface is green. Their workflow status stays
optional; inline threads, unreplied review comments, and actionable top-level
bot feedback do not. `pr:feedback-state` owns that ledger, and `pr:ready-state`
does not project actionable top-level summaries into its required blockers.
Report a visibly in-progress review-producing workflow as optional lag, then
rerun `pr:feedback-state` once it is terminal so late feedback is not missed.

### Bounded clean-Claude protocol

`pr:feedback-state` keeps older exceptions in an exact compatibility registry.
Each entry binds the raw body digest to its Claude author, PR, comment, and
head, and may bind the source timestamp. PR #1965 comment 5355983385 needs one
because its composite heading, verdict emoji, and post-conclusion review-method
note fall outside the reusable grammar. It binds author `claude[bot]`, creation
time `2026-08-20T12:37:45Z`, head
`0884780bfe1d5ae8710a6f845c3a6199f1bf365d`, and body digest
`6ebf5de00fde8c46040def096e4c0c02ee0ab02b9fae20130e1ba8e6e84037e3`. A changed
body or binding cannot reuse it, and the compatibility test confirms the
general parser blocks that body without it.

Newer reviews go through a small prose-pattern library, which clears a review
only when **every line is positively recognized**. A recognized line is blank,
the Claude task-completion header, a thematic break, a review heading harvest
already validated, the single unhedged `Verdict: LGTM` or `Overall verdict:
LGTM` line, a bare `Findings` or `Roll-up` label, an explicit no-findings
conclusion, a `What I checked` heading, a ticked checklist entry whose subject
is one to three curated `SAFE_CLAUDE_CHECKLIST_TOPICS` entries joined by `and`
(or one of the four frozen `LEGACY_SAFE_CLAUDE_CHECKLIST_SUBJECT` phrases), or
a P3 line whose every clause matches the curated `POSITIVE_EVIDENCE` allowlist.
Anything else blocks, including narrative prose carrying no finding vocabulary.

Two consequences are deliberate and easy to trip over:

- **A clean review written as free prose blocks.** The observed PR #1848 body is
  the reference case, pinned blocking by test. It reads clean to a human, but
  its paragraphs assert nothing the gate can verify — and one asks the reader to
  confirm CI before merge.
- **A no-action marker alone is not a disposition.** `No action`, `None
blocking`, and similar leads need curated positive evidence behind them. The
  older behaviour, where the marker cleared a line on its own, let defects ride
  along.

A clean verdict or conclusion may end only in a bare sentence terminator or an
approval mark (`✅`, `✔️`, `👍`), allowed after the verdict word **or a
no-findings conclusion** — `No P1/P2 findings ✅` clears exactly as
`**Verdict:** LGTM ✅` does. One rule governs both tails so a second cannot fall
out of step. Any word after either blocks: a tail is unconstrained English, and
no term list separates praise from a defect stated plainly.

A `What I checked` checklist reads one definition whether or not the body also
carries paired `Findings`/`Roll-up` headings. It is evidence of review, never
the conclusion: the body still needs an explicit no-findings line. An unticked
or negated box blocks, as does any subject outside the curated topic set.

The canonical registry and named phrase groups live in
`scripts/pr/pr-feedback-state-claude.mjs`, the only copy since D3 phase three
removed the flat wrapper fallback. Add a named phrase only with a real review
fixture and nearby blocking mutations; add a compatibility record only with a
byte-exact source fixture and single-field binding mutations. The library never
proves the meaning of arbitrary English — it refuses prose it cannot recognize,
and the registry is the escape hatch for one historical body. Current-head and
unresolved-feedback checks remain separate and mandatory.

## Expected CLI contract

`pnpm pr:ready-state` must expose a stable JSON shape for agent loops via
`--json`; human formatting stays the interactive default. Use
`--watch --compact` for low-noise foreground babysitting. `pnpm
pr:feedback-state` is the feedback-only projection for unresolved threads,
unreplied root review comments, blocking top-level bot feedback, contextual
top-level bot comments, normalized `findings[]`, and Codex gates. It replaces
ad hoc read-only `gh api` scraping during review sweeps.

Suggested invocation:

```bash
pnpm pr:ready-state [<number-or-url>] [--pr <number-or-url>] [--repo <[host/]owner/name>] [--json] [--compact] [--watch] [--until-ready]
pnpm --silent pr:feedback-state [<number-or-url>] [--pr <number-or-url>] [--repo <[host/]owner/name>] [--json] [--watch]
```

`--watch --json` emits one newline-separated JSON summary per poll; reserve it
for consumers that parse newline-delimited JSON and use `--watch --compact` for
human babysitting. Pass `pnpm --silent` for feedback-state machine consumers so
pnpm does not prepend its run-script banner. The `pr:feedback-state` Node entry
point always prints JSON, one compact object per poll in watch mode. Add
`--until-ready` to `pr:ready-state --watch` when the foreground loop should
exit on its own: it exits 0 once the summary is ready or the PR is merged,
nonzero for a closed-unmerged PR, and otherwise keeps polling. Without it,
watch mode runs until interrupted.

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
        "kind": "check",
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
    "codeRabbitReviewSignal": {
      "ready": false,
      "required": false,
      "state": "missing",
      "fallbackAction": "request_review_once_for_head_after_optional_check"
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
  "requiredChecks": [
    {
      "name": "ci",
      "state": "pass",
      "required": true
    }
  ],
  "requiredStatusContexts": [
    {
      "context": "ci",
      "integrationId": 15368
    }
  ],
  "codexReviewSignal": "in_flight",
  "codeRabbitReviewSignal": "missing",
  "summary": "Required check trunk is still pending; Cursor Bugbot is advisory and still pending."
}
```

Field expectations:

- `ready`: `true` only when every required blocker is clear. Optional lag must
  not flip it to `false`. A `MERGED` `pr.state` is terminal-ready; `CLOSED`
  without merge is terminal-blocked with a `state` blocker.
- `required.ready`: the required-readiness half of the decision. Use it only
  after `pr:feedback-state` has a clean ledger; alone it is not all-clear.
- `pr.state`: GitHub's PR state (`OPEN`, `MERGED`, or `CLOSED`). The probe reads
  it before fetching comments, reactions, check sources, and branch protection,
  so post-merge babysitting exits quickly and does not mistake GitHub's
  post-merge `mergeable: UNKNOWN` for a blocker.
- `pr.mergedAt` / `pr.closedAt`: terminal timestamps when GitHub provides them.
- Terminal closed PR summaries may use gate state `not_applicable` for gates
  normally required on open PRs. Act on the terminal `state` blocker instead of
  requesting more review.
- `required.blockers[]`: only required blockers. Every item needs `kind`,
  `name`, `state`, `required: true`, and a URL when GitHub provides one.
- `optional.items[]`: advisory signals worth reporting separately. Every item
  needs `kind`, `name`, `state`, and `required: false`.
- `requiredChecks[]`: the required subset of the status checks, the set
  `required.blockers[]` derives from. Each item has `name`, `required: true`,
  and a `classifyCheck()` `state` — `pass`, `fail`, `pending`, or `skipped`
  (a `NEUTRAL`/`SKIPPED` conclusion), so consumers tolerate all four. Count
  required checks from this field, never by filtering `statusChecks`: that
  grouping describes every check the PR has and carries no `required` flag, so
  a filter on one is a permanent zero. `pnpm pr:merge` reports its briefing
  counts from here.
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
  `blocking`. It is the feedback ledger for batching and deduplicating review
  follow-ups, not a replacement for the final `pr:ready-state` all-clear gate.
- `codexReviewSignal`: current-head Codex review state — `missing`,
  `requested`, `in_flight`, `stale`, or `approved`. `requested` means a
  current-head `@codex review` request exists with no bot reaction or review
  observed yet. `in_flight` means the current head has a Codex `eyes` reaction,
  review, or top-level result. `approved` means the final PR-description `+1`
  gate is present. `stale` means only older-head Codex signals exist.
- `codeRabbitReviewSignal`: current-head CodeRabbit review state — `missing`,
  `requested`, `stale`, `reviewed`, or `not_applicable`. The Readiness model
  section above defines what each state requires; a head-bound request stays
  `requested` until a real run lands.
- `requiredStatusContexts[]`: required check contexts from classic branch
  protection or branch rulesets. Ruleset-derived entries include status-check
  rules and required-workflow rules when their check names are present in the
  ruleset or resolvable from local workflow metadata. Entries preserve
  `integrationId` so a same-name check from the wrong GitHub App does not
  satisfy readiness.
- `summary`: one concise human-readable sentence suitable for a babysitter
  status update.

## Agent workflow

1. Sweep feedback surfaces and build the ledger before editing, then reply to
   every review comment with `Fixed in <commit> — <what changed>` or
   `Won't fix: <technical reason why>`. Never resolve a thread before replying.
2. Freeze the original request, target/owner, changed files, and non-test
   changed-line count as the scope baseline. Batch review fixes locally,
   auditing sibling surfaces before pushing. Classify additions as in-scope,
   follow-up, or stop; open an issue before deferring valid follow-up work, warn
   near twice the baseline, and do not pause solely for cycle count before five
   review-triggered patch cycles are complete. Pause for reclassification before
   starting a sixth.
3. Before invoking the gate, ensure no direct validation, dashboard server, or
   browser suite outside the coordinator is active on the same machine, and
   start no uncoordinated work there until the gate exits. Concurrent `--run`
   gates from other worktrees continue through the coordinator on shared
   weighted capacity. Use same-machine spare workers only for read-only work,
   and run validation outside the coordinator from a fully hydrated checkout on
   another machine. Run `pnpm agent:quality-gate --run` once for the batch.
4. For non-trivial behavioral, workflow, security, data-flow, or UI batches,
   run `pnpm agent:autoreview` as a structured source-review closeout at the
   batch boundary rather than as an inner loop. Verify accepted findings before
   editing, and rerun focused checks plus autoreview if those fixes change the
   batch. The target, prepared-bundle, isolation, and trust contracts live in
   [`agent-quality-gate-mechanics.md`](agent-quality-gate-mechanics.md); keep
   behavioral and runtime verification in the validation record.
5. Run the invocation pair above: `pnpm --silent pr:feedback-state` for the
   feedback sweep, then, once its ledger is clean, `pnpm pr:ready-state` for the
   final required-readiness decision. Add `--watch --compact --until-ready` to
   the readiness call for a foreground wait loop. Bind `--repo` to the base
   repository — checkout inference can select the wrong same-number PR on fork
   PRs.
6. If feedback-state `ready` is false, handle `requiredFeedbackBlockers`,
   `unresolvedReviewThreads`, `unrepliedRootReviewComments`,
   `blockingTopLevelBotComments`, and any non-ready required feedback `gates`.
   Scan `topLevelBotComments` for context too; deployment and status bot
   comments may be informational.
7. If ready-state `ready` is false, fix or wait only on `required.blockers` and
   required `gates`.
8. After the optional CodeRabbit check becomes terminal, refresh once. If
   `gates.codeRabbitReviewSignal.state` is `missing` or `stale`, post one
   head-bound closeout request with the body above. Do not post when the state
   is `requested` or `reviewed`.
9. Report optional lag separately, especially legacy Cursor Bugbot check lag and
   visibly in-progress review-producing workflows. If you are still watching the
   PR when one finishes, rerun `pr:feedback-state` to catch late feedback; do not
   treat the optional workflow status itself as a blocker.
10. After the CodeRabbit closeout step and any final optional-review refresh,
    rerun `pr:feedback-state` and then `pr:ready-state`. Signal all-clear only
    when feedback-state has no required blocker and ready-state `ready` is true
    for the current head.

Claude Code and Codex use the same command and readiness fields by design.
Differences between Claude `Monitor` wiring and Codex polling stay outside the
readiness decision.

Codex re-reviews new pushes automatically. Do not post `@codex review` as a
routine post-push action, and never post a duplicate while a current-head
request is `requested`, `in_flight`, or `approved`. A manual `@codex review` is
a fallback only when the current head has no Codex signal after the normal
automatic-review window.
If `chatgpt-codex-connector[bot]` replies that code-review usage limits are
reached, stop posting duplicates and check whether that reply is the
current-head Codex result. If it is, and approval is still missing, treat the
Codex PR-description approval as externally blocked even when
`codexReviewSignal` reports `in_flight`: quota or settings must change, or the
gate must be overridden with the head-scoped comment syntax above. If the limit
reply is only historical and the current head is `requested` or `in_flight` for
another Codex signal, keep watching until Codex approves, posts new feedback,
or the signal goes stale.
