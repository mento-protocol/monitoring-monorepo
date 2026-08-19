---
title: Sentry Triage Pipeline
status: active
owner: eng
canonical: true
last_verified: 2026-08-10
scope: ci/process
doc_type: runbook
review_interval_days: 90
garden_lane: operator-runbooks
---

# Sentry triage pipeline

This is the operator reference for the Sentry queue, triage, projection,
autofix, and archive workflows defined by
[ADR 0036](../adr/0036-sentry-triage-pipeline.md) and
[ADR 0038](../adr/0038-sentry-central-plane-verdict-projection.md). It records the contracts
and recovery procedures that are not obvious from the implementation.

Do not use this note as a rollout-status snapshot. Check
[tracker #1282](https://github.com/mento-protocol/monitoring-monorepo/issues/1282),
the current workflow runs, and the repository Actions variables before
enabling or operating a later stage.

## Authority and stage map

| Stage                    | Owner                                                                              | Schedule or trigger                                    | Writes                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| Ingest                   | `.github/workflows/sentry-triage-ingest.yml`, `scripts/sentry-triage-ingest.mjs`   | 05:30 and 13:30 UTC daily; manual dispatch from `main` | Redacted queue issues and the ingest run record                          |
| Triage                   | `.github/workflows/sentry-triage-agent.yml`, `.github/prompts/sentry-triage.md`    | 07:55 UTC weekdays; manual dispatch must select `main` | One verdict comment per selected issue                                   |
| Deterministic settlement | `scripts/sentry-triage-project-core.mjs`, `scripts/sentry-triage-project.mjs`      | After each triage batch                                | Verdict labels, queue closure, and optional owning-repo issue projection |
| Autofix                  | `.github/workflows/sentry-autofix.yml`, `.github/prompts/sentry-autofix.md`        | 08:30 UTC weekdays; manual dispatch from `main`        | A scoped branch and PR for eligible local code fixes                     |
| Archive                  | `.github/workflows/sentry-triage-archive.yml`, `scripts/sentry-triage-archive.mjs` | Human approval label or manual dispatch from `main`    | Sentry `archived_until_escalating` state and a queue audit record        |
| Staleness watch          | `alerts/infra/sentry-ingest-watcher/`, `alerts/infra/monitoring.tf`                | Hourly Cloud Scheduler job, outside GitHub Actions     | A Cloud Monitoring freshness gauge; alerts `#alerts-infra`               |

Staleness watch is the only row that does not run in GitHub Actions, and that
is the whole point: a scheduler that dies silently cannot report its own death.
It measures the ingest run record on tracker issue #1282, **not** the ingest
workflow's conclusion — a run with the kill switch off or `SENTRY_TRIAGE_TOKEN`
absent still concludes `success` and never reaches the record writer, so the
record is the only signal that separates work done from exit code 0. Freshness
comes from the ISO timestamp inside the record body, never the comment's
`updated_at`, which any edit would move forward. The read is **unauthenticated**
and author-fenced: the repository is public, so the watcher holds no credential
and ignores any record not authored by the pipeline.
`sentry-triage-ingest-stale` fires when the last recorded ingest is older than
26h **or** when the gauge stops arriving, and the function publishes nothing
rather than guessing when it cannot read the record.
Ingest is the correct single canary: the triage, autofix, and archive legs
legitimately no-op for days when the queue is empty. Operator detail, including
how to prove the alert fires after an apply, lives in
[`alerts/infra/README.md`](../../alerts/infra/README.md).

The workflows own permissions, concurrency, branch guards, and exact
invocations. The scripts own parsing, idempotency, and state transitions. The
ADRs own the trust boundaries and rationale. Update those sources and this
runbook together when a contract changes.

Two shared modules sit under the stages above.
`scripts/sentry-triage-project-core.mjs` owns the VERDICT contract — markers,
parsing, and the two comment selectors every fence is asked through.
`scripts/sentry-triage-queue-contract.mjs` owns the QUEUE contract — the label
namespace, the untrusted-text neutralization, and the archive freshness-baseline
fields. `scripts/sentry-triage-requeue.mjs` is the one place a queue stub is ever
re-queued for triage; both producers call it and neither reconstructs the
sequence.

The triage row states an operator requirement, now backed by a mechanical
guarantee. Every secret-bearing job in these workflows declares the
`sentry-pipeline` GitHub Environment, whose deployment-branch policy names `main`
explicitly (Terraform in `terraform/github-environment.tf`, issues #1289 and
#1649 — an explicit pattern, never `protected_branches`, which is inert in this
repo and fails open). GitHub refuses such a job on any non-main ref server-side — before it
starts, and regardless of what the branch's workflow file says — so a feature-ref
`workflow_dispatch` can no longer reach the pipeline's secrets by stripping the
in-workflow `if: github.ref == 'refs/heads/main'` guard. Still select `main`; the
environment is the backstop, not a licence to dispatch off-main. The shared
`CLAUDE_CODE_OAUTH_TOKEN` deliberately stays a repo-level secret (it is consumed
by `.github/workflows/claude.yml` on feature-branch `pull_request` events, which a
main-only environment would break); it is inference-only, so its residual
exposure is bounded to inference-quota abuse.

## What happens to an issue

Two things decide the outcome: **where the code lives** and **what the agent
decides**. Depth for each cell is in the sections below; this is the index.

`analytics-mento-org` is the only project whose source is in this repo
(`ui-dashboard/`). `app-mento-org`, `governance-mento-org` and
`reserve-mento-org` map to `frontend-monorepo`; `analytics-api` and
`minipay-dapp` to their own repos. That list is fixed in `ALLOWED_OWNING_REPOS`
and mirrored in `.github/prompts/sentry-triage.md`.

Ingest queues **every** project in the Sentry org, so a project outside that
map is possible. Its actionable verdict does not project: it takes
`skipped-repo`, and the stub closes with a note naming the unrecognised repo.
Adding a project means adding it to the allowlist, not only to Sentry.

| Verdict              | `analytics-mento-org` (local)                                                                                                                                                                                                                     | Every other project (external)                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `code-fix`           | `fix_scope: mechanical` → **autofix-eligible**, closed ledger entry — the only path that writes code. `fix_scope: architectural` → **stays OPEN** under `sentry:fix-scope-architectural` (human design work, excluded from autofix at query time) | Projects an issue into the owning repo. Never autofix |
| `config-fix`         | Record only: no projection (this repo is not an allowlisted target), no autofix                                                                                                                                                                   | Projects an issue into the owning repo                |
| `upstream-transient` | Closes. Nothing downstream                                                                                                                                                                                                                        | Same                                                  |
| `needs-human`        | Stays open with a decision-ready brief                                                                                                                                                                                                            | Same                                                  |

Autofix outcomes, for a local `code-fix` (`sentry-autofix-finalize.mjs`):

| Agent produced                                                                                                     | Result                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `fix_scope: architectural` (settlement, before any agent runs)                                                     | Stub left OPEN, labeled `sentry:fix-scope-architectural`. Never selected; human design work (issue #1812) |
| A diff within `MAX_CHANGED_FILES`, no forbidden path, no symlink                                                   | PR opened, `sentry:fix-pr-opened`. Never auto-merges                                                      |
| A larger diff, or one touching `FORBIDDEN_PREFIXES` (`.github/`, `terraform/`, `tools/`, lockfiles, `vercel.json`) | `sentry:fix-refused`                                                                                      |
| No changes                                                                                                         | `sentry:fix-refused`                                                                                      |

`sentry:fix-refused` is terminal — selection never reconsiders that stub. The
forbidden prefixes are also why `config-fix` is not autofixable: the files a
configuration fix would change are the ones the guard rejects, and the rest
(env vars, third-party dashboards) are not in the repo at all.

Cases that are not a verdict:

| Situation                                     | Handling                                                                                                                                                                                                                                |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Sentry issue recurs after its stub closed | Ingest reopens it when `lastSeen` is newer than `closedAt`, and it re-triages. This is the safety net under every close above                                                                                                           |
| A human wants it archived in Sentry           | Only via the `sentry:approved-archive` label. Never automatic, for any verdict                                                                                                                                                          |
| The turn budget runs out                      | The agent posts `needs-human` saying so, rather than failing silently                                                                                                                                                                   |
| The Sentry MCP toolset does not register      | The pre-flight probe fails the triage job before the agent starts, so `sentry:needs-triage` stays on and the next run retries. Losing the toolset mid-run is the one irrecoverable failure the agent must NOT post as a verdict (#1938) |
| Sentry reads fail with the toolset present    | The agent triages on what it has and says so in `confidence`; a genuinely unreadable issue is `needs-human` on the evidence, not on the tooling                                                                                         |
| No verdict, or one from a stale round         | The label step fails loudly and leaves `sentry:needs-triage` for the next run                                                                                                                                                           |
| `SENTRY_PROJECTION_TOKEN` absent              | An external actionable verdict gets **neither routing nor an open escalation** — the stub closes with a skipped note and resurfaces only on regression. Known gap                                                                       |
| Filed on a weekend                            | Ingest runs daily; the triage agent runs weekdays only. A missing weekend verdict is not a defect                                                                                                                                       |
| `sentry:candidate-noise`                      | Written by ingest from a title match and read by nothing today                                                                                                                                                                          |

## Non-negotiable invariants

- This repository is public. Queue issues and verdicts must never reproduce
  Sentry titles, messages, stack frames, parameterized URLs, user data, or
  other payload text. They may contain redacted coordinates, abstract
  diagnoses, and Sentry permalinks.
- The triage agent has read-only Sentry access. Its only write is one structured
  verdict comment; deterministic code validates that comment and performs all
  labels, closures, and projections.
- Missing, invalid, stale, or unauthenticated verdicts fail loudly and retain
  `sentry:needs-triage` for retry.
- A closed queue issue never rests on `sentry:needs-triage`. Stages may write
  that pairing transiently; ingest reopens it on its next run.
- Closing a queue issue never resolves or archives its Sentry issue.
- Autofix opens a PR only. Required CI, review, and merge remain human gates.
- Archiving requires an explicit human-applied
  `sentry:approved-archive` label and a separate write-scoped credential.
- Sentry read, projection, autofix, and archive credentials stay isolated and
  are provisioned through the platform Terraform stack. Never use
  `gh secret set` or the GitHub UI as an activation shortcut.

## Queue contract

Ingest queries unresolved issues for the `mento-labs` organization on three
axes: newly seen, regressed, and **escalating**. The last is separate because
Sentry's grammar treats `is:regressed` and `is:escalating` as distinct filters
and the archive leg only ever produces the second (#1765). The project set, mapping, pagination, default lookback, and noise
heuristics are owned by `scripts/sentry-triage-ingest.mjs`; do not duplicate
those lists here.

Each Sentry group maps to one queue issue:

```text
[sentry] <SHORT-ID> (<project>, <level>)
```

The body starts with `<!-- sentry-triage:v1 -->` and contains only the
redacted machine record plus a validated `https://*.sentry.io` permalink:

```yaml
short_id: "GOVERNANCE-MENTO-ORG-51"
sentry_issue_id: "6197137101"
project: "governance-mento-org"
level: "error"
status: "unresolved"
events: 42
users: 7
first_seen: "2026-07-01T00:00:00Z"
last_seen: "2026-07-14T10:00:00Z"
permalink: "https://mento-labs.sentry.io/issues/6197137101/"
```

The Sentry `shortId` is the idempotency key. Ingest scans all queue states in
bulk:

- no matching queue issue: create one;
- open match: leave it open;
- closed match with a regression whose `lastSeen` is newer than
  `closed_at`: post the regression fence comment, restore `sentry:needs-triage`,
  shed the stale verdict/projection/autofix/archive labels, and reopen — in that
  order;
- closed match carrying `sentry:archived`: compare `lastSeen` against the
  archive reopen baseline in the stub's own body instead of `closed_at` (see
  the archive section below), falling back to `closed_at` when the body carries
  no parseable baseline;
- other closed match: leave it closed.

That write order is load-bearing at both ends, and no stage writes it by hand.
Every re-queue in the pipeline runs through one function,
`requeueQueueStub` in `scripts/sentry-triage-requeue.mjs`, which takes the CAUSE
as an argument and decides the fence from it. The triage agent workflow reaches
it through `scripts/sentry-triage-workflow-requeue.mjs`, the CLI every
compensating exit in that workflow calls with a `--reason`; an open-coded label
swap anywhere in the workflow reds a shape test in
`scripts/sentry-triage-brief.test.mjs`. Because every caller's premise is a
snapshot of a failure it already observed, that CLI revalidates live state and
DECLINES when the stub has gone terminal — CLOSED, or carrying
`sentry:archived` because the archive leg completed in between — rather than
shedding the archive marker and reopening a retry stub over an archived Sentry
issue that has consumed a human approval. A failed revalidation read propagates:
the run goes red and names the manual repair. The fence goes first so no
interruption can leave a stub re-queued for triage without it; the state change
goes last so none can leave it open but unselectable. Inside the label step the
restore and the shed are two ordered `gh issue edit` calls, never one call
carrying both flags: `gh` sends `--add-label` and `--remove-label` as discrete,
concurrent GraphQL mutations, and a lost add half used to leave a closed stub
with `sentry:archived` shed and `sentry:needs-triage` never applied — a pairing
the baseline branch and the stranded sweep are both blind to. Adding first means
every interruption lands on a pairing one of them still reads. Every
interruption point then lands on a state that is inert or recoverable. On this
path the fence post
is additionally guarded by an author-fenced identity check, so a retry completes
the sequence without duplicating it — a guard the caller declares, and one that
disarms itself whenever `lastSeen` does not parse, because the rendered body
then identifies no particular occurrence.

Missing or invalid timestamps fail toward re-triage. The strict timestamp gate
prevents Sentry's long-lived regressed substatus from causing a reopen/close
loop.

Ingest then sweeps the queue itself, independently of that run's Sentry results.
It repairs **two** unselectable shapes, both through the re-queue chokepoint, and
counts them apart in the run record because they diagnose different failures.

**Closed while still queued.** A closed stub that still carries
`sentry:needs-triage` is reopened, its stale verdict/projection/autofix/archive
labels shed, and a fixed recovery note posted. That pairing is unreachable, never
a resting state — Stage B selects open stubs only, and the regression gate above
reopens a closed stub only on fresh Sentry events. Several stages can still write
it (the archive leg's live-regression refusal, a crash inside ingest's own reopen
sequence, a hand-edit), so it is repaired once here from observed state rather
than guarded at each producer. The triage agent workflow's own close
compensations no longer produce it: they run through the re-queue CLI, whose
terminal revalidation declines on a stub that reads CLOSED — which is exactly
what a close that landed and lost its response leaves behind. Declining a stub
means removing `sentry:needs-triage`, not closing the stub while it still carries
the label.

**Open, verdicted, and no longer queued** (issue #1817). The verdict step swaps
`sentry:needs-triage` off before anything closes the stub, so every failing exit
in that window owes it a re-queue — and those exits go through the re-queue CLI,
whose revalidating read retries within a bound and then THROWS. Under a
persistent GitHub read outage that is the right refusal and it still leaves the
stub open, verdict-labeled and unqueued: Stage B needs the label, the project job
skips a stub that is not queued, and the closed-pairing sweep matches the
opposite pairing. The archive leg's post-CAS rollback leaves the same shape
whenever the stub it rolls back was open. So the sweep restores selectability
through the same chokepoint, which brings the shed set and the terminal guard
with it.

That shape is also what a LIVE triage round looks like between its verdict label
and its close, so the sweep additionally requires the stub to have been idle
(`updated_at`) for a full day. The declared part of the window it must clear is
small — a stub's clock starts when ITS verdict label lands, and at
`max-parallel: 2` over a batch capped at 10 that leaves at most four further
waves of a 10-minute job plus the `project` job's 15 minutes, roughly 55 minutes.
The undeclared part is runner queueing, which no timeout bounds, and that is what
the threshold actually answers: a live run reaching a day needs a 15-minute job
queued for a day, and the triage workflow holds `concurrency:
sentry-triage-agent` with `cancel-in-progress: false`, so a run stuck that long
has already blocked the next scheduled run and become something someone is
looking at. The cost is latency on a stub whose run already went red — a strand
from the weekday 07:55 run is repaired within about thirty hours, without a
human. The workflow's own compensation remains the fast path, in seconds.

A stub with no parseable `updated_at` is left alone: no observation of idleness,
no sweep. Three shapes are excluded outright, because they are resting or belong
to another leg: `sentry:verdict-needs-human` (the close step leaves that bucket
open for a human to answer), `sentry:approved-archive` (a live human approval the
archive workflow is acting on), and `sentry:archived` (the archive leg's terminal
marker). And the sweep does not rely on the threshold alone: both racing
directions degrade into states something already repairs — a re-queue that raced
the `project` job leaves a stub its `--batch` mode skips, and one that raced the
close leaves the closed-plus-needs-triage pairing the first sweep repairs.

**To hold a strand while you work on it, write to it.** Only a mutation moves
`updated_at` — a comment, a label change, a state change, a title or body edit.
Reading one does not, so opening a stub to inspect it buys no time at all and the
sweep can re-queue it under you. Post a comment saying you are on it, and the
stub is yours for another day. The same property is the sweep's one weakness on a
public repo: a determined commenter can keep a genuine strand below the threshold
indefinitely. That delays a repair; it can never cause one to happen wrongly, and
the state it preserves is the one this sweep found.

The window between the sweep's revalidating read and its label shed stays open,
like the one the re-queue CLI's terminal guard documents, and for the same
reason: closing it needs a shared concurrency group across ingest and archive,
which this pipeline rejected on its own terms (GitHub keeps one pending run per
group and would silently drop a second human-approved archive queued behind an
ingest run). An approval landing inside that window is shed, the archive run its
label event started refuses out loud on its own guard, and the human re-applies
the label.

The sweep re-reads each stub immediately before touching it and acts only if the
SAME shape still holds — including its idleness, since a comment posted in the
meantime moves no label and no state yet proves something is still working on the
stub. The queue snapshot is taken before the whole Sentry loop runs, so by the
time the sweep reaches a given stub the snapshot can be minutes old — long enough
for a human to have declined it by removing the label, which the sweep would
otherwise put straight back. A failed re-read leaves the stub stranded for the
next run rather than recovering blind.

**Both arms also require `sentry-triage` in that live re-read**, and decline
without writing when it is gone. The snapshot cannot fail that test — it comes
from a `labels=sentry-triage` query — so it exists for the withdrawal that lands
in between. Stage B's selector wants `sentry-triage` AND `sentry:needs-triage`,
so re-queuing a stub that lost the first sheds its verdict and still leaves it
unselectable: it takes the one artifact the stub had and buys nothing. Removing
`sentry-triage` is also the only withdrawal gesture available for a stub in the
open shape, which has no `sentry:needs-triage` left to remove — so **to retire a
verdicted, unqueued stub for good, remove `sentry-triage`.**

A read cannot close that window on its own, so membership is part of the
**end state** the re-queue is judged by. `isSelectableForTriage` is the full
Stage B selector — open, `sentry-triage`, `sentry:needs-triage` — and it is what
every `verify-end-state` re-queue must observe before it may report success. A
withdrawal landing after the check but during the writes therefore ends the run
RED, naming the label that vanished, rather than recording a success for a stub
whose verdict it just shed. The verifier repairs the other two conditions and
never this one: re-adding `sentry-triage` would overrule the human who removed
it. Nothing tries to unwind the shed either — a compensating re-add would
reintroduce the two-writers race the withdrawal just ended, and loud failure is
this pipeline's discipline for a mutation it cannot safely reverse.

The two shapes differ in one more way, and the stub's own state is why. On the
closed path every interruption lands somewhere inert: the state change goes last,
so a stub whose shed failed is still closed and invisible to Stage B until the
next run retries. An open stub has no such cover — restoring `sentry:needs-triage`
makes it selectable at once — so that path uses the chokepoint's
`verify-end-state` policy instead, the same one the workflow compensation CLI
uses on the same kind of stub: it re-attempts the shed against observed state and
throws naming whatever survived. Under `--dry-run` that verification would assert
writes the run deliberately did not make, so the dry run falls back to the abort
policy and claims nothing.

The sweep also skips any stub the regression path ATTEMPTED this run, not merely
the ones it re-queued. A Sentry-evidence re-queue that throws half-way would
otherwise be recovered by the fence-free bookkeeping path seconds later, inside
one run — a failed regression re-queue laundered into a bookkeeping one. The
chokepoint records the attempt before its first write, so the record exists
whether or not the writes do.

**The sweep has one blind spot, and it is structural.** It decides `bookkeeping`
from GitHub state, and GitHub state cannot show a Sentry occurrence that landed
after this run's `fetchMergedSentryIssues()` returned. When one does, the true
cause was Sentry evidence: the stub goes back in the queue fence-free and the
previous round's verdict — which describes the pre-regression occurrence — stays
admissible. Nothing here closes that. A per-stub Sentry lookup in the sweep was
rejected (it introduces Sentry coupling into a sweep that needs none, and any
Sentry read has a window after it), and so was fencing every recovery, which
would discard a good verdict on each genuine bookkeeping strand. The
CONSEQUENCE is closed instead, one stage later: the settlement is bound to the
triage round that produced its verdict — see
[the round binding](#the-round-binding) (issue #1717).

The namespace is separate from the development backlog:

| Label                            | Meaning                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `sentry-triage`                  | Durable queue membership                                                                      |
| `sentry:needs-triage`            | Awaiting a current verdict                                                                    |
| `sentry:candidate-noise`         | Title matched an in-memory noise heuristic; raw text was not published                        |
| `sentry:verdict-code-fix`        | Code change is the recommended disposition                                                    |
| `sentry:verdict-config-fix`      | Configuration or infrastructure change is recommended                                         |
| `sentry:verdict-upstream`        | Upstream or transient issue; no repo fix                                                      |
| `sentry:verdict-needs-human`     | A human decision is required                                                                  |
| `sentry:projected`               | An actionable external verdict was projected to its owning repo                               |
| `sentry:fix-scope-architectural` | Local code-fix, `fix_scope: architectural` — open human design work; autofix never selects it |
| `sentry:approved-archive`        | Human approval to archive the Sentry issue                                                    |
| `sentry:archived`                | Archive workflow settled the approved issue                                                   |

`sentry:fix-scope-architectural` (issue #1812) rides the same atomic label edit
as `sentry:verdict-code-fix` when a local code-fix verdict is scoped
architectural, and sits OUTSIDE the `sentry:verdict-*` namespace so the
settlement post-condition still counts exactly one verdict label. Its lifecycle:
**shed on regression** and **shed on any re-verdict** (`REOPEN_SHED_LABELS`); the
autofix record-run job is its legacy/self-heal writer — it self-heal-creates the
label and backfills it onto legacy stubs the selector still skips on scope.
Legacy backfilled stubs stay CLOSED (no mass reopen); a regression reopens any
that still fire. Hand-removing it is not an operator affordance — the verdict
re-parse still refuses and the record-run re-applies it; re-triage is.

Queue issues must never carry `agent-ready`, `agent-active`,
`needs-grooming`, or `in-pr`.

## Verdict and settlement contract

The triage workflow selects at most ten oldest pending queue issues and runs at
most two triage jobs in parallel. For each issue, the agent posts one comment
starting with `<!-- sentry-triage-verdict:v1 -->`, a YAML block, and a short
redacted diagnosis:

```yaml
verdict: code-fix # code-fix | config-fix | upstream-transient | needs-human
confidence: medium # high | medium | low
affected_repo: mento-protocol/monitoring-monorepo
summary: <one redacted line>
root_cause: |
  <one to three redacted lines>
proposed_action: |
  <one to three redacted lines>
duplicate_of: [] # Sentry SHORT-IDs only
fix_scope: <mechanical | architectural> # code-fix only
```

A `code-fix` verdict also carries `fix_scope`, because the verdict alone answers
only "is the cause in our code?" and the autofix leg needs "does a scoped fix
exist?" (issue #1785). `mechanical` is a bounded edit to files the agent can
name, reviewable without a design discussion; `architectural` moves a boundary,
spans modules, or needs the design decision taken first. `normalizeFixScope` in
`scripts/sentry-triage-text.mjs` (re-exported from
`scripts/sentry-triage-project-core.mjs`) is the single owner of the rule and
**fails closed**: absent, empty, anything outside those two words, or a REPEATED
`fix_scope:` key normalizes to `architectural`. The repeat rule is not
theoretical: a block scalar ends at the first column-0 line, so agent-transcribed
Sentry text inside `root_cause` can escape as a `fix_scope:` line, and a
last-wins parse would let it overwrite the honest value. This is also why the
template above carries a PLACEHOLDER rather than a sample value — of the
contract's fields this is the only one whose two values are asymmetric, and a
field nobody deliberated on keeps whatever the template said. Every verdict
written before the field existed therefore reads as `architectural`, which is
intended — autofix selects nothing until the
prompt produces the field. The asymmetry is deliberate: a missed `mechanical`
costs one un-attempted fix, while a wrong `mechanical` spends an agent run on a
refactor it must then refuse, which is the failure the five strategy-probe stubs
already produced.

A LOCAL `code-fix` verdict scoped `architectural` **settles OPEN** (issue
#1812). The label step's parser (`runParseOnly`) emits the verdict label plus
`sentry:fix-scope-architectural` as one comma list, so the hold label rides the
SAME single atomic `gh issue edit --add-label` as the verdict label — the
step's post-condition reread still counts exactly one label, because
`sentry:fix-scope-architectural` sits OUTSIDE the `sentry:verdict-*` namespace
(`VERDICT_LABELS` filters on that prefix). The close step reads
`architectural_hold` and leaves the stub open rather than closing it. So the
"a verdicted queue issue is a closed ledger entry" invariant now has TWO open
exceptions: an actionable EXTERNAL verdict (deferred to the project job) and a
LOCAL architectural code-fix (held as human design work). The hold is never
terminal: it is shed on regression and on any re-verdict
(`REOPEN_SHED_LABELS`), and `shed` carries it exactly when the hold does not
apply, so a re-dispatched stub whose scope flips to mechanical un-strands in the
same edit.

A `needs-human` verdict also includes a concrete `human_question`, a
`how_to_check` list, a `decision_branches` list, one to three `hypotheses`, an
`investigated` list, and an `escalation_reason`. A missing or placeholder
`human_question` is invalid: an escalation must be decision-ready, not “please
look.”

```yaml
human_question: |
  <the single decision a human must make>
how_to_check:
  - <a concrete step that answers the question>
decision_branches:
  - "Yes -> config-fix: <disposition>"
  - "No -> noise: close as upstream-transient"
hypotheses:
  - <a candidate root cause, with a confidence lean>
investigated:
  - <what was already checked or ruled out>
escalation_reason: |
  <why a confident verdict was not reachable>
```

`how_to_check` and `decision_branches` exist because the brief below is
deterministic: nothing else in the contract carries the instruction half of a
decision, so without them a rendered brief can only restate the situation. Both
are enforced, counted after neutralization, by
`escalationCompletenessRefusal` in
`scripts/sentry-triage-escalation-contract.mjs`: at least one `how_to_check`
step, and at least **two** `decision_branches` — a decision has at least two
answers, and a one-branch escalation settles with the brief silent on the other
one and no retry, because the verdict resolved cleanly. Failing either is the
same fail-loud contract as a missing verdict: the label step exits nonzero and
`sentry:needs-triage` stays on for the next run.
Every list is capped at `MAX_BRIEF_LIST_ITEMS` (in
`scripts/sentry-triage-project-core.mjs`), and every field is bounded at
`MAX_BRIEF_TEXT_LEN` before either emitter escapes it. The bounds and the
untrusted-text neutralization live in `scripts/sentry-triage-text.mjs` — the
pipeline's lowest layer, importing nothing — and are re-exported by the verdict
contract, so every caller keeps one import surface and the two briefs cannot
drift. For a `needs-human` verdict the prose after the YAML block is at most
two sentences: the fields are the brief, and a paragraph restating them only
pushes the decision further down the page.

### The needs-human brief

`scripts/sentry-triage-brief.mjs` renders those fields as a dedicated,
updated-in-place **comment** on the queue stub, in a fixed order — question, how
to check, what each answer leads to, evidence collapsed underneath. The
`verdict` job runs it right after the label swap, so a stub a person is asked to
decide carries the decision beside its YAML. The digest's Slack brief
(`renderNeedsHumanBrief` in `scripts/sentry-triage-digest.mjs`) is the second
emitter over the same shared field selection; only the escaping differs —
Slack gets `escapeSlackText`, GitHub gets `escapeGithubMarkdown`, which
backslash-escapes every active markdown character so agent-authored text can
never render a link, image, tag or entity beside the pipeline's own controls.

**A comment, not the stub body.** An earlier revision rendered the brief into
the body and tried to keep it clear of the archive leg — the body's writer —
through label observation. That could not hold (PR #1769): the archive's
settlement deletes `sentry:approved-archive` **before** it writes its freshness
baseline and adds `sentry:archived` only **after** the close, so between them
the stub carries neither coordination label and a whole-body edit could clobber
the baseline in a window no label check sees. A comment races nothing. The
archive stays the **single stub-body writer** (PR #1766); the brief cannot drop
the baseline in any interleaving because it never touches the body.

**The comment exists if and only if a live `needs-human` verdict describes the
stub.** That lifecycle is one rule, because a rendering that outlives what it
renders reads as current to whoever opens the issue:

- a `needs-human` verdict creates the comment, or updates it in place if it is
  already there — never a second copy;
- **any other verdict deletes it**, regardless of any label the stub carries —
  which is why the workflow step is ungated. The script resolves the verdict
  itself, so gating the step added nothing and cost a stale "Decision needed"
  brief on every stub re-triaged to `code-fix`, `config-fix` or
  `upstream-transient` — including one still carrying a stale
  `sentry:approved-archive`, where the old body version yielded and left the
  brief in place for a later close to bury;
- a re-queue does **not** clear it: the re-queue chokepoint leaves the marked
  brief comment untouched. It writes no stub BODY — that is the invariant
  `scripts/sentry-triage-requeue.test.mjs` pins (issue #1692) — but it may post
  its OWN comment: a regression-fence comment for a `sentry-evidence` re-queue,
  a bookkeeping note otherwise (see the regression fence below). So a re-queued
  stub keeps its old brief until the next round's verdict lands — on a stub
  already labelled `sentry:needs-triage`.

Nothing machine-readable moves. The verdict YAML stays in the verdict comment,
where the label step, the projection, the digest and the autofix selector read
it; the stub's metadata YAML stays where `extractPermalink` and
`parseArchiveBaseline` read it. The brief comment is anchored by
`<!-- sentry-triage-brief:v1 -->` and selected by trusted author plus that
marker, so a re-triage replaces it rather than stacking a copy and a drive-by
commenter cannot make the leg PATCH or DELETE their comment. It emits no fenced
block, so `parseVerdictComment` never mistakes it for a verdict. Every rendered
field is single-line, neutralized, bounded and markdown-escaped; a comment that
could be misread by a prefix-anchored consumer fails closed.

The agent posts its verdict comment — never the brief, which `runBrief` writes
separately through its own `gh` calls — through
`scripts/sentry-triage-agent-comment.mjs`, its only write path. The wrapper
accepts no issue argument, and does not take the target from the environment
either: bash arithmetic expansion assigns, so a body containing
`$((SENTRY_TRIAGE_COMMENT_ISSUE=1234))` rewrites the exported variable while
the agent's own command line is expanded, before Node starts. The authoritative
target is a JSON file that a trusted step pins under `$RUNNER_TEMP` before the
agent runs, left mode 0444 inside a mode 0555 directory. The env var survives
as a cross-check only, and a disagreement between the two refuses loudly rather
than picking a winner.

Those modes are load-bearing, because **the agent can write files**. Claude
Code's permission rules match a command carrying an output redirection
(CHANGELOG v1.0.123), and `gh issue view --template` renders arbitrary
constructed text, so the read-only `gh` grants compose into "write any content
to any path this user can write" — including over the wrapper itself. The same
trusted step therefore copies the wrapper's whole runtime import closure into a
read-only `sentry-triage-tools` directory under `$RUNNER_TEMP`, and the agent's
`--allowedTools` grant names **that** path, never `scripts/`.
`scripts/sentry-triage-agent-comment.test.mjs` recomputes the closure from the
source and fails if the staging list stops matching it, so the attack cannot
move one file over. `scripts/sentry-mcp-broker.mjs` and
`scripts/sentry-mcp-probe.mjs` are staged alongside it even though no grant
names either: the rule for this job is that it executes nothing from the
agent-writable checkout, and a rule with an ordering caveat is one refactor away
from being wrong. The agent job's checkout also sets
`persist-credentials: false`, matching the autofix agent job.

**The agent job ends with the agent.** Immutable copies alone would not be
enough: the agent can append to `$GITHUB_ENV`, and
`BASH_ENV=<payload it wrote into the checkout>` is then exported to every later
step in the same job, whose bash sources that payload _before_ running its own
command. So the trusted follow-up is a separate `verdict` job — the shape
`sentry-autofix.yml` already uses for `select → agent → finalize`. A fresh job
means a fresh runner, a fresh checkout and a fresh environment, so nothing the
agent wrote to `$GITHUB_ENV`, `$GITHUB_PATH`, `$GITHUB_OUTPUT` or the checkout
exists there at all. Nothing crosses the job boundary: the handoff is the
verdict comment on the queue issue, which `verdict` re-reads from GitHub
through the same authoritative parser and validates against the closed verdict
enum. Its only inputs are the select job's `^[0-9]+$`-validated issue number
and `GITHUB_REPOSITORY`, and it holds `github.token` alone — no secret, no
`environment:`. Tests assert that the agent step is the last step of its job
and that no credential-bearing work follows it.

The wrapper also refuses a body that does not start with the
verdict marker and a body carrying its own authorship marker; it appends
`<!-- sentry-triage-agent-authored:v1 -->` and pipes the result into
`gh --body-file -` on stdin, handing `gh` an allowlisted environment that drops
the Claude OAuth token (and would drop a Sentry token, which since #1711 is not
in that environment to begin with). Deterministic
scripts and the agent share the `github-actions[bot]` identity, so that marker
— and the required verdict-marker prefix — are what separate agent text from
pipeline text.

**The body never touches the filesystem, and that is load-bearing.** An earlier
version wrote the validated body to a predictable `$RUNNER_TEMP` path and let
`gh` read it back. The agent can background a second permitted command
(`gh issue view … --template '<forged>' > that-path &`) and swap the content
inside the window between the check and the read; reproduced, it posted a
forged `Regressed in Sentry …` control comment past every fence. No check
closes a check-then-use window on a path the attacker can write — removing the
file removes the window. Do not reintroduce an intermediate file for the body.

**The Sentry credential is out of the agent's process env** (issue #1711).
The wrapper's verbatim-token refusal was never a leak control and must not be
described as one: the agent writes its own shell command, and bash expands and
transforms `$VAR` before the wrapper sees argv, so a spliced or split value
passes. Exact-value scanning is the wrong layer when the adversary controls the
shell. The fix removes the credential instead. See
[the credential broker](#the-credential-broker) below.

`CLAUDE_CODE_OAUTH_TOKEN` is the remaining credential in the agent's Bash, and
it stays there: `claude-code-action` places it in that process env itself
(`base-action/src/parse-sdk-options.ts` spreads the whole `process.env` into the
CLI subprocess, deleting only the OIDC request vars), and the pinned v1.0.183
offers no per-step or first-class MCP env forwarding to move it. Accepted with
its bounding: it is inference-only, so worst case is
inference-quota abuse, not repo or queue compromise, and any use lands in an
auditable public comment. Re-check on the next action bump.

### The credential broker

[ADR 0056](../adr/0056-agent-mcp-credential-broker.md) owns the decision and its
accepted residuals; this is the mechanism.

A trusted step in the triage job — before the agent, holding
`SENTRY_TRIAGE_TOKEN` step-scoped — starts `scripts/sentry-mcp-broker.mjs` on
loopback and mints an opaque per-run handle with `openssl rand -hex 32`. The
agent step receives the handle through `$GITHUB_ENV` and no Sentry credential.
Its Sentry MCP server runs with `--host 127.0.0.1:<port> --insecure-http` and
the handle as `SENTRY_ACCESS_TOKEN`; the broker validates the handle, swaps in
the real token and forwards to `https://us.sentry.io`. `--insecure-http` is
CLI-only, `SENTRY_URL` must be HTTPS and cannot combine with it, and
`SENTRY_HOST` takes a bare hostname — so the loopback wiring lives in the MCP
server's `args` and `SENTRY_HOST` is gone with the token. `$GITHUB_ENV` carries
the handle and never the token: it exposes a value to every later step, which is
right for an authenticator that only works against a loopback process on this
runner and wrong for a credential. The port has exactly one literal — the triage
job's `env: SENTRY_MCP_BROKER_PORT`. The broker requires it rather than
defaulting and the agent step interpolates it, so the two cannot drift into a
connection refused that only a live run would reveal.

**Out of the agent's env is not out of the agent's reach.** Every step runs as
`runner` and the agent holds `Read`, so `/proc/<pid>/environ` and
`/proc/<pid>/cmdline` of every process in the job are agent-readable — and the
step logs the broker's PID. `/proc/<pid>/environ` is the block captured at
`exec`, so deleting the variable inside the broker would not clear it; any
runtime scrub is theatre. The step therefore copies the token to a shell-local,
`unset`s the exported name, and pipes the value to the broker's **stdin** from
`printf`, a bash builtin: no env var, no argv, no temp file. The broker refuses
to start if it finds the token in its own exec-time environment. Do not rewrite
that pipe as a here-string or heredoc, where bash may materialise a file the
agent can read.

**Secrets reach steps through `env:`, never `${{ secrets.* }}` inside `run:`.**
GitHub expands `${{ }}` before writing the step script to `$RUNNER_TEMP`, so an
inline secret sits in plaintext on disk for the whole job — the same
same-UID-readable class as `/proc`. Audited across all 31 workflows: zero hits,
and a test in `scripts/sentry-mcp-broker.test.mjs` keeps this workflow that way.

The broker refuses anything that is not a GET on an allow-listed path with the
exact handle, and refuses to relay an upstream redirect (the MCP client would
follow it with the handle, off the broker). It also rewrites `links.regionUrl`
on organization payloads to its own origin — a correctness fix, not hardening:
Sentry returns `https://us.sentry.io` there, and both the MCP server's internal
`trace`/`span` path and its `find_organizations` output steer subsequent reads
off the broker with it. `links.organizationUrl` is left alone so verdict
comments keep real Sentry permalinks.

**The handle is not a second secret, and that is load-bearing.** Three
allow-listed tools (`find_projects`, `search_issues`, `search_events`) take an
agent-controlled `regionUrl`, and the MCP server's `validateRegionUrl` accepts
the base host plus a hardcoded `{sentry.io, us.sentry.io, de.sentry.io}`, keeps
only the host and re-applies its own protocol — `http` under `--insecure-http`.
So an injected agent can send its `Authorization` header to
`http://us.sentry.io/api/0/...` in cleartext, past the broker. Sentry egress is
not closed on the runner and this design does not assume it is. What leaks there
is the handle, which authenticates only to a `127.0.0.1`-bound process that dies
with the runner, so it is worth nothing off-runner or after the run.

There is deliberately **no stop step**. The triage job must end with the agent —
the agent can append `BASH_ENV=<payload it wrote>` to `$GITHUB_ENV`, and any
later step's bash would source that payload before its own command, escaping the
permission allowlist entirely. The broker bounds its own life with
`SENTRY_MCP_BROKER_TTL_SECONDS` instead (set to the job timeout), on a runner
that is destroyed with the job.

**Re-derive the path allowlist on a `@sentry/mcp-server` bump.** It is the
empirical closure of the granted tools, not a guess from tool names: point the
pinned MCP server at a capture server with
`--host 127.0.0.1:<port> --insecure-http`, drive every granted tool over stdio
(including `get_sentry_resource` across its whole `resourceType` enum and
`search_events` across every dataset) and collect the request paths. At 0.37.0
only five of the ten names in `--allowedTools` exist — `find_organizations`,
`find_projects`, `search_issues`, `search_events`, `get_sentry_resource`; the
other five are inert grants kept in case a bump restores them. A path the broker
refuses fails the triage leg loudly with the path named in its log, so a stale
allowlist is visible rather than silent. The same bump re-derives
`REQUIRED_TOOLS` in `scripts/sentry-mcp-probe.mjs` (below), which names those
same five. Both read the one pinned spec in the triage job's
`env: SENTRY_MCP_SERVER_SPEC`; neither restates the version.

### The MCP pre-flight probe

The triage job proves the Sentry toolset registers **before** the agent starts,
and fails the job when it does not (issue #1938).

Without that check the pipeline fails OPEN, because the failure is silent.
`claude-code-action` spawns the Sentry MCP server itself; when that spawn does
not complete, the CLI initialises without it and prints nothing — no MCP error,
no npm error, no subprocess exit notice reaches the job log. The agent then
holds no `mcp__sentry__*` tool at all and reports that as a `needs-human`
verdict, which the deterministic `verdict` job cannot tell apart from a
judgement: it applies the label, strips `sentry:needs-triage`, and parks the
stub as human work on a question nobody can answer. On 2026-08-19 one silent
startup stall produced seven such stubs in a single run.

So `scripts/sentry-mcp-probe.mjs` runs between the broker step and the agent:
it spawns the pinned server against the same loopback broker, performs the MCP
handshake, calls `tools/list`, and requires the five real Sentry tools to be
present. A failure ends the job while `sentry:needs-triage` is still on the
stub, so the round settles the way a dead broker already settles it — the
`verdict` job finds no usable verdict, fails loudly, and the next run retries.

Three properties are load-bearing and each is pinned by a test in
`scripts/sentry-mcp-broker.test.mjs`, the suite that owns the probe:

- **It runs before the agent**, and could not run after: this job must END with
  the agent — a later step's bash would source a `$GITHUB_ENV`-injected
  `BASH_ENV` payload before its own command — so there is no post-hoc step
  available even in principle.
- **It spawns the agent's own server, argument for argument.** A probe that
  passed against a different spec, port or transport would certify a server
  nobody runs, so both derive from the same job `env`.
- **It warms the `npx` cache** for the agent's spawn moments later. The stall
  this was found through — ~29.7s to CLI-ready against 6.8s on a run that
  worked — is unexplained; paying a cold fetch in the probe, where a timeout is
  an honest job failure, beats paying it inside a startup window whose expiry is
  silent.

`tools/list` is answered by the MCP server and reaches neither the broker nor
Sentry, so a green probe proves the toolchain **resolves and registers** — not
that the credential works. Broker readiness owns that, and an auth failure is
already loud as failed agent reads rather than silent as an absent toolset.

The agent-side half of the same rule lives in `.github/prompts/sentry-triage.md`
and covers a toolset lost _after_ the probe passed: losing the evidence source
is the one irrecoverable failure that must NOT be posted as a verdict. The agent
stops without commenting, and the round fails closed.

The deterministic parser accepts only comments from
`github-actions[bot]`. After a regression reopen, it accepts only a verdict
newer than the latest pipeline-authored regression comment. It then applies
the label and transition below:

| Verdict                          | Label                                                        | Queue outcome                     | Downstream action                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `code-fix` (mechanical/external) | `sentry:verdict-code-fix`                                    | Close as completed                | Project to an allowlisted external repo, or leave a visible projection-skipped note; eligible local mechanical issues may later enter autofix |
| `code-fix` (local architectural) | `sentry:verdict-code-fix` + `sentry:fix-scope-architectural` | **Keep open** (human design work) | Excluded from autofix at query time; re-triage to clear (#1812)                                                                               |
| `config-fix`                     | `sentry:verdict-config-fix`                                  | Close as completed                | Project to an allowlisted external repo, or leave a visible projection-skipped note                                                           |
| `upstream-transient`             | `sentry:verdict-upstream`                                    | Close as completed                | None                                                                                                                                          |
| `needs-human`                    | `sentry:verdict-needs-human`                                 | Keep open                         | Human answers the recorded question and decides the next action                                                                               |

A stub carries exactly one `sentry:verdict-*` label. The label edit adds the
new one and removes every other verdict label in the same call, so
re-dispatching an already-verdicted stub — the usual case after a human answers
a `needs-human` escalation — replaces the old verdict instead of stacking a
second one.

**The step self-heals its label set first, and the edit itself compensates.**
Only ingest CREATES labels, so a name added to `LABEL_DEFINITIONS` does not
exist in the repo until ingest next runs — and `gh` fails an entire
`issue edit` on a repo-nonexistent name, on `--remove-label` exactly as on
`--add-label`, after applying the add. So the step runs
`sentry-triage-project.mjs --ensure-labels` over every name its edit touches —
the verdict label, the whole shed list, and `sentry:needs-triage` —
immediately before the edit, `gh label create --force` from the same single
source the three other settlement paths self-heal from
(`sentry-autofix.yml`, `runProjectionBatch`, `ensureArchiveLabels`). The ensure
is best-effort per label; the edit that follows is guarded, so a partial failure
re-queues the stub rather than stranding it verdict-labeled and queued at once.
That is the failure PR #1812 shipped: `sentry:fix-scope-architectural` entered
the shed list of every non-architectural verdict hours before the ingest run
that would have created it, and the whole settlement leg failed on it.

The step then re-reads the stub and fails its own matrix job if the
read fails or more than one verdict label survives — re-queuing the stub first,
the same compensation the brief-clear, close and projection failure paths make,
so it goes back in the queue instead of being stranded open with no retry path.
Every one of those exits runs the re-queue CLI rather than its own label swap
(see the re-queue chokepoint above), so they all shed the same set — the verdict
namespace plus the projection, autofix and archive markers — because a stub
awaiting a fresh verdict must carry no trace of how the previous round was
handled. Only the forward verdict swap keeps those markers, and its shed list
comes from the same `--parse-only` output as the label.
The digest warns about a double-verdicted stub but never fails
on one — it is the batch's single daily notification.

Every deterministic close records that the ledger issue will reopen on a
future Sentry regression. A missing verdict after a scheduled run is an
operational failure signal, not “no issues found.”

### The round binding

The `verdict` job runs `if: always()`, so a triage round that died before
posting still reaches it — and it settles the stub on the newest ADMISSIBLE
verdict comment, which may be the PREVIOUS round's. The regression fence only
makes one inadmissible when a producer posted a fence, and the stranded-stub
sweep deliberately posts none. So the settlement is bound to the round instead:

- the `select` job records, per selected stub, the id of the verdict comment
  already on it (`sentry-triage-project.mjs --prior-verdicts`, which selects
  through `selectVerdictComment` — the same selector the settlement resolves
  with, so the two ends cannot disagree about what "the previous verdict" is);
- the `verdict` job passes that token to `--parse-only`, and `resolveVerdict`
  refuses unless the comment it selects is strictly NEWER. Refusing on the same
  id is the common case: the round posted nothing. Refusing on an OLDER id
  covers the recorded comment having been deleted in between, which equality
  alone would wave through onto an even older verdict.

Only `select` may record it: it is trusted and it runs before the agent, so what
it reads is what the round started from. Read afterwards, the token would
include the round's own comment and prove nothing.

The token is the `#issuecomment-<n>` id — the same generation token the autofix
leg threads for its ABA check (issue #1506). Ids are unique and never reused, so
there is no window to race.

Both ends fail CLOSED, per stub and never per batch. A stub `select` could not
read, or whose verdict comment carries no parseable id, is recorded `unknown`,
and `unknown` never passes: nothing can be shown to postdate a baseline that was
never read. That costs one wasted triage round on that stub — loud, and
self-healing, because that round's own verdict comment becomes the next run's
baseline. The refusal happens before the label edit, so the stub keeps
`sentry:needs-triage` and the next scheduled run re-triages it.

This closes the consequence whatever the re-queue's cause was, and it holds for
the surviving archive-side route as well as the sweep's blind spot. It does not
make the sweep able to see Sentry, and it is not a substitute for the fence: the
digest, projection, and autofix consumers still read the fence.

### External verdict projection

[ADR 0038](../adr/0038-sentry-central-plane-verdict-projection.md) limits projection to
actionable `code-fix` and `config-fix` verdicts whose `affected_repo` is
one of the script's allowlisted owning repositories. Projection runs
serialized after the triage matrix so two related verdicts cannot race to
create duplicate issues.

The projector uses a fine-grained PAT with Issues read/write on only those
repositories. It keys reuse to the Sentry short ID and the projector account's
authorship. Rotating the token through a different account can break reuse and
must be treated as a migration. On `main`, an absent
`SENTRY_PROJECTION_TOKEN` makes projection a visible no-op and queue
settlement continues. A non-`main` manual triage dispatch deliberately
withholds the token; an actionable external verdict is re-queued and the job
fails so the next `main` run can project it safely.

### Local autofix PRs

Autofix considers only local `code-fix` stubs that claim `fix_scope: mechanical`
and have no existing fix PR, reports every stub it stood down — on either axis —
into the run record,
caps each run at two CANDIDATES — not two stubs, see the family collapse
below — and uses a GitHub App scoped to Contents and Pull
requests on this repository. The fix agent receives no Sentry credential.
Deterministic selection and finalization enforce the issue/branch/diff
contract. `ui-dashboard/vercel.json` denies `git.deploymentEnabled` for
`sentry-autofix/*`, so an autofix branch's untrusted diff never gets a Vercel
deployment (and its production-linked secrets) before human review — a trust
boundary earlier than the path-aware skip script (ADR 0019, issue #1452).

**Only `fix_scope: mechanical` is selectable** (issue #1785). A local `code-fix`
verdict scoped `architectural` — including every verdict that omits the field,
which fails closed — is **settled OPEN and labeled `sentry:fix-scope-architectural`**
at verdict time (issue #1812), not closed and not left unmarked. That label is
the human design backlog. The autofix selector excludes it in its `--search`
negation, so the whole architectural class stays out of the candidate window at
query time — the one class that would otherwise grow without bound, since every
verdict predating the field reads as `architectural` (#1813's measured filler).
`evaluateCandidate` still re-parses `fix_scope` as the authority, so a LEGACY
stub that predates the label, or one whose label a human removed, is caught there
and skipped with a stderr note (never `sentry:fix-refused` — a terminal marker
would stand the whole family down). The gate sits after the reconcile branch, so
a PR that already exists still gets its bookkeeping repaired even if its scope
changed under it.

Because the held stub is OPEN, the **open issue list is the primary human
surface**: the architectural backlog is exactly the open stubs carrying
`sentry:fix-scope-architectural`. Two more surfaces name what is not yet labeled:

- the autofix **run record** on tracker issue #1282 counts every stub the
  selector still skipped on scope — `- Skipped (fix_scope: architectural): N
(#…)` — a legacy straggler the record-run backfill has not yet labeled. It is
  reported because it writes nothing to the queue, and an unreported skip would
  render as `Candidates selected: 0, Deferred: 0` — byte-identical to an empty
  queue, the #1758 misdiagnosis this leg exists to make impossible.
- the Slack **digest** lists open architectural stubs in their OWN **Open design
  work** section (not Routed — a local verdict never routes anywhere).

**Operator affordance: re-triage the OPEN stub via `workflow_dispatch`.** A human
who judges a held stub mechanical re-triages it through the standard triage
`workflow_dispatch`; its settlement then sheds the hold and closes it when the
fresh verdict says mechanical, and the next autofix run selects it.
**Hand-removing the label is NOT the affordance:** the verdict re-parse still
refuses on scope, and the record-run backfill re-applies the label. A single-issue
AUTOFIX `workflow_dispatch` does NOT override the gate either — the scope is a
claim about the fix, not a heuristic about which family member to pick, so
overriding it would spend exactly the agent run the field exists to prevent.
Re-queueing has one owner (`requeueQueueStub` in
`scripts/sentry-triage-requeue.mjs`), a pure chokepoint module with no argv shell.

**Legacy stubs stay CLOSED** (operator resolution). A local architectural stub
was CLOSED at verdict time; the record-run backfill only adds the
window-exclusion label at up to 50/run, never reopens. A regression reopens any
that still fire via the normal ingest path (`REOPEN_SHED_LABELS` sheds the hold
so the fresh round re-decides scope). This closes issue #1813: the architectural
class no longer fills the selector's read window. With the window now equal to
`LIST_LIMIT`, the standing tripwire for regrowth is the bounded second look's
`Second look: …` run-record line, and specifically its `and MORE rows sit past even
that` clause — a full window that selects nothing is exactly what fires it.

A residue this design does NOT drain, stated not hidden: a stub with no parseable
SHORT-ID, an unparsable verdict, a verdict that is not `code-fix`, or a
foreign/unrecognized `affected_repo` is dropped by `evaluateCandidate` (returns
`null`) — it never reaches the `skipped` report, so it leaves NO run-record line,
yet it keeps its `verdict-code-fix` + `autofix-select` labels and the oldest-first
query returns it every run. A pile of these can occupy the whole
`MAX_CANDIDATE_EVALUATIONS` slice while the run record names no reason; the only
signal is the select step's stderr `skip #N:` note. A pile large enough to fill
the whole window does at least surface indirectly now — it makes the run take a
bounded second look, which the run record names. It is not the architectural
class and gets no hold label — a triage error whose fix does not live here. A
run-record reporting path for this residue is a deliberate follow-up if real
starvation is observed: it would have to thread these heterogeneous skip reasons
through the `skipped_issues → record-labels` handoff, whose backfill assumes every
reported skip is architectural, so it is held back rather than risk mislabeling a
non-architectural stub.

**One candidate per `duplicate_of` family** (issue #1784). Stubs whose verdicts
place them in one Sentry issue family consume ONE autofix run between them, not
one each: #1304, #1313, #1316, #1326 and #1328 all resolved to
`ANALYTICS-MENTO-ORG-2E` and all five ended `sentry:fix-refused` — five runs and
five refusal records for one root cause. The selector groups candidates by the
`duplicate_of` the verdict already carries, unioned TRANSITIVELY over SHORT-IDs
(the graph is directional — #1304 listed six duplicates while the others pointed
back only at `2E`, and a member id may connect two candidates without being one
itself), and picks the family's **oldest** candidate. A family stands down
entirely when any of its SHORT-IDs already carries `sentry:fix-pr-opened` or
`sentry:fix-refused`, which is what stops a refused representative from handing
the family back one member per run.

Those terminal siblings are excluded from the candidate window, so the selector
reads them back keyed on the referenced id — never a recent slice of the ledger
(PR #1810). It queries each **declared** family id by title, so a blocker sitting
arbitrarily deep in the ledger is still found (a fixed slice would miss one past
its edge). And it **reverse-verifies** each finalist's family by searching issue
comments for the family's member ids, admitting an edge only after re-parsing the
hit's verdict through the same authorship fence — which catches the two links the
forward `duplicate_of` graph cannot see: a handled sibling that names a finalist
which declares nothing itself, and a hub id two stubs share through an issue that
is not a candidate. An admitted hub joins its WHOLE declared family (not just the
probed id), so a terminal sibling the hub names alongside the finalist is pulled
into the family; the fixpoint then re-checks that reverse-surfaced id's own
marker by title, since its edge is exactly the one the forward pass never
declared and reverse-probing it alone would never reach. Both reads are keyed on
ids, so nothing depends on where a stub sorts in the window.

Two bounds keep an agent-authored `duplicate_of` list from reaching further than
that. Family ids are **project-scoped**: only `ANALYTICS-MENTO-ORG-<suffix>` ids
join or block, because `isValidShortId` accepts any hyphenated token — including
a foreign project's id and the bare project slug itself, either of which would
otherwise union unrelated bugs into one starved family. And the representative is
the family's oldest member, never a ranking over the pointer graph: in-degree is
a count an attacker sets by creating more Sentry issues that name their chosen
id, while `createdAt` is GitHub's. Because the selector applies its cap in window
order, oldest-first representation is also what gives a family the queue slot of
its OLDEST member — otherwise newer independent candidates could push a family
past the cap on every run and permanently starve the queue's oldest candidate,
which is exactly what `sort:created-asc` exists to prevent. Family membership may
suppress a candidate; it can never reorder the queue.

Deferral writes nothing — no label, no comment, no marker — and the next run
recomputes the whole decision from live state. It is **not** self-expiring,
though: a `sentry:fix-pr-opened` / `sentry:fix-refused` block lifts only when
that marker goes away, which happens when the blocking stub's Sentry issue
regresses and `requeueQueueStub` sheds it (`REOPEN_SHED_LABELS`), or when a human
removes it. A blocker that is fixed and stays fixed, or refused and stays quiet,
keeps blocking — and `duplicate_of` is a family signal, not a confirmed
duplicate, so a wrong grouping can suppress a genuinely distinct stub for as long
as that holds. Every deferral is therefore **reported**: the select job emits a
count and the deferred issue numbers, and the tracker run record renders them as
`Deferred (duplicate_of family): N (#…)`. Without that line a run that stood its
whole window down read as `Candidates selected: 0` — byte-identical to an empty
queue, i.e. a permanently starved leg looking like a healthy idle one. An
operator who sees a standing deferred count overrides it with the single-issue
`workflow_dispatch`, which skips the collapse entirely: naming one issue is
explicit human intent that beats a heuristic signal. Selection itself stays
read-only and never re-queues anything.

**Cost bound** (PR #1810, re-sized when the window went to 200). Terminal,
projected, archived, and external-project stubs are all excluded server-side
before `--limit` applies, so the eligible window stays single-digit at steady
state and the leg's `gh` volume no longer scales with the list ceiling. Every leg
of the per-run `gh` cost is bounded by a named cap, so the ceiling is a real
bound, not an average.

Count it in **two units**, because they are different numbers and conflating them
is how a drift detector ends up compared against a ceiling it can never reach:

| unit                 | what it is                                                                         | worst case, first pass | + second look |
| -------------------- | ---------------------------------------------------------------------------------- | ---------------------- | ------------- |
| `gh` **invocations** | serial subprocesses; ≈ 1 s each, so this is what the job **timeout** is spent in   | 521                    | **782**       |
| API **requests**     | what the rate limiter **bills**; `gh issue list` paginates at 100 rows per request | 522                    | **786**       |

The first pass: one window list invocation (2 requests at 200 rows) +
`MAX_CANDIDATE_EVALUATIONS` (200) × 2 reads (issue view + PR list) +
`MAX_HANDLED_ID_QUERIES` (40) per-declared-id lookups + `MAX_REVERSE_PROBE_QUERIES`
(40) reverse `in:comments` searches + `MAX_REVERSE_VERIFY_READS` (40) cached verify
reads. Every call is serial — there is no `Promise.all` anywhere in this leg — so at
a pessimistic ~1 s/call that worst case is ~13 minutes. The run record reports
**invocations** (`gh invocations: N`), and the suite pins invocations; the
per-bucket rate arithmetic below runs in **requests**. Two of those legs are the bug-B
mirror of the handled-id one. `probeIds` is the union of a cap-2 finalist set's
family members, and a family can hold up to `MAX_FAMILY_MEMBERS` (40) ids, so
without the search budget a run could fan out to ~80 secondary-rate-limited SEARCH
queries per iteration × `MAX_REVERSE_ITERATIONS`; capped, it stays a bound. Each of
those searches then returns up to `REVERSE_SEARCH_LIMIT` (100) rows, and every
unseen row costs one authoritative verdict re-read before the fence can reject it,
so without the verify-read budget the admit leg fans out to
`MAX_REVERSE_PROBE_QUERIES` × `REVERSE_SEARCH_LIMIT` (4000) `gh issue view`
subprocesses — `MAX_REVERSE_VERIFY_READS` bounds the distinct cache-miss reads
across the whole fixpoint so the "cached verify reads" term is a real cap, not an
average.

`LIST_LIMIT` (200) is the **hard upper bound on the window**, not a decoration:
`--limit` caps what the API RETURNS, and that happens BEFORE
`MAX_CANDIDATE_EVALUATIONS` slices the rows. Raising the evaluation cap above the
list limit is therefore a strict **no-op** — the run reads exactly `LIST_LIMIT`
rows either way and nothing says so. **The two must move together.** A suite test
pins `MAX_CANDIDATE_EVALUATIONS <= LIST_LIMIT` and `windowCeilingWarning` re-checks
the pair at run time (it warns, it does not throw — a static config mistake must
not break the always-emits-an-array contract). They are equal today, at 200, which
is why the `Window: N stubs, evaluated M` line no longer fires: the exclusion set
is what keeps the eligible window small, and the second look below is what covers
the case where 200 rows are not enough.

The select job's `timeout-minutes` is **25** (raised from 10 with the window), so
the ~782-invocation worst case fits at ~52% of the budget with room for checkout,
setup, and API-latency spikes rather than being sized to hope. CI minutes are free
on this public repo's `ubuntu-latest`, so that headroom costs nothing.

**The timeout is not the only constraint.** Split the ~786 requests by bucket
against the free-plan budgets (1,000 core req/hr per repo, 1,000 GraphQL points/hr,
both SHARED with every other workflow in this repo):

- **GraphQL = 486** — 6 list pages + 300 `issue view` + 60 `in:title` searches +
  60 `in:comments` probes + 60 verify reads. `gh issue list --search` routes to
  GraphQL, not the REST search bucket. The 6 pages are **2 + 4**: the first
  pass asks for 200 rows (2 pages at 100 rows/request) and the second look for
  301 (3 full pages plus a fourth holding only its sentinel row — see "Bounded
  second look"). The 300 `issue view` are the per-stub verdict reads, 200 in the
  first pass and 100 in the second; each family term is likewise its first-pass
  cap plus the second look's half (40+20).
- **REST core = 300** — one `gh api repos/…/pulls` per evaluated stub (200 + 100).

So one worst-case run burns **~49% of the repo's hourly GraphQL budget and ~30% of
core in 13 minutes**, while `agent` (30 min) and `finalize` (15 min) do their own
`gh` work inside the same hour. That is a ~2x margin, not a non-issue, and it is
~3x what the leg spent before the window went to 200. It is therefore MEASURED, not
asserted: the job echoes `gh api rate_limit` immediately before and after the select
step (`rate-budget before …` / `rate-budget after …`, one greppable line each), and
the selector counts its own `gh` invocations and reports them as `gh invocations: N`
on the tracker. The mitigation on the other side is the latch described under "Fail
closed on rate limiting" — the first throttle-shaped failure stops the run from
issuing any further read, so a run that hits the wall stops pushing on it rather
than spending its remaining ~400 requests into an active secondary limit.

The read budget truncates the window's **newest** tail (it is oldest-first). Each
reverse
`in:comments` search itself reads a bounded page — `REVERSE_SEARCH_LIMIT` (100),
5x headroom over the queue scale — rather than paginating to exhaustion (PR #1810
follow-up); a search that comes back a full page deep flags the same reverse
truncation, since a sibling could sit on an unread page 2 (the #1808 class), and so
does a run that exhausts `MAX_REVERSE_VERIFY_READS` before reading every hit. All
lookup budgets fail toward MORE candidates (a family that should stand down is
re-attempted, never wrongly closed), and each truncation is surfaced too —
`Handled-id lookups truncated: N …`, `Reverse family verification truncated: …`
(cause-neutral: the probe budget, the verify-read budget, **or** a full search
page can each raise it), or `Reverse family verification did not converge …` — so
a bounded re-attempt is never the silent, healthy-looking one the Window line
exists to eliminate.

**Bounded second look** (the starvation fix). Family deferral writes nothing, so
a window whose every stub is a deferred family member returns byte-identical next
run — and a selectable stub sitting one row past the list ceiling is never
evaluated, at any point, ever. When the first pass yields **zero** selectable
entries **and** the list came back **full** (`rawCount >= LIST_LIMIT`, so more may
exist), the selector takes ONE bounded pass over the rows beyond that ceiling: a
single `gh issue list --limit <skip> + SECOND_LOOK_LIST_ROWS + 1` with the first
`<skip>` **raw** rows dropped client-side (raw, because `--limit` is applied
server-side before the project filter, so a filtered-row skip would not line up)
and the trailing `+ 1` **sentinel** row dropped before anything reads it.
It evaluates at most `MAX_SECOND_LOOK_EVALUATIONS` (100) of them and resolves
families over them on its OWN halved budgets (20 handled-id / 20 reverse probe /
20 verify read) — the first pass has already spent the per-run ones — but over the
first pass's **findings**: the blockers, edges, probed ids and cached stubs it
resolved are seeded in. Fresh budgets, inherited knowledge. Without the seed the
smaller budget would have to re-derive blockers the run had already proven, and
every budget here fails OPEN toward MORE candidates, so a family whose terminal
sibling the first pass found at probe 25 would be unreachable at 20 — and the
second look would select a stub the same run had just stood down.

The seed carries **answered** work only, and that distinction is load-bearing in
both directions. Each of the resolver's dedupe structures has a wider in-pass
twin that also absorbs ids the pass **dropped** for budget, **failed** to read,
or left half-read: `listHandledShortIds` folds every overflowed id into its
re-attempt guard so the per-run overflow counts each distinct un-runnable id once
rather than once per fixpoint iteration; a probe id is recorded before its search
runs; a thrown stub read is negative-cached as `null`. All three are right within
one pass, where a budget only shrinks — and wrong the moment a pass with a FRESH
budget inherits them, because they then claim work nobody completed was
resolved. The second look would spend none of its new allowance on those ids and
select a stub whose sibling carries a terminal marker no read ever looked at: a
duplicate autofix PR reached from the opposite side to the throttle case. So the
resolver returns only the answered subsets, and the in-pass guards start from
them. Seed too little and the second look re-derives proven blockers on half a
budget; seed too much and it skips work nobody did. Both land on the same
duplicate PR.

`SECOND_LOOK_LIST_ROWS` **equals** `MAX_SECOND_LOOK_EVALUATIONS`, bound by the same
no-op invariant as `MAX_CANDIDATE_EVALUATIONS`/`LIST_LIMIT` (the row cap is applied
first, so raising the evaluation cap alone would read the same rows and say
nothing); `secondLookCeilingWarning` re-checks the pair at run time and a suite test
pins it. The skip offset is `min(MAX_CANDIDATE_EVALUATIONS, LIST_LIMIT)` rather than
`LIST_LIMIT`: the two are equal today, but under a LOWER eval cap a `LIST_LIMIT`
skip would leave the rows between the two read by neither pass — a permanent hole
in the middle of the window, the exact starvation this pass exists to close.

It costs a healthy run **nothing**: anything selected in the first pass and the
second look never fires. Stated plainly, though: the ~782 figure is a worst case
for the timeout, not a rare one for the budget. The fire condition is zero entries
off a full RAW page, and the residue class below (unparsable verdicts, foreign
`affected_repo`) selects nothing while still filling the page — so once the queue
passes `LIST_LIMIT` raw rows in that state, a run pays close to the full bill every
weekday and still selects nothing. The `and MORE rows sit past even that` clause is
what makes that state visible on the tracker instead of inferable from a bill. Every fact reaches the tracker on one line — `Second look:
N further stubs past the window, evaluated M`, plus **`— and MORE rows sit past even
that`** when the second look's own page came back full, or **`the second look's own
list read FAILED`** when it could not read at all. That `full` flag, not the counts,
is the standing tripwire for queue regrowth: `N` is clamped by the row cap, so the
counts alone read identically whether 100 stubs or 5,000 sit past the ceiling.

That is why the second look's `full` is a **sentinel** read rather than the first
pass's `rawCount >= limit` form. The two differ at exactly one queue size — when
`skip + SECOND_LOOK_LIST_ROWS` raw rows exist and nothing is past them — and there
the weaker form states on the tracker that more rows remain and the queue is
outgrowing one run's reach, which is false. So the second look asks for one row
past its ceiling, never evaluates it, and raises `full` only when it comes back.
The **cost delta is one API request per second look** (301 rows is four 100-row
pages instead of three), no extra `gh` invocation and no extra per-stub read; it
is the whole difference between the 785 this leg would otherwise bill and the 786
above. The first pass keeps the cheaper form on purpose: its `full` only decides
whether to run this pass, and over-firing costs one list call on a run that
already selected nothing — far less than an extra request on **every** run.

Three `gh` calls in this leg have no fail-soft handler under them: the first
pass's window list, the single-issue dispatch's `readStub`, and the second look's
own list — which this pass put on the frequent path, since once the queue is ≥
`LIST_LIMIT` rows EVERY no-selection run depends on it. All three are caught, and
all three split the same way:

- A **rate-limit-shaped** failure DEGRADES the run — `[]`, `rateLimited`, the
  `::error::` line, exit 0. `instrumentRunGh` records the throttle and rethrows
  (so every fail-soft handler downstream keeps its exact behaviour), so without
  the catch the rejection reaches `main`, exits 1 and kills the step under `set
-euo pipefail` — destroying the whole run record including the DEGRADED line a
  throttled run needs most. The second look's own failure additionally reports
  `secondLookFailed` and stands on the first pass's result, which by precondition
  selected nothing, so nothing is lost.
- **Any other** failure still propagates and fails the step, unchanged. A
  malformed body, a dead token or a missing `gh` means the run cannot see its
  queue at all; there is no window to report on, nothing can be wrongly selected
  from a read that never happened, and a failed step is the louder signal. The
  fail-closed work deliberately did not touch it. (The second look is the one
  exception, and only because the first pass's report is already complete and
  valid: its non-throttle failure is a `::warning::` plus `secondLookFailed`.)

The arithmetic that sizes it: 521 (first pass) + 1 list invocation + 2×100 reads +
60 family budget = **782** serial invocations, ~13 min at 1.0 s/call, ~52% of the
25-minute job budget.

**Fail closed on rate limiting.** Nearly every read in this leg fails SOFT toward
MORE candidates — `readStub` and `openAutofixPrExists` in
`scripts/sentry-autofix-candidate.mjs`, the per-id handled lookups in
`scripts/sentry-autofix-family-handled.mjs`, the reverse probes in
`scripts/sentry-autofix-reverse-verify.mjs`. That is the right trade for a
transient blip (one self-terminating extra attempt), but the blockers those reads
look for ARE the dedupe signals, so a throttled read is indistinguishable from
"no blocker found" — and a rate-limited run can open **duplicate** autofix PRs
and still look green. A 200-wide window raises that probability.

So the run's `gh` driver is wrapped once, and a rate-limit-shaped rejection marks
the whole run DEGRADED. The shapes are what `gh` actually prints, folded into its
rejection message: `HTTP 403: API rate limit exceeded …`, `HTTP 403: You have
exceeded a secondary rate limit …`, `HTTP 429 Too Many Requests`, `GraphQL: API
rate limit exceeded … (rateLimitExceeded)`, and `You have triggered an abuse
detection mechanism`. A bare `HTTP 403` permissions failure matches too, on
purpose: both mean the read did not answer the dedupe question, and both warrant
the same action.

A degraded run emits **zero** matrix entries and says so loudly — the select job's
disposition becomes `degraded-rate-limited` and the run record carries a
`**DEGRADED (rate limited):** N gh read(s) …` line. It does **not** throw: the
select step must ALWAYS emit a valid JSON array and never fail the step (it runs
under `set -euo pipefail` and the matrix consumes its stdout), so fail-closed here
means `[]` plus a loud report. The degraded disposition also suppresses the
architectural label backfill, since that write would be driven by skips computed
off reads that may never have answered. Non-rate-limit transients keep their
existing per-read fail-soft behaviour, unchanged.

The selector reads only PRs whose head branch is in **this** repo. A branch-name
match returns fork PRs too — they carry the same head branch — so on a public
repo with a deterministic `sentry-autofix/<short-id>` branch anyone could
otherwise present a PR that the leg reads as its own prior fix, which would
comment that PR's url onto the queue stub, apply the terminal marker, and stand
the stub's whole family down behind it. So every ownership read hits the REST
pulls endpoint with an **owner-qualified** filter,
`GET /repos/{owner}/{repo}/pulls?head=<owner>:<branch>&base=main&state=open`:
GitHub excludes forks **server-side** (a fork's head-repo owner differs), so no
page of spoof PRs can hide the real one, and `base=main` pins the base the leg
always opens against — open-PR uniqueness is per head+base, so at most one row
returns. Each returned row is still re-checked as defense in depth, against the
REST shape: `.head.repo.fork === false` **and** `.head.repo.owner.login` equal to
`<owner>` (lowercased), failing **closed** on any missing field. The endpoint
returns neither `isCrossRepository` nor `headRepositoryOwner`, so never reach for
those. This holds for all four lookups: the selector's dedup
(`openAutofixPrExists`), the normal finalize path's relink-under-marker and
dup-guard reads (PR #1810 follow-up), and the finalize reconcile step. A fork PR
on the branch name is treated as **not ours**: the normal path opens our own PR
instead of adopting it, and neither reconcile path relinks to it.

The LLM agent runs in a **read-only `agent` job** (contents:read + issues:read,
no App token) and hands its whole working tree to a separate **trusted
`finalize` job** as an artifact (issue #1373). Finalize re-derives the changed
set and re-runs the diff guard against its own pristine clone — trusting no
agent-provided metadata — before it mints the App token, pushes, and opens the
PR. So a prompt-injected agent that exfiltrates its job's `github.token` gets a
read-only token that cannot write issues, push, or open PRs; only the Claude
OAuth inference token stays exposed (inherent to the action, out of scope for
#1373). A live-FS symlink tripwire in the agent job rejects a symlink-exfil diff
before it can reach the handoff artifact.

Do not use manual dispatch as a probe: there is no dry-run mode. Dispatch from
`main`; an off-`main` dispatch is a deliberate no-op. On `main`, when the
stage is enabled and the issue is eligible, dispatch creates a real branch and
PR. The workflow never merges it.

If the `code-fix` verdict is shed while the PR is being opened (a regression
re-queue in ingest's separate concurrency group), finalization withdraws rather
than marking the stub fixed. It re-reads the verdict immediately before and
after writing the `sentry:fix-pr-opened` marker; on a shed verdict it closes the
just-opened PR (the selector dedups on an open autofix PR too, so skipping the
label alone would not free the stub), removes any marker it already applied, and
comments that the fix was not finalized. A closed autofix PR carrying no marker
is that intentional regression-re-queue outcome, not an orphaned run; an
unconfirmable close fails the run loudly rather than leaving a stale PR that
would suppress the re-fix.

That re-read also checks the verdict comment's **identity**, not just the label's
presence (a **generation token**, issue #1506). The trusted select job captures
the numeric id of the verdict comment the fix was based on and threads it to
finalize through the matrix; finalize re-selects the live verdict comment and
withdraws if the id no longer matches. This catches an ABA a re-triage can create
inside the window — sheds the label, then re-adds it with a **new** verdict
comment — which label-presence alone cannot see. Reconcile entries carry no token
(they relink a prior run's PR, whose originating verdict id select never saw), so
they stay on the label-presence guard; the token is never sourced from the agent
job or the handoff artifact.

### Human-approved archive

Archiving is independent of the verdict. An authorized human may apply
`sentry:approved-archive` to any verdicted queue issue. The archive workflow
revalidates the live approval and verdict before and after the Sentry mutation,
refuses a currently regressed/escalating issue, and uses the documented issue
update API to set `archived_until_escalating`. It then records the approver
and timestamp, applies `sentry:archived`, and closes the queue issue.

The regression refusal re-queues the stub through `requeueQueueStub`, declaring
cause `sentry-evidence`; that is what makes its comment open with the regression
fence line, so the verdict parser reads the previous round's verdict as stale.
The cause is the whole rule: one caused by new Sentry events must fence, because
any prior verdict described the old occurrence; one caused by bookkeeping — the
stranded-stub sweep above, which declares `bookkeeping` — must not, because
nothing about the Sentry issue changed and that verdict is still valid. Drop the
fence and the digest, projection, and autofix consumers all read a verdict
describing a dead occurrence. Add one where it does not belong and a good
verdict is discarded and re-triaged for nothing. Neither call site can make that
mistake by omission: an undeclared cause refuses rather than defaulting either
way, and `buildRegressedComment` — the fence's one definition — has exactly one
caller, inside the chokepoint.

The fence is no longer the only thing standing between a fence-free re-queue and
a stub closed over a live regression. The `verdict` job is additionally bound to
the round that produced its verdict ([the round binding](#the-round-binding)),
which holds whether or not a fence was posted and whether or not the declared
cause was right. The fence still decides admissibility for every consumer; the
binding decides whether this run may settle the stub at all.

The refusal will not re-queue a stub it cannot fence, and it decides that by
asking whether any verdict is still admissible — never by checking that a fence
comment exists. Presence is not admissibility: the refusal body is identical
across runs for one `lastSeen`, so an earlier run's fence can sit on the stub
underneath a verdict posted after it, where the parser correctly ignores it. Both
checks on this path run `selectVerdictComment`, the parser's own selector, so the
guard and the thing it guards against cannot drift apart. Both now live in the
chokepoint, so a future re-queue site inherits them instead of re-deriving them.

If approval disappears during the mutation window, the script rolls the queue
stub back and leaves it available for fresh triage. It does NOT un-archive the
Sentry issue: `archived_until_escalating` is the approved outcome and it
self-heals on escalation (see below). A later Sentry escalation also reopens and
cleans the queue stub. The best-effort Sentry link-back note uses an endpoint
absent from the public API reference; note failure is logged but never masks an
otherwise successful archive.

Ingest and archive run in separate concurrency groups, so two narrow races
remain after the label re-reads above. Both are closed mechanically (issue
#1371); a shared `concurrency:` group is deliberately NOT the fix, because
GitHub keeps only one pending run per group and would silently drop a second
human-approved archive queued behind a running ingest.

**Consuming the approval is a compare-and-swap.** Settlement deletes
`sentry:approved-archive` through
`DELETE /repos/{repo}/issues/{n}/labels/sentry:approved-archive` — not
`gh issue edit --remove-label`, which swallows the 404 — and only closes the
stub if that delete succeeded. The label is the single token both writers
contend for: ingest's regression reopen sheds it too, so a 404 means this run
lost, and it aborts settlement and runs the same queue rollback as the
label-shed path.

Consuming before the close costs one thing, and the runbook below covers it. A
failure past the CAS cannot be retried by `workflow_dispatch`, whose guard needs
the approval label the run just spent. The stub is rolled back and the run fails
RED, leaving it with no approval, no `sentry:archived`, and no
`sentry:needs-triage` — in **one of two shapes**, because the rollback restores
the state the stub had before settlement rather than forcing it open:

- **open**, when the stub arrived open (the common case: a verdicted stub a human
  approved while it was still open);
- **closed**, when `sentry-triage-agent.yml` had already closed it. The
  reconciler deliberately does not reopen a stub this run did not close.

The OPEN one is the shape ingest's stranded sweep now recovers once it has been
idle for a day (issue #1817): it is open, verdicted and unqueued, which is
the same damage a failed compensation leaves, and the sweep repairs shapes rather
than producers. Recovery restores `sentry:needs-triage` and re-triages the stub;
it consumes nothing, since this shape carries neither the approval nor
`sentry:archived` by definition, and it answers no question about **Sentry** —
the run's summary line and the runbook below still own that.

The archive leg's **freshness refusal** ends in the same shape and is recovered
for the refusal's own reason. It fires because a Sentry event landed during the
archive, so the verdict on that stub now predates a live occurrence and no stage
would otherwise re-triage it — ingest skips an open match. The refusal asks for
"a fresh approval rather than a full re-triage"; a day later the sweep gives the
approver something fresher to approve. The pre-event verdict cannot settle
that round either: the sweep posts no fence, but [the round
binding](#the-round-binding) refuses any verdict comment that is not strictly
newer than the one `select` recorded.

The CLOSED one still waits for a human. No stage picks it up — ingest skips a
closed stub whose `closed_at` postdates the regression, the triage agent selects
on `sentry:needs-triage`, archive needs the approval — and nothing distinguishes
it from an ordinary settled ledger entry, so nothing may act on it. That is
deliberate, since the alternative ordering closes stubs over live regressions.
The Sentry issue stays archived throughout — the next paragraph says why, and
what that means for the re-approval the runbook asks for.

**A failed settlement leaves Sentry archived, on purpose.** Automation may only
ever set `archived_until_escalating` (ADR 0036), and that state is self-healing:
escalation resurfaces the issue by itself. So a run that archived successfully
and then failed to settle its queue stub has left Sentry in exactly the state a
SUCCESSFUL archive would have produced — the state a human already approved.
Reverting it bought nothing and cost a check-then-PUT race against Sentry's own
transitions: the check can still read `archived_until_escalating` while Sentry is
concurrently flipping a freshly-escalated issue to `unresolved`, and the PUT
then erases that signal. Ingest finds old issues through `is:regressed` **and
`is:escalating`** — two separate queries, because Sentry's grammar treats them
as distinct filters and the archive leg only ever produces the second (#1765).
Erase the signal and the event vanishes from both systems regardless. Only the
queue stub is rolled back.

That makes re-approval the standard recovery, so it carries its own guard. A run
over an issue that is ALREADY archived needs a baseline it can stand behind, and
refuses in both directions where it has none:

- **Stale** — the stub records a bound baseline and Sentry's `lastSeen` has moved
  past it (`skipped-stale-retry`). Settling would stamp the newer timestamp, and
  the reopen gate would never fire for the event in between.
- **Absent** — the stub records no baseline bound to this Sentry issue
  (`skipped-unbaselined-retry`). This is the state rollback deliberately leaves
  when a run archived Sentry and then failed before writing one, so it is the
  common case on re-approval. Adopting the retry's own read would take every
  event since the archive as "already accounted for". A baseline that is
  unparsable or names another issue counts as absent for the same reason.

Neither path mutates anything; both remove the approval so a bare re-dispatch
cannot skip the decision, and both write the refusal on the stub. Recovery is to
un-archive the Sentry issue and let it re-triage — the event is invisible to
ingest while it stays archived, since every ingest query matches only unresolved
issues.

**Queue rollback reconciles; it does not replay.** Every failure from the Sentry
PUT onward re-reads the stub and corrects only what live state actually shows to
be wrong — reopened if it is closed now and was open before, the terminal label
removed if present, and the body restored whenever its recorded baseline differs
from the pre-run one. Nothing consults a record of what the run believes it did,
because a rejected command is not proof its remote mutation did not happen: `gh
issue close` can close the stub and then lose its response. Any did-we-do-it flag
is wrong in exactly that case, and it is the case that matters. Reconciling is
idempotent by construction — a second pass finds nothing to correct — and it
re-reads once more afterwards, because a correction can be accepted and still not
take effect. When that final read still disagrees the run fails RED with one
`::error::` naming the stub's observed state.

The audit note is posted LAST, after the close, the terminal label and the
verification have all converged. Ordering rather than compensation: a note that
landed before a failing close would claim the issue was archived, and a later
successful re-approval would see that marker, suppress the real audit, and leave
the durable record showing the failed attempt's approver, timestamp and baseline.
A note that fails on its own is logged and tolerated — the settlement is already
correct, and the machine-readable record lives in the body.

Its at-most-once key is the archive GENERATION, not the Sentry issue: the marker,
the issue id, and the freshness baseline together. A stub can be archived,
regress, be reopened by ingest (which keeps its comments), be re-triaged,
re-approved and archived again, and the previous archive's note still matches
both the marker and the id — keying on those alone suppressed the new audit and
lost the new approver, timestamp and disposition. The baseline advances with
every genuine re-archive, so it distinguishes them; a true retry of the same
archive carries the same baseline and still dedups.

**Known residual: a run that dies cannot roll back its own queue writes.**
Reconciliation needs the process to survive. If the runner is cancelled or killed
mid-settlement — job timeout, OOM, a cancelled workflow — the stub can be left
part-settled, and the Sentry issue archived while the stub still carries
`sentry:approved-archive`. A later `workflow_dispatch` takes the already-archived
path, and because settlement consumes the approval before it writes the body, the
stub cannot yet carry a baseline — so that retry is REFUSED as
`skipped-unbaselined-retry` rather than recording its own read time. Nothing in
the dead run's window is absorbed, but nothing is recovered either: the Sentry
issue stays archived and is invisible to every ingest query until someone acts.
Closing that would take a durable intent record written before the PUT, which is
not what this change does. The mitigation is operational: a killed archive run
leaves a red or cancelled run in Actions — un-archive the Sentry issue so ingest
re-queues it, then let the normal triage and approval cycle run.

**The archive records a freshness baseline.** Sentry's `substatus` lags a fresh
event, so the regressed/escalating refusal can pass while an event is already in
flight. The script captures the `lastSeen` it read before the mutation, re-reads
it once after the PUT, and — if it moved, or if that read-back fails or does not
parse — restores the Sentry issue, sheds the approval, and refuses without
settling. That matters because the archive's close necessarily postdates any
event that arrived inside the mutation window: a `closed_at` comparison would
evaluate false for that event forever and bury it until some later event
happened to arrive.

This refusal is the ONE path that still reverts the Sentry archive, and the
asymmetry is deliberate. A failed settlement leaves an archive whose premise
still holds — the human approved it and nothing contradicted that. A freshness
refusal is the opposite: it is positive evidence that an event landed which the
approver never saw, so the approval's premise is void. Leaving the archive there
would bury that event, because a still-archived issue matches no ingest query
(all of them are `is:unresolved`) and a single already-counted event does not
reliably trip Sentry's escalation forecast — so the `is:escalating` query that
does catch an escalated archive (#1765) never fires either. Reverting puts the
event back in front of ingest.

**There are two baselines, and they answer different questions.** The live read
above is what THIS RUN observed, and only this run's own gates may use it: the
post-PUT mutation-window comparison, and the two already-archived retry refusals
(`skipped-stale-retry`, `skipped-unbaselined-retry`), which exist to say whether
anything moved since the archive that already happened. Repointing those at any
earlier value would refuse every legitimate `workflow_dispatch` retry as stale.

Ingest reads the OTHER one. The live read happens after the human applied
`sentry:approved-archive` — 30-90 seconds later on the label trigger, unbounded
on a dispatch — so an event landing in that window is folded into the value
meant to detect it, and `lastSeen > baseline` is false for that exact event
forever. The reopen baseline is taken from the stub body's own `last_seen`,
written by ingest when it **created** the stub and never rewritten since — a
reopen edits the stub's labels, comments and state, never its body — so it
predates the approval by construction. On a stub that has flapped it is still
the creation instant and can be as old as the stub itself; that only
makes reopens more eager, which is the intended bias — a spurious reopen costs
one triage cycle, a buried regression costs an incident. Two guards keep it from
being the worse choice: an unparsable stub `last_seen` falls back to the live
read (the pre-#1692 behaviour, so a stale body field can never make a human
approval unspendable), and a stub `last_seen` newer than the live read loses to
it.

**The baselines live in the stub BODY, never in a comment.** They are written
into the same yaml block ingest creates the stub with, as
`archive_baseline_last_seen` (the live read) and
`archive_reopen_baseline_last_seen` (the pre-approval instant ingest compares
against), plus the Sentry issue id the run mutated, and the write
happens before anything marks the stub settled. A stub archived before the
second field existed carries only the first, and ingest falls back to it, so
those stubs behave exactly as they did. Placement is the entire trust
boundary here, and it is structural rather than cryptographic. The Stage B
triage agent is an LLM reading attacker-controlled Sentry payloads, and
`.github/workflows/sentry-triage-agent.yml` grants it
`Bash(gh issue comment <its stub>:*)` — its comments post as
`github-actions[bot]`, on that exact stub. So no author, marker, or issue-id
check applied to a **comment** is worth anything: a prompt-injected payload
satisfies all three and plants a far-future baseline, after which every later
regression of that Sentry issue is skipped indefinitely. The agent's allowlist
contains no tool that edits an issue body, the autofix agent gets no shell at
all, and the archive leg's deterministic zero-LLM step is the only writer that
ever rewrites one. Moving the field removes the forgery surface instead of
authenticating inside it, which a shared secret could only match, never beat.

Ingest still requires the recorded issue id to match the Sentry issue the stub
tracks; a baseline naming another issue, or naming none, describes some other
archive and reopens the stub for re-triage instead of gating it. Because the
dedup scan already fetches every stub body, reading the baseline costs no extra
request — and there is no comment list to page through.

The baseline is therefore load-bearing, and the archive fails **closed** without
one. If Sentry's pre-mutation `lastSeen` does not parse, the run refuses before
touching anything — no PUT, no queue mutation, the approval label intact so the
stub stays re-dispatchable. If the post-PUT read-back stops parsing, the run
reverts the archive and refuses with its own distinct reason, because a
malformed read cannot prove that no event landed. Neither case may proceed: an
unusable baseline would send ingest back to the `closed_at` comparison, and
nothing downstream can distinguish that from a stub archived before this
contract existed. The `closed_at` fallback in ingest exists only for those older
stubs, never as a path a fresh archive is allowed to take.

## Operator runbook

### Inspect live state first

Use all three surfaces:

1. [tracker #1282](https://github.com/mento-protocol/monitoring-monorepo/issues/1282)
   for activation gates and the rolling ingest run record;
2. Actions history for the four workflows above;
3. repository Actions variables for the literal enable flags.

The run record reports fetched, created, skipped, reopened, recovered, and
error counts. A nonzero recovered count means stubs were found closed while
still labeled `sentry:needs-triage`; a recurring one points at a producer worth
investigating, not at the sweep.
Scheduled workflow failures also route through the repository's main-failure
notifier. Triage produces a per-run `#engineering` digest. Absence of an
expected record or digest is itself a signal.

### Provision and change controls

All values originate in the operator-held, gitignored
`terraform/terraform.tfvars` and are mirrored by the `platform` Terraform
stack:

| Stage           | Terraform inputs                                                          | GitHub surface                                                                   | Minimum privilege                                                  |
| --------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Ingest + triage | `sentry_triage_token`, `claude_code_oauth_token`, `sentry_triage_enabled` | `SENTRY_TRIAGE_TOKEN`, shared `CLAUDE_CODE_OAUTH_TOKEN`, `SENTRY_TRIAGE_ENABLED` | Sentry Issue/Event, Project, and Organization read only            |
| Projection      | `sentry_projection_token`                                                 | `SENTRY_PROJECTION_TOKEN`                                                        | GitHub Issues read/write on the allowlisted owning repos only      |
| Autofix         | `autofix_app_id`, `autofix_app_private_key`, `sentry_autofix_enabled`     | `AUTOFIX_APP_ID`, `AUTOFIX_APP_PRIVATE_KEY`, `SENTRY_AUTOFIX_ENABLED`            | GitHub App Contents and Pull requests read/write on this repo only |
| Archive         | `sentry_archive_token`, `sentry_archive_enabled`                          | `SENTRY_ARCHIVE_TOKEN`, `SENTRY_ARCHIVE_ENABLED`                                 | Separate Sentry Issue/Event read/write token                       |
| Settings audit  | `platform_settings_audit_token`                                           | `PLATFORM_SETTINGS_AUDIT_TOKEN`                                                  | GitHub Administration **read-only** on this repo only              |

All five Sentry-pipeline-exclusive secrets above — `SENTRY_TRIAGE_TOKEN`,
`SENTRY_PROJECTION_TOKEN`, `AUTOFIX_APP_PRIVATE_KEY`, `SENTRY_ARCHIVE_TOKEN`,
`PLATFORM_SETTINGS_AUDIT_TOKEN` — are `github_actions_environment_secret`
resources on the `sentry-pipeline` GitHub Environment
(`terraform/github-environment.tf`), not repo-level Actions secrets. They are
still count-gated on the same tfvars, so an unset value plans and applies cleanly
and the stage stays inert. `CLAUDE_CODE_OAUTH_TOKEN` remains a repo-level secret
(`terraform/github-secrets.tf`) because it is shared with `claude.yml`. Adding a
new Sentry-pipeline secret means: add its `github_actions_environment_secret`
here, and add `environment: sentry-pipeline` to every job that reads it.

To change a stage:

1. update only the relevant tfvars;
2. run `pnpm infra:plan` and inspect the platform-stack diff;
3. obtain explicit human approval;
4. run `pnpm tf apply platform -- -auto-approve` from a clean `main` checkout;
5. verify a bounded live case and the expected observability record.

To pause ingest/triage, autofix, or archive, set that stage's named
`*_enabled` tfvar to `"false"` and reapply. Projection has no enable flag: set
`sentry_projection_token = ""` and reapply. Confirm the plan removes
`SENTRY_PROJECTION_TOKEN`; subsequent external verdicts then record the
visible projection-skipped outcome instead of creating owning-repo issues.
Never widen the read-only token or reuse it for archive. Treat
`CLAUDE_CODE_OAUTH_TOKEN` replacement as a shared-secret rotation and verify
the existing Claude PR workflow after applying it.

The **settings audit** row is not a pipeline stage — it powers
`.github/workflows/platform-settings-drift.yml`, a daily read-only check
(issue #1564) that the repo default workflow-token permission stays `read`
(pinned by `github_workflow_repository_permissions.default_read`, #1557). It is
the ONLY platform credential deliberately given a CI surface with Administration
scope, and it is **read-only** — it can never change a setting. Provision
`platform_settings_audit_token` as a fine-grained PAT with **Administration:
Read** (nothing else) on this repo, then apply the platform stack. Until it is
set the check no-ops; on drift it opens a `drift-detection` + `stack:platform`
issue. Do not point this at the write-capable `github_token` (which stays
local-only) or grant Administration to the autofix App. Fine-grained PATs
expire (≤1 year); when it lapses the check fails loudly ("rotate the audit
token") rather than reporting false drift, so rotate it on that signal.

#### GitHub Environment rollout (issue #1289)

Moving the five Sentry-pipeline-exclusive secrets behind the `sentry-pipeline`
Environment is a one-time, ordered migration. A new `environment:` workflow
reference AUTO-CREATES an unprotected Environment if the protected one does not
already exist (see docs/terraform.md, "GitHub Environments"), and several of the
secrets are live, so roll it out Terraform-FIRST:

1. Apply `terraform/github-environment.tf` FIRST — the
   `github_repository_environment.sentry_pipeline` environment plus its
   `github_repository_environment_deployment_policy` (`branch_pattern = "main"`)
   and the five `github_actions_environment_secret` resources — while the
   repo-level `github_actions_secret` copies in `github-secrets.tf` are still
   present. The env secrets duplicate the repo ones (GitHub allows a secret at
   both scopes), so nothing breaks. The environment and its branch pattern must
   land in the SAME apply: `custom_branch_policies = true` with no pattern
   refuses every deployment.
2. Verify (Settings → Environments → `sentry-pipeline`) that the deployment
   branch rule is an explicit `main` pattern — **not** "Protected branches",
   which is inert here and fails open (#1649) — that admin bypass is disabled,
   and that the expected environment secrets are present. The identity contract
   hash-pins both the environment and the deployment-policy blocks, so a
   _source_ change to either fails CI; a live settings change made in GitHub's UI
   is caught only by the next manual
   `pnpm tf apply platform -- -auto-approve` (no drift job
   monitors the platform stack's environment settings).
3. Prove the gate, do not assume it: from a throwaway branch, have a non-admin
   writer push a workflow that declares `environment: sentry-pipeline` and
   reports only whether a secret is present (never its value). It must be
   refused. #1649 exists because this step was skipped.
4. Only THEN land the workflow `environment: sentry-pipeline` references and the
   removal of the repo-level `github_actions_secret` blocks from
   `github-secrets.tf`, and apply. The protected environment already exists, so
   nothing auto-creates unprotected; the repo-level copies are destroyed and the
   jobs read the environment secrets.

Apply step 4 at a quiet time (avoid the 05:30 / 05:41 / 07:55 / 08:30 UTC cron
windows) so no scheduled run coincides with the repo-secret destroy. The
platform PAT must carry the **Environments: Read/write** fine-grained
permission or the environment-secret writes 403 (`terraform/providers.tf`).

### Backfill or retry

- After an ingest outage longer than the default lookback, dispatch
  `Sentry Triage Ingest` from `main` with `lookback_days` set to an
  integer from 1 to 90. Existing short IDs are skipped, so a wider window is
  safe.
- For a read-only preview, run
  `pnpm sentry:ingest --dry-run --lookback-days 30` with a separately
  provided `SENTRY_TRIAGE_TOKEN`.
- A failed or invalid triage verdict retains `sentry:needs-triage`; rerun the
  agent workflow after correcting the underlying failure. Manual
  `issue_number` dispatches must target an open queue issue.
- **A red `verdict` job saying it refuses to settle a stub "on a verdict this
  triage round did not produce" is working as designed** ([the round
  binding](#the-round-binding)). The round posted nothing — usually because the
  agent leg failed — so the stub keeps `sentry:needs-triage` and the next
  scheduled run re-triages it. Read the agent leg's failure, not this one. The
  variant naming an unreadable prior verdict (`unknown`) means the `select`
  job's per-stub read failed; that also self-heals on the next run. Neither
  needs a manual label edit.
- A refused autofix is terminal until a human reviews the refusal, corrects
  any transient cause, and removes `sentry:fix-refused` from the queue issue.
  Then dispatch `Sentry Autofix` from `main` for that issue or let the next
  scheduled run select it. A later Sentry regression clears the marker
  automatically.
- A projection without its token closes the queue issue with an explicit
  skipped note. Provision the token and re-triage only when the owning-repo
  issue is still required.
- **A red archive run whose stub is verdicted and carries neither
  `sentry:approved-archive` nor `sentry:archived` failed after it consumed the
  approval.** It can be **open or closed** — the rollback restores whichever
  state the stub had before settlement, so a stub `sentry-triage-agent.yml` had
  already closed comes back closed. The open one goes back in the triage queue by
  itself, a day later, via ingest's stranded sweep (#1817) — that repairs
  the QUEUE, not this failure, and no re-dispatch of the archive is possible
  either way, because its guard needs the label the run spent. The closed one is
  the easier to miss and the one nothing recovers, because it looks like an
  ordinary settled ledger entry until you notice it has no `sentry:archived`.
  Only the stub was rolled back, so start from the run's one summary line — and
  read what it says about **Sentry** before assuming anything, because two
  dispositions produce this same stub shape:
  - **"stays archived_until_escalating"** — the archive landed. That is by
    design, not damage: it is the outcome the approver asked for, and escalation
    undoes it automatically. Carry on with the options below.
  - **"is in an UNKNOWN state"** — the PUT returned a 5xx or lost its response,
    so it may never have applied. **Open the Sentry issue and read its state
    before doing anything else.** If it is not archived, nothing was archived:
    the stub is simply unsettled, and the fix is a fresh approval once you are
    satisfied the issue should still be archived. If it is archived, treat it as
    the case above.

  Then check convergence. A `::notice::Rolled the queue stub … back` line means
  the stub converged and there is nothing to repair. An
  `::error::… did NOT converge` line names what it was observed to hold — fix
  that by hand: check the body carries the baseline it had BEFORE this run (or
  none, if it had none). Then choose the outcome explicitly — nothing chooses it
  for you:
  - to leave it archived, do nothing; the ledger entry is the only thing missing;
  - to settle the ledger, re-apply `sentry:approved-archive` — but expect a
    refusal, and read it rather than working around it. The rollback removed the
    baseline this run wrote, so unless an EARLIER archive left one the retry
    lands on an already-archived issue with nothing to compare against and
    refuses as `skipped-unbaselined-retry`: comment on the stub, approval
    removed again, nothing mutated. That is correct — there is no trustworthy
    value to adopt, and taking the retry's own read would hide every event since
    the archive. The way through is the next option;
  - to send it back through triage, add `sentry:needs-triage`, remove the
    `sentry:verdict-*` label, **reopen the stub if it came back closed**, and
    **un-archive the Sentry issue**. Leaving the approval off is not enough on
    its own: ingest skips an open stub, the triage agent selects on open stubs
    carrying `sentry:needs-triage` — so a closed one stays invisible however it
    is labelled — and while the issue stays archived it matches no ingest query
    (all of them are `is:unresolved`), so nothing re-surfaces it. Un-archiving puts it back in front of the
    pipeline,
    after which the next archive records a baseline it can stand behind.

- An archive **refusal** comment that says the archive could NOT be reverted is a
  different case from the above: the freshness refusal is the one path that does
  revert Sentry, and something moved the issue off `archived_until_escalating`
  before it could. Inspect that issue directly; the stub's state is correct but
  says nothing about where Sentry ended up.
- **A cancelled or killed archive run leaves nothing behind to fix it.**
  Rollback runs in-process, so a job that dies mid-archive never reconciles —
  see the known residual above. Before re-applying `sentry:approved-archive` to
  a stub whose last archive run was cancelled, timed out, or shows no summary
  line, open the Sentry issue and check its state for yourself. If it is already
  `archived_until_escalating`, re-applying the approval will refuse (the stub
  carries no baseline for it); un-archive the issue and let the normal cycle run
  instead.
- **A re-approval refused as `skipped-stale-retry`** means the Sentry issue is
  already archived and has recorded events newer than the baseline on the stub.
  Nothing was changed and the approval label was removed again. Re-applying it
  refuses again — the baseline is still older and the issue is still archived, so
  nothing about the comparison changes. Un-archive the Sentry issue instead: that
  puts it back in front of ingest, which re-queues it for triage, and the
  approval that follows records a baseline covering the newer activity.
- **A re-approval refused as `skipped-unbaselined-retry`** means the Sentry issue
  is already archived and the stub records no baseline bound to it — normally
  because the previous run archived Sentry and failed before writing one, and the
  rollback removed it. Nothing was changed and the approval was removed again.
  Re-applying it just refuses again, by design: there is no trustworthy value to
  compare against, and adopting the current `lastSeen` would treat everything
  since the archive as already accounted for. Un-archive the Sentry issue and let
  it re-triage; the next archive then records a baseline it can stand behind.
- **Trust the run's summary line about Sentry, not an assumption.** It says one
  of: the issue stays `archived_until_escalating` (the approved outcome), was
  NOT archived because the update was rejected, is in an UNKNOWN state because
  the request did not complete cleanly, or was never touched. Only the UNKNOWN
  case requires reading the Sentry issue to find out what happened.
- Do not manually close a pending queue issue to hide a failure. Fix the
  workflow or make a documented human disposition.

## Verification

These checks are offline unless noted. CI runs all of them in the required,
unconditional `Sentry suites` job — one gate step, which names the suite that
broke in its summary table.

That job (no `if:`, in `ci.needs` and absent from `alls-green` `allowed-skips`,
so it can never be skipped) runs the suites and proves they ran (ADR 0062). It
executes `node scripts/sentry-suite-gate.mjs`,
which reconciles the `scripts/sentry-*.test.mjs` files against
`scripts/sentry-suite-manifest.json` by exact set equality (in both directions)
and, for each non-exempt suite, asserts child exit 0, parsed `fail == 0`, parsed
`pass >= floor`, and `pass ==` the per-case lines it emitted — so a suite that
exits 0 without asserting fails the gate. The gate is dependency-free, runs with
no `pnpm install` before it, and its own three suites
(`scripts/sentry-suite-gate.test.mjs`,
`scripts/sentry-suite-gate-integrity.test.mjs` and
`scripts/sentry-suite-gate-isolation.test.mjs`) are enumerated and run like any
other.

Each suite runs from its OWN copy of the derived input set, and every copy is
taken before the first child starts, so no suite can reach another's inputs. The
set is derived rather than listed: the manifest, the runner and its own imports,
every listed suite, each suite's transitive first-party imports (V8's dependency
list, not a text scan), plus per entry its declared `reads` (files it opens) and
`readsDirs` (directories it enumerates, copied whole). A file a suite reads
without declaring is absent from its snapshot, so the suite fails — which is what
keeps those lists honest. Each snapshot is digested when taken and re-verified
immediately before its child runs, and the shared checkout is swept afterwards,
so a suite that writes there is named even though it can no longer change a
verdict.

`scripts/check-sentry-suites-in-ci.test.mjs` is the gate's static half and runs
as the last step of the same job, after the install it needs for `js-yaml`. It
carries what the gate cannot see: that the gate job still exists, is
unconditional, matches ADR 0062's canonical shape key for key, and reaches the
required `ci` context; that the one suite the gate does not run
(`sentry-provider-contract.test.mjs`, imported by `tf-stacks.test.mjs`) really
is run by the unconditional `production-infra-contract` job; and that the local
quality gate's `sentry:*` allowlist stays pinned to exact commands. It parses
ci.yml rather than searching it, and compares the job by exact equality, so an
`if:`, a `continue-on-error:`, a `working-directory:`, an `env:`, a `|| true`, a
reordered step or a key nobody has thought of all fail it by name.

Issue #1779 PR C moved that checker out of the path-gated
`Lint + test root scripts` job, where a diff touching only the dashboard, the
indexer or a non-Markdown doc asset skipped it, and dropped the per-suite steps
that job used to duplicate. Reproduce the whole CI job with:

```bash
# The gate, which runs every scripts/sentry-*.test.mjs and asserts each one
# actually ran. The `env -u` prefix matches the CI step and is what lets it run
# under an ambient NODE_OPTIONS — without it the gate refuses to start by design:
/usr/bin/env -u NODE_OPTIONS -u NODE_PATH node scripts/sentry-suite-gate.mjs
node scripts/check-sentry-suites-in-ci.test.mjs
```

To run one suite on its own — the gate names the file it failed on — invoke it
by path, e.g. `node scripts/sentry-triage-ingest.test.mjs` or
`node --test scripts/sentry-mcp-broker.test.mjs`.

The `pnpm sentry:*:test` aliases still run these suites for interactive use and
in the local pre-push gate; the CI gate is the backstop, and the pin validator
keeps the aliases the local gate trusts safe.

```bash
# Read-only previews that require local credentials:
pnpm sentry:ingest --dry-run --lookback-days 8
SENTRY_TRIAGE_ISSUES='[123,456]' pnpm sentry:digest --channel '#engineering'
pnpm sentry:autofix:select --cap 2
pnpm sentry:brief --issue 1731 --dry-run
```

For any contract change, also run the matching workflow/script tests,
`pnpm docs:index --check`, and `pnpm agent:context-check`.
