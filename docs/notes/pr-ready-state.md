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
proxy blocks GraphQL and where gh is not reliably available; a variant passing the REST + GraphQL +
`--slurp` capability gate runs it as written, passing `--repo <owner/name>`
since gh cannot infer the repo from the proxy remote. Blocked sessions use
the MCP emulation documented in
[`github-tooling-surfaces.md`](github-tooling-surfaces.md) and label their
all-clear MCP-emulated rather than probe-verified.

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
- Unreplied review comments that repo policy requires agents to answer. A
  direct reply satisfies this gate when it comes from the PR author, the Codex
  review bot, or a different human GitHub `OWNER`, `MEMBER`, or
  `COLLABORATOR`. This lets a maintainer take over a teammate's PR without
  borrowing the original author's credentials. A reviewer's reply to their own
  root comment does not satisfy the gate, and neither does a reply from an
  untrusted contributor or a bot merely carrying a trusted association.
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

- Non-required check runs, flaky advisory jobs, or lint/report jobs configured
  outside the required status rollup.
- Older bot comments or reviews that do not apply to the current head, provided
  every required current-head comment has been handled.

Cursor BugBot is disabled and its compatibility paths retired on 2026-09-02,
after a live sweep of the four open PRs found no Cursor comment, review, or
check. `cursor[bot]` is out of the feedback-state bot roster, `Cursor Bugbot`
is out of the optional-check allowlist, and the unused `BUGBOT_BUG_ID`
alternative is out of both actionable-marker regexes.

Read the scope of that narrowly. Only the **top-level** comment and review-body
ledger consults the bot roster, so only a stray top-level Cursor comment is now
ignored. Inline surfaces stay author-agnostic: an unresolved Cursor review
thread or an unreplied Cursor root inline comment still blocks exactly like any
other author's, which matters because every Cursor finding this repo recorded
was inline. An aggregate `CHANGES_REQUESTED` verdict also remains a required
blocker whichever reviewer filed it.

A stray `Cursor Bugbot` check is now an unrecognized context: optional whenever
branch protection reports required contexts that do not name it, and required
in the fallback path that runs when those contexts are unavailable. That
fallback path already reports a `branch-protection` required blocker of its
own, so the reclassification cannot make a PR fail on its own.

CodeRabbit's `CodeRabbit` check context (ADR 0066) is advisory the same way,
with one added trap: it reports `SUCCESS` even when no review ran. A
rate-limited push gets a PR comment carrying
`<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->`
and the check still passes. A passing `CodeRabbit` check alongside a
current-head rate-limit comment means "no review ran," not "reviewed and
clean" — read the comment, not the check conclusion, and rerun
`pr:feedback-state` once a later push clears the rate limit.
`.coderabbit.yaml` leaves `request_changes_workflow` at its `false` default,
so CodeRabbit does not submit a GitHub `CHANGES_REQUESTED` review today. If
that setting is ever turned on, a `CHANGES_REQUESTED` review does not clear
itself on a later clean push and needs the same manual fix as any other
stuck bot review verdict: dismiss it with
`gh api repos/<owner>/<repo>/pulls/<pr>/reviews/<review_id>/dismissals -X PUT -f message='<why>' -f event=DISMISS`.

The JSON projections expose `gates.codeRabbitReviewSignal` with `missing`,
`requested`, `stale`, `reviewed`, or `not_applicable`. A `reviewed` signal
requires either a CodeRabbit review body with its `**Run ID**` marker and a
review commit equal to the full current head, or a trusted CodeRabbit top-level
clean-run block enclosed by `<!-- recent_review_start -->` and
`<!-- recent_review_end -->`. The clean-run block must contain the Run ID and a
reviewed commit range that ends at the full current head. Its comment update
time must be at or after the head update time. Empty review records, skipped
runs, and rate-limit notices do not count.

A trusted path-filter skip is `not_applicable` only when the CodeRabbit comment
contains exactly one summary marker followed by one skip-start marker and one
skip-end marker. The exact `Review was skipped due to path filters` text, one
non-empty counted ignored-file block, and one Run ID must appear in that order
between the skip markers. The comment update time must be at or after the
current-head update time. The probe then fetches every page of the current PR
file list and re-reads the PR head. The ignored paths must be unique and equal
the complete current file set, and all declared and API file counts must agree.
The gate returns `reason: path_filters`, `sourceUrl`, and `ignoredPaths` with
state `not_applicable`, readiness `true`, and `fallbackAction: wait`. A generic
`No files to review` reply, incremental no-change reply, rate-limit notice,
free-tier notice, malformed count, incomplete page set, file-set mismatch,
stale comment, or changed head fails closed and does not suppress a review
request.

A head-bound closeout request uses this exact body:

```text
@coderabbitai review

<!-- coderabbit-final-head-review:<full-head-sha> -->
```

Only a request from an `OWNER`, `MEMBER`, or `COLLABORATOR`, or from a
recognized repository agent bot, counts as `requested`. A marker quoted by an
outside commenter does not suppress the real closeout request.

After the optional CodeRabbit check becomes terminal, refresh the projection
once. Batch fixes before the push and wait for that automatic review attempt
before requesting another review. That wait is bounded by the babysit deadline:
a check that never starts, or is still pending when the deadline arrives, is
optional lag, not a reason to keep waiting. If the signal is `missing` or
`stale`, re-resolve `headRefOid` immediately before posting and require it to
equal the marker head. Post at most one marked request for that head. A
`requested`, `reviewed`, or `not_applicable` signal suppresses another post.
GitHub's issue-comment API has no conditional-create operation, so the marker is
a detection and best-effort suppression mechanism rather than an atomic claim.
The CodeRabbit check and review remain advisory: report a pending or
rate-limited result as optional lag. The rate limit is a shared quota, not a
per-PR allowance.
[ADR 0066](../adr/0066-coderabbit-replaces-bugbot-third-reviewer.md) records
the two tiers: the free OSS tier meters per repository on a star-scaled 1–10
reviews/hour, and a paid seat meters per developer identity across every PR
that identity opened. This org runs a paid Pro+ seat, so the ceiling is the
identity's, currently about 4 reviews/hour at this repo's review volume.
Either way, watching several PRs at once draws down one allowance, so a
re-request inside the window queues or no-ops on whichever PR reaches the
limit first — do not tight-loop `@coderabbitai review` posts waiting for a
faster turnaround. If a requested review finishes while the PR is still under
watch, rerun `pr:feedback-state` and handle its findings before all-clear.

Some non-required workflows still post feedback that becomes a repo-policy
blocker after the required status surface is green. Their workflow status stays
optional, but inline threads, unreplied review comments, and actionable
top-level bot feedback do not. `pr:feedback-state` owns that ledger;
`pr:ready-state` does not project actionable top-level summaries into its
required blockers. If a review-producing workflow is visibly in progress,
report it as optional lag and rerun `pr:feedback-state` after it reaches a
terminal state so late feedback is not missed.

### Bounded clean-Claude protocol

`pr:feedback-state` keeps older exceptions in an exact compatibility registry.
Each entry binds the raw body digest to its Claude author, PR, comment, and
head. An entry can also bind the source timestamp. PR #1965 comment 5355983385
uses an exact record because its composite heading, verdict emoji, and
post-conclusion review-method note stay outside the reusable grammar. The
record binds author `claude[bot]`, creation time `2026-08-20T12:37:45Z`, head
`0884780bfe1d5ae8710a6f845c3a6199f1bf365d`, and raw body digest
`6ebf5de00fde8c46040def096e4c0c02ee0ab02b9fae20130e1ba8e6e84037e3`.
A changed body or binding cannot reuse this record. The compatibility test also
confirms that the general parser blocks the body without the exact record.

Newer reviews go through a small prose-pattern library instead.

The library clears a review only when **every line is positively recognized**.
A line is recognized when it is blank, the Claude task-completion header, a
thematic break, a review heading that harvest already validated, the single
unhedged `Verdict: LGTM` or `Overall verdict: LGTM` line, a bare `Findings` or
`Roll-up` section label, an explicit no-findings conclusion, a `What I checked`
checklist heading, a ticked checklist entry whose subject is one to three
curated `SAFE_CLAUDE_CHECKLIST_TOPICS` entries joined by `and` (or one of the
four frozen `LEGACY_SAFE_CLAUDE_CHECKLIST_SUBJECT` phrases), or a P3 line whose
every clause matches the curated `POSITIVE_EVIDENCE` allowlist. Anything else
blocks, including ordinary narrative prose that carries no finding vocabulary.

Two consequences are deliberate and easy to trip over:

- **A clean review written as free prose blocks.** The observed PR #1848 body
  is the reference case and is pinned blocking by test. It reads clean to a
  human, but its narrative paragraphs assert nothing the gate can verify — and
  one of them in fact asks the reader to confirm CI before merge.
- **A no-action marker alone is not a disposition.** `No action`, `None
blocking`, and similar leads must be followed by curated positive evidence.
  The older behaviour, where such a marker cleared a line on its own, let a
  defect ride along behind it.

A clean verdict or conclusion may end only in a bare sentence terminator, or an
approval mark as described below. Any trailing sentence blocks, because a tail
is unconstrained English and no term list separates praise from a defect stated
plainly.

A `What I checked` checklist is recognized whether or not the body also carries
paired `Findings`/`Roll-up` headings — the standalone form and the preamble form
read one definition. The checklist is evidence of review, never the conclusion:
the body still needs an explicit no-findings line. An unticked or negated box
blocks, and so does any subject outside the curated topic set, since a free
subject is unconstrained English.

A trailing approval mark (`✅`, `✔️`, `👍`) is allowed after the verdict word
**or a no-findings conclusion** — `No P1/P2 findings ✅` clears exactly as
`**Verdict:** LGTM ✅` does. A mark asserts nothing a reader could act on, and
one rule governs both tails deliberately: the two are the same question, and a
second rule would be a second thing to keep in step. Any word after either is
prose and still blocks.

The canonical registry and named phrase groups live in
`scripts/pr/pr-feedback-state-claude.mjs`, which is now the only copy: D3 phase
three removed the flat wrapper fallback. Add a named phrase only with a real
review fixture and nearby blocking mutations. Add a compatibility record only
with a byte-exact source fixture and single-field binding mutations. The library does not try to prove the meaning
of arbitrary English prose — it refuses prose it cannot recognize, and the
compatibility registry is the escape hatch for a specific historical body.
Current-head and unresolved-feedback checks remain separate and mandatory.

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
        "kind": "check",
        "name": "GraphQL schema diff",
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
      "ready": true,
      "required": false,
      "state": "not_applicable",
      "fallbackAction": "wait",
      "reason": "path_filters",
      "sourceUrl": "https://github.com/...",
      "ignoredPaths": ["docs/evals/example.jsonl"]
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
  "codeRabbitReviewSignal": "not_applicable",
  "summary": "1 required blocker(s) remain."
}
```

Field expectations:

- `ready`: `true` only when every required blocker is clear. Optional lag must
  not flip this to `false`. A PR whose `pr.state` is `MERGED` is terminal-ready;
  a PR whose `pr.state` is `CLOSED` without merge is terminal-blocked with a
  `state` blocker.
- `required.ready`: mirrors the required-readiness half of the decision. Agents
  use it only after `pr:feedback-state` has a clean feedback ledger; it is not
  sufficient for all-clear by itself.
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
- `codeRabbitReviewSignal`: current-head CodeRabbit review state. Values are
  `missing`, `requested`, `stale`, `reviewed`, and `not_applicable`. A
  CodeRabbit review with a run marker and review commit equal to the current
  head is `reviewed`. A trusted top-level clean-run block also counts when
  `<!-- recent_review_start -->` and `<!-- recent_review_end -->` enclose it, it
  contains a Run ID, its full commit range ends at the current head, and its
  comment update time is at or after the current head update time. Empty
  reply-only reviews, skipped runs, and rate-limit notices do not count. A
  head-bound request is `requested` until a real run lands. A validated
  path-filter skip is `not_applicable`; its gate includes `reason`, `sourceUrl`,
  and `ignoredPaths` as described above.
- `requiredStatusContexts[]`: required check contexts from classic branch
  protection or branch rulesets. Ruleset-derived entries include status-check
  rules and required-workflow rules when their check names are present in the
  ruleset or resolvable from local workflow metadata. Entries preserve
  `integrationId` so a same-name check from the wrong GitHub App does not
  satisfy readiness.
- `summary`: one concise human-readable sentence suitable for a babysitter
  status update.

## Agent workflow

1. Sweep feedback surfaces and build the feedback ledger before editing, then
   reply to every review comment. Use `Fixed in <commit> — <what changed>` or
   `Won't fix: <technical reason why>`; never resolve a thread before replying.
2. Freeze the original request, target/owner, changed files, and non-test
   changed-line count as the scope baseline. Batch review fixes locally,
   auditing sibling surfaces before pushing. Classify additions as in-scope,
   follow-up, or stop; open an issue before deferring valid follow-up work, warn
   near twice the baseline, and do not pause solely for cycle count before five
   review-triggered patch cycles are complete. Pause for reclassification before
   starting a sixth.
3. Before invoking the gate, ensure that no direct validation, dashboard server,
   or browser suite outside the coordinator is active on the same machine.
   Concurrent `--run` gates from other worktrees can continue through the
   coordinator. They share weighted machine capacity. From invocation until
   this gate exits, do not start uncoordinated work there. Use same-machine spare
   workers only for read-only work. Run the gate or gates from operating-card
   step 3. Local PRs and hosted non-fork PRs targeting `origin/main` run one
   pass. Hosted fork and stacked PRs run the resolved-base pass and the separate
   `origin/main` hook warm. Run validation outside the coordinator from a fully
   hydrated checkout on another machine.
4. For non-trivial behavioral, workflow, security, data-flow, or UI batches,
   run `pnpm agent:autoreview` as a structured source-review closeout at the
   batch boundary rather than as an inner loop. Verify accepted findings before
   editing and rerun focused checks plus autoreview if those fixes change the
   batch. The exact target, prepared-bundle, isolation, and trust contracts live
   in [`agent-quality-gate-mechanics.md`](agent-quality-gate-mechanics.md);
   keep behavioral and runtime verification in the validation record.
5. Run the suggested invocation pair above: `pnpm --silent pr:feedback-state`
   for the feedback sweep, then, once its ledger is clean, `pnpm pr:ready-state`
   for the final required-readiness decision. Add `--watch --compact
--until-ready` to the readiness call for a foreground wait loop. Bind
   `--repo` to the base repository — checkout inference can select the wrong
   same-number PR on fork PRs.
6. If feedback-state `ready` is false, inspect and handle
   `requiredFeedbackBlockers`, `unresolvedReviewThreads`,
   `unrepliedRootReviewComments`, `blockingTopLevelBotComments`, and any
   non-ready required feedback `gates`. Also scan `topLevelBotComments` as
   context; deployment/status bot comments may be informational.
7. If ready-state `ready` is false, fix or wait only on `required.blockers` and
   required `gates`.
8. After a batched fix push, wait for the optional automatic CodeRabbit check
   to become terminal, then refresh once. Stop waiting at the babysit deadline,
   or as soon as it is clear no run started: the check is advisory and never
   gates readiness, so an absent or still-pending result is optional lag. If
   `gates.codeRabbitReviewSignal.state` is `missing` or `stale`, recheck the
   head and post at most one marked closeout request for that head. Do not post
   when the state is `requested`, `reviewed`, or `not_applicable`.
9. Report visibly in-progress review-producing workflows as optional lag. If
   you are still watching the PR when one finishes, rerun `pr:feedback-state`
   to catch late feedback; do not treat the optional workflow status itself as
   a blocker.
10. After the CodeRabbit closeout step and any final optional-review refresh,
    rerun `pr:feedback-state` and then `pr:ready-state`. Signal all-clear only
    when feedback-state has no required blocker and ready-state `ready` is true
    for the current head.

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
