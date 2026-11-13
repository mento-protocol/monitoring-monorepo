---
title: PR Ready State
status: active
owner: eng
canonical: true
last_verified: 2026-09-09
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

- `mergeable: CONFLICTING` or `mergeStateStatus: DIRTY`: a textual conflict
  with the base always blocks. `mergeStateStatus: BEHIND` alone blocks unless
  the fetched branch protection or ruleset confirms
  `strict_required_status_checks_policy: false` for the base
  (operator decision 2026-09-15,
  [ADR 0104](../adr/0104-non-strict-required-status-checks.md)); confirmed
  off, it is reported in `notes[]` for visibility instead of
  `required.blockers[]`. Unknown fails closed the same as any other
  branch-protection lookup gap.

- `base-red`: a required context on the base branch head that ended in
  `failure`, `cancelled`, `timed_out` or `action_required`, named with the
  base commit it was read at. Pending, in-progress and skipped base checks are
  not red. A base whose health cannot be read blocks with `state: "unknown"`.
  With strict mode off, GitHub no longer reruns a PR's checks against the
  current base, so this is what stops a merge onto a red `main`. It blocks the
  fix PR too, so the operator override below clears it, reported in `notes[]`
  as `state: "overridden"` with the author and reason. An unknown base is
  never overridable.

  After reading base health, the probe independently resolves the live
  protection branch again. Both live commit IDs must match. The PR base SHA
  and optional native stack base SHA remain separate snapshots; they can be
  older than a stable live branch. The final PR and stack reads must still
  match those original snapshots. A failed or malformed live-branch lookup
  exits without readiness JSON in one-shot mode. Watch mode retries the probe.

- Closed-unmerged PRs. The babysit gate proves a same-repo head before any
  terminal-state exit. Merged PRs are then terminal-ready and short-circuit the
  readiness sweep. Closed-unmerged PRs report only the terminal `state` blocker;
  review gates are non-required because no Codex or reviewer action can unblock
  a closed PR.
- Required check runs or status contexts that are failing, pending, queued, or
  missing from the branch-protection rollup.
- Branch-protection context lookup failures caused by unreadable or
  unauthorized protection data; the probe fails closed rather than guessing
  required-vs-optional status. On any classic branch-protection HTTP 404 the
  probe reads active branch rulesets and derives required status contexts from
  any `required_status_checks` and named `workflows` rule. It trusts that list,
  and a ruleset's `strict_required_status_checks_policy: false`, only once one
  proof establishes that classic protection is absent. A `Branch not protected`
  404 plus `repos/{owner}/{repo}/branches/{base}` reporting
  `protection.enabled: false` is conclusive. A generic `Not Found` 404 can also
  be proved absent, but only with that disabled-classic branch response bound to
  the exact base name, plus a successful GraphQL read for the same repository
  and exact base ref: the viewer has `WRITE`, `MAINTAIN` or `ADMIN` permission,
  the classic-rule inventory has `totalCount: 0`, an empty `nodes` list and
  `hasNextPage: false`, and the base ref's `branchProtectionRule` is explicitly
  null. GraphQL errors, missing fields, a partial inventory or any classic rule
  leave the probe blocked. The top-level `protected` flag proves nothing —
  a ruleset-only base still reports `protected: true`. A branch that is protected
  but has no required-status-checks configuration answers `Required status checks
not enabled`, which proves absence on its own. Unproven 404s keep the contexts
  unavailable and blocking, because a classic-only required check could be
  hiding behind the 404; strictness stays unknown, and a ruleset's confirmed
  `true` still stands. An empty ruleset result blocks the same way.
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
- A human-authorized break-glass override for two gates, each named explicitly.
  The PR comment must come from a non-bot GitHub `OWNER`, `MEMBER`, or
  `COLLABORATOR` account. The Codex override still requires manual human posting;
  only `base-red` allows the agent relay below:

  ```text
  /pr-ready-override gate=codex-description-approval head=<full-head-sha> reason=<why this is safe>
  /pr-ready-override gate=base-red head=<full-head-sha> base=<base-oid> reason=<why this is safe>
  ```

  Use `codex-description-approval` when Codex review is externally blocked
  after the rest of the required readiness surface is clean. Use `base-red` to
  land the fix or revert that turns a red `main` green, which `base-red` would
  otherwise block: get that PR green on its own checks first, then an operator
  posts the override, or authorizes an agent to record it on that PR.

  For `base-red` only, an authorized agent may record explicit human operator
  approval for this recovery PR and exact head/base, verified from authenticated
  identity and live context in the current chat, using an existing trusted
  non-bot GitHub account. General permission,
  quoted or forwarded claims, bot messages and self-asserted consent do not
  qualify. Record the complete source-message permalink, trusted operator
  identity, repository, PR, full head/base OIDs and recovery reason; state, for
  example, “Philip approved in Slack; Giskard records on his behalf.” Verify
  the posted identity and text, then rerun feedback-state and ready-state.
  Source approval must postdate the latest failed required base run; check
  again immediately before posting. A newer failure requires fresh consent.
  The parser checks GitHub authorship and OID bindings, not chat provenance;
  the agent must verify that provenance before posting. If uncertain, stop.
  This record is neither a human GitHub review nor approval to skip other gates.

  Either override is scoped to the exact current head SHA, so any new push
  expires it, and a reason is required. `base-red` also names the base commit
  the operator judged: a base that moves to another red commit needs a fresh
  decision, and a base whose health could not be read is never overridable. Each is reported as `overridden` with
  `readinessOverrides[]` evidence — the Codex one as a gate state, `base-red`
  as a `notes[]` entry carrying the author and reason — never hidden as a
  normal pass. Each covers only its own gate. Neither overrides failing or
  pending required checks, merge conflicts, draft state, requested changes,
  unresolved review threads, or unreplied review comments.

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

CodeRabbit is retired as of 2026-11-13. Do not request or wait for its reviews.
The repository configuration disables automatic reviews and chat replies.
Remove the GitHub app installation to disable it across all organization repositories;
organization Global overrides can take precedence over repository configuration.
Existing actionable feedback still requires disposition. Claude and Codex review
requirements remain in effect.

The `codeRabbitReviewSignal` output remains available for compatibility with
existing consumers and old PR records. Its advisory fallback is not an instruction
to request a retired reviewer.

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
  "notes": [
    {
      "kind": "base-update",
      "name": "Pull request is behind the current base",
      "state": "BEHIND",
      "required": false,
      "url": "https://github.com/..."
    }
  ],
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
      "requestCount": 0,
      "requestBudget": 2,
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
  "requiredStatusChecksStrict": false,
  "summary": "1 required blocker(s) remain."
}
```

Field expectations:

- `ready`: `true` only when every required blocker is clear. Optional lag must
  not flip this to `false`. Callers prove a same-repo head before acting on
  terminal state: `MERGED` is terminal-ready; `CLOSED` without merge is
  terminal-blocked with a `state` blocker.
- `required.ready`: mirrors the required-readiness half of the decision. Agents
  use it only after `pr:feedback-state` has a clean feedback ledger; it is not
  sufficient for all-clear by itself.
- `pr.state`: GitHub's PR state (`OPEN`, `MERGED`, or `CLOSED`). The probe uses
  this before fetching comments, reactions, check sources, and branch
  protection so post-merge babysitting exits quickly and does not mistake
  GitHub's post-merge `mergeable: UNKNOWN` for a blocker.
- `pr.mergeStateStatus`: GitHub's aggregate merge status. `DIRTY` is a
  required blocker. `BEHIND` alone is a required blocker too, unless the
  probe's fetched `requiredStatusChecksStrict` confirms `false` for the base
  (see below), in which case it is reported in `notes[]` instead and does
  not require a base integration. Other aggregate states do not
  replace the required-check and feedback projections.
- `requiredStatusChecksStrict`: tri-state read straight off the
  already-fetched classic branch protection (`strict`) or ruleset
  (`strict_required_status_checks_policy`) response — `true`, `false`, or
  `null` when no source states it. A base can carry more than one applicable
  `required_status_checks` ruleset rule; any confirmed `true` wins, and the
  result is `false` only when every matching rule explicitly disables strict
  mode. Only a confirmed `false` demotes `mergeStateStatus: BEHIND`; `true`
  and `null` both fail closed, matching every other branch-protection lookup
  gap in this probe.
- `pr.autoMergeEnabledAt`: the observed pending auto-merge enable timestamp,
  or null. It records intent and never proves merge completion.
- `pr.mergedAt` / `pr.closedAt`: terminal timestamps when GitHub provides them.
- Terminal closed PR summaries may mark normally required gates
  `not_applicable`. Act on the terminal `state` blocker instead of requesting
  more review.
- `required.blockers[]`: only required blockers. Every item needs `kind`,
  `name`, `state`, `required: true`, and a URL when GitHub provides one.
- `optional.items[]`: advisory signals worth reporting separately. Every item
  needs `kind`, `name`, `state`, and `required: false`.
- `notes[]`: non-blocking informational items, such as `mergeStateStatus:
BEHIND`. Never treat a `notes[]` entry as a blocker.
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
- `codeRabbitReviewSignal`: legacy advisory state retained for existing consumers.
  The state can be `missing`, `requested`, `refused`, `stale`, `reviewed`, or
  `not_applicable`. Request counts and fallback fields describe the retired
  protocol. Never act on these fields to request or wait for a CodeRabbit review.
  Existing actionable findings still belong in the feedback ledger.
- `requiredStatusContexts[]`: required check contexts from classic branch
  protection or branch rulesets. Ruleset-derived entries include status-check
  rules and required-workflow rules when their check names are present in the
  ruleset or resolvable from local workflow metadata. Entries preserve
  `integrationId` so a same-name check from the wrong GitHub App does not
  satisfy readiness.
- `summary`: one concise human-readable sentence suitable for a babysitter
  status update.

## Native stack output

Standalone PR output is unchanged. Native stack summaries add
`readinessScope: "layer"` and `stack` with its number, `diffBaseRef`,
`protectionBaseRef`, one-based `position`, ordered `layers`, and
`dependencyPrNumbers` for unmerged predecessors. Each layer records its PR
number, state, branch, and head SHA. The probe reads required checks from the
protection base; diff checks still use `pr.baseRefName`.
Native results also include the observed `pr.baseRefOid`. The aggregate retains
each layer's observed base commit and rejects changes between reads, including
when the native stack API omits its optional base SHA.
The probe also verifies that each open child head contains the preceding open
parent head. A stale or unverifiable ancestry result blocks native readiness.

`stack.ready` is `null` and `stack.readiness` is `"not_evaluated"`: a ready
layer does not prove stack readiness. Run both projections independently for
every open layer and follow [the stacked PR workflow](stacked-pull-requests.md)
for membership changes and aggregate handoff. A stack lookup or metadata error
causes a nonzero CLI result; a watch retries without emitting a ready verdict.
Before returning a native-layer result, the probe re-reads the selected PR
and native stack context after the other evidence reads. A changed head, base,
or stack context rejects that result. Never treat failed discovery as proof
that a PR is standalone.

The repository babysit hook uses `scripts/pr/pr-stack-ready-state.mjs` for
native stacks. The helper runs both projections for each open layer, requires
matching stack snapshots, and performs a final selected-PR readiness read.
Every later snapshot is checked for feedback as well as readiness, so a newly
observed finding cannot be ignored while accepting that snapshot.
Only complete, stable, ready results produce `PASS`; an unavailable, malformed,
changed, or blocked result produces `PENDING`. The message identifies observed
base updates, head/base transitions, required-check failures or pending checks,
and feedback blockers. Only a fully observed `AWAITING_USER_MERGE` or `MERGE_REQUESTED` result can
complete the aggregate PASS path; unknown merge observations remain PENDING.
These diagnostics never turn a pending merge request into a terminal result. The helper adds no public
command; individual probe JSON remains layer-scoped.
The native aggregate has a five-minute deadline that cancels active `gh` child
requests and returns `PENDING` when reached.
`scripts/pr/pr-ready-state-gh.mjs` owns GitHub CLI transport and scoped cancellation.

## Agent workflow

1. Sweep feedback surfaces and build the feedback ledger before editing, then
   reply to every review comment. Use `Fixed in <commit> — <what changed>` or
   `Won't fix: <technical reason why>`; never resolve a thread before replying.
2. Read the scope baseline the operating card's step 4 froze before the first
   review pass, with the fields step 4 defines. Do not re-freeze it here. When
   none was recorded, as on a babysit-only entry to a PR opened elsewhere,
   freeze one from the current head, record its fields in `## Validation`, and
   state that it covers growth from that point only. Batch review fixes locally,
   auditing sibling surfaces before pushing. Classify additions as in-scope,
   follow-up, or stop; open an issue labeled per
   [`agent-issue-workflow.md`](agent-issue-workflow.md) before deferring valid
   follow-up work. When the non-test count reaches the step-4 threshold,
   report the growth and wait for the user. Do not pause solely for
   cycle count before five
   review-triggered patch cycles are complete. Pause for reclassification before
   starting a sixth.
3. Apply the direct author-check table from step 3 of the
   [operating card](pr-operating-card.md) before the ready handoff. Re-run each
   applicable check after a material fix changes its surface. Record every
   result in the validation record as the card requires. Do not substitute the
   legacy diagnostic gate for these checks.
   Use the resolved PR base, not a fixed `origin/main`, for every diff-based
   author check, including stacked PRs.
4. For non-trivial behavioral, workflow, security, data-flow, or UI batches,
   follow operating-card step 4 with the preflight-bound base. After a base
   integration, review both immutable reconciliation axes. Run at the batch
   boundary rather than as an inner loop. Verify accepted findings before
   editing. Rerun applicable direct author checks and the closeout when a fix
   changes the batch. The handoff to the `review` skill, base resolution, and
   no-`codex` branch live in
   [`pr-operating-card.md`](pr-operating-card.md) step 4; keep behavioral and
   runtime verification in the validation record.
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
8. After a batched fix push, follow the existing Claude and Codex review
   requirements. Do not request or wait for CodeRabbit.
9. Report visibly in-progress review-producing workflows as optional lag. If
   you are still watching the PR when one finishes, rerun `pr:feedback-state`
   to catch late feedback; do not treat the optional workflow status itself as
   a blocker.
10. After the required reviews and any final optional-review refresh,
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
