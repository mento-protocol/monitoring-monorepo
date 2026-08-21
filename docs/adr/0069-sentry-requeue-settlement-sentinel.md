---
title: A withheld terminal label serializes the Sentry archive settlement against the triage re-queue
status: active
owner: eng
canonical: true
last_verified: 2026-08-21
scope: ci/process
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0069 — The archive's terminal marker is withheld from the re-queue's shed, and read back as a sentinel

**Status:** Accepted (Aug 2026), in force.
**Scope:** ci/process

## Context

Two writers can act on one Sentry triage queue stub at the same time, and
GitHub Actions gives them no lock.

- **The archive leg** (`.github/workflows/sentry-triage-archive.yml`,
  `scripts/sentry/triage/sentry-triage-archive.mjs`) is human-gated: a writer
  applies `sentry:approved-archive`, the run archives the underlying Sentry
  issue as `archived_until_escalating`, then settles the stub — body baseline,
  close, `sentry:archived` — and verifies that shape with a post-settlement
  read. Its concurrency group is **per issue**.
- **The triage compensation** (`scripts/sentry/triage/sentry-triage-workflow-requeue.mjs`)
  runs from `sentry-triage-agent.yml` whenever a step fails after the stub's
  `sentry:needs-triage` has been removed. It restores that label, sheds every
  marker from the previous round (`REOPEN_SHED_LABELS`) and reopens the stub.
  Its concurrency group is **repo-wide**.

The compensation already revalidated live state immediately before writing and
declined on a terminal stub (`isTerminalStub`: closed, or carrying
`sentry:archived`). That read is a snapshot, and its own docstring said so: an
archive landing after it still raced the writes.

The two runs covered one ordering between them and not the other.

- **Compensation writes land before the archive's verification read.** Caught.
  That read demands closed + `sentry:archived` + a `sentry:verdict-*` label, and
  the compensation has reopened the stub and shed the verdict, so
  `settlementHeld` fails, the archive rolls the queue stub back and the run goes
  red.
- **Compensation writes land after it.** Undetected. The archive has already
  returned success. The compensation then adds `sentry:needs-triage`, sheds
  `sentry:archived` and reopens — producing a selectable retry stub over an
  occurrence a human approved archiving, with nothing red anywhere.

A second check on the compensation's side could not see it either, and the
reason is specific: the shed removed `sentry:archived` with
`gh issue edit --remove-label`, which succeeds whether or not the label was
there. After that call no read can testify that the marker ever existed. Both
terminal signals were erased in the same operation — the reopen took the state,
the shed took the label — so post-hoc verification had nothing left to observe.

The load-bearing platform facts are narrow:

1. **GitHub's issue API offers exactly one atomic test-and-set:**
   `DELETE /repos/{repo}/issues/{n}/labels/{name}` returns 404 when the label is
   already gone. `POST .../labels` is not a lease — adding a label that is
   already present succeeds. Any serialization here must therefore be expressed
   as _consuming or observing a token that exists_, never as acquiring one that
   does not. The archive leg already relies on this for `sentry:approved-archive`
   (issue #1371).
2. **A shared Actions `concurrency:` group queues at most one pending run and
   cancels the one it supersedes.** Two pending runs in a group are not two
   queued runs.

Filed as finding 3 of issue #1929; the other seven landed in PR #1950, which
recorded this one as needing a design rather than a fix.

## Decision

**Withhold the settling writer's terminal marker from the re-queue's shed, and
read it back on the confirming end-state read. Its presence there means the
settlement landed inside the write window, so the re-queue unwinds instead of
reporting success.**

The chokepoint (`scripts/sentry/triage/sentry-triage-requeue.mjs`) takes the
marker as `revalidate.sentinel`. A caller that declares one gets three things:

1. **The marker is excluded from every blind shed** in that call —
   `buildRequeueShedLabelArgs(..., { except })`, and the post-verification shed
   retry with it. This is what makes the later read meaningful: a marker the run
   erases is a marker nothing can testify about.
2. **Every read taken after the last write is checked for it** — the confirming
   read from `ensureSelectableForTriage`, and the shed retry's re-read when that
   path runs. Checking earlier leaves the window between the check and the reopen
   open; checking only the first read leaves the retry uncovered, and that is not
   hypothetical — it is precisely a FAILED initial shed that leaves the verdict
   label standing, which is what lets the archive's own verification hold in the
   first place.
3. **On a hit, the re-queue unwinds** through
   `scripts/sentry/triage/sentry-triage-requeue-sentinel.mjs` and returns
   `{ requeued: false, reason: "settled-underneath" }`.

The unwind's order is the guarantee, because it can die half-way:
`sentry:needs-triage` is removed FIRST (selectability is the only property that
lets another run act on the stub, so every prefix must be unselectable), the
previous round's markers observed by the revalidating read are restored NEXT,
and the close goes LAST. Restoring the markers is load-bearing rather than tidy:
the archive's own post-settlement verification demands a verdict label, so a
stub left verdict-less would make that run roll a correct archive back.
`sentry:approved-archive` is never restored (`NEVER_RESTORED_LABELS`) — a spent
approval is authority, not a record, and re-adding it would both hand a later
`workflow_dispatch` an approval no human gave and re-fire the archive workflow's
`issues: labeled` trigger. The unwind's writes are provisional and one confirming
read decides. That read asks for the SETTLED shape the settling run itself
demands — closed, the terminal marker, and a `sentry:verdict-*` label — rather
than for the corrections having been attempted, because the weaker question lets
the unwind confirm a stub that run then rejects. An unwind that cannot reach that
shape throws, whether the verdict re-add failed or the premise never carried one:
the stub is then neither re-queued nor demonstrably settled, which only a human
can resolve.

**Why every ordering is now DETECTED.** Neither writer can destroy the other's
evidence any more. The archive's evidence about the compensation is the reopen
and the shed verdict, which its verification reads. The compensation's evidence
about the archive is `sentry:archived`, which it no longer erases. So: a marker
on the stub at any read this run takes after its last write is caught here; a
marker that lands after the last of them means the archive's own verification
runs later still, against a stub this run has already reopened and stripped of
its verdict, which fails it and rolls it back. There is no third ordering.

**What the sentinel proves, exactly.** That an archive run WROTE its terminal
marker — not that the run accepted its own settlement. Those come apart in one
sub-ordering: the archive marks and closes, the compensation reopens and sheds,
the archive's verification reads that broken shape and begins its rollback, and
the compensation's read still sees the marker and unwinds. Both then converge on
the archive's own documented post-rollback shape — open, verdicted, unqueued,
`sentry:archived` removed, Sentry left `archived_until_escalating` (ADR 0036) —
and the archive run is RED. Serializing that away would need either a marker the
archive publishes only after its verification, which would be one more racing
write and not a lock, or a way to stop an in-flight run's writes, which the
platform does not offer. See Consequences for what it costs.

**Accepted flap.** Between the reopen and the unwind the stub is briefly
selectable. Nothing can act on it there: the triage workflow holds one repo-wide
concurrency group and this compensation runs inside its own run, and ingest's
dedup skips an open stub.

## Alternatives considered

**A shared Actions concurrency group across the archive and triage workflows.**
The original suggestion on #1929, and rejected on the platform fact above. The
archive's group is per issue and human-gated; the triage agent's is repo-wide and
scheduled. Collapsing them means a human-approved archive dispatch and a
repo-wide triage run contend for one slot, and GitHub keeps a single pending run
per group: a second approved archive queued behind a triage run is CANCELLED, not
delayed. Silently dropping an approved archive is worse than the race it closes.
Keeping the archive per issue and giving the agent a per-issue group is not
available either — the agent run triages a batch, so it has no single issue to
key on. The same reasoning already rejected a shared group for the ingest/archive
pair (issue #1371).

**A per-issue lease or ordering token written into the stub.** The natural shape
— take a lock label, do the work, release it — is not implementable on this API.
`POST .../labels` succeeds whether or not the label is present, so two runs both
"acquire" the lease and both proceed. A lease in the issue body has the same
problem one level up (`gh issue edit --body` is last-write-wins, with no
compare-and-swap) and would put a second writer on the surface the archive leg
deliberately owns alone (#1769). The only atomic primitive is the DELETE, which
tests a token that already exists — which is what the sentinel uses.

**A re-verify-after-settle loop with bounded retries, on today's shed.**
Rejected as unimplementable rather than insufficient: after a blind shed there is
nothing left to re-verify. `sentry:archived` is gone and the state is open,
because the re-queue removed both. Retrying a read that cannot distinguish "never
archived" from "archived and shed by us" just costs API calls. Withholding the
marker is the minimum that makes any post-hoc check possible; once it is
withheld, one read suffices and a loop buys nothing.

**A second consume gate before the shed, in addition to the read-back.** It
would decline earlier in the common interleaving and avoid shedding the verdict
labels the unwind then restores. Rejected as redundant: it closes no ordering the
read-back does not, and it costs a second decision site for a mechanism whose
whole value is having one. The unwind restores from the revalidating read's
observation, so the end state is the same either way.

**Rolling Sentry back when the compensation wins.** Not considered seriously, and
recorded so it is not proposed later: ADR 0036 caps automation at
`archived_until_escalating` precisely because it self-heals on escalation, and
`reconcileToTarget` already documents why reverting it costs a check-then-PUT
race against Sentry's own transitions.

## Consequences

The compensating re-queue can now end in three ways rather than two:
re-queued, declined before writing (`revalidated-away`), or unwound after writing
(`settled-underneath`). Callers that branch on the decline reason must handle the
third; today only the tests do.

A caller declaring a sentinel MUST use the `verify-end-state` failure policy,
since that policy is what produces the confirming read. Declared with `abort` the
chokepoint throws before any I/O rather than degrading into the silence the
sentinel exists to end.

**The accepted cost, in the sub-ordering where the archive rolls back.** The
compensation declines, so it does not re-queue a stub that in the end was NOT
archived. The stub lands in the open-verdicted-unqueued shape, which ingest's
stranded sweep repairs after a day (#1817) rather than the compensation's usual
seconds, and both runs are red. That is a latency regression in one narrow
window, traded for removing the fail-open in the window this ADR exists for —
where the same code silently produced a selectable retry stub over an archived
occurrence and reported success. Slow-and-loud beats fast-and-wrong, and the slow
path is one the pipeline already runs for this exact shape.

The sentinel is opt-in per caller, and must stay that way. Ingest's regression
reopen and the archive's own live-regression refusal exist precisely TO shed
`sentry:archived` — a regression must reopen an archived stub — so a chokepoint-
wide rule would break both. The premise is what selects it: only a re-queue whose
revalidation declines on a terminal stub can treat that marker's later appearance
as proof of a race.

Two sibling callers hold the same premise and do NOT yet declare a sentinel:
`scripts/sentry/autofix/sentry-autofix-hold-revalidate.mjs`, whose revalidation
is the identical `!isTerminalStub(live)`, and ingest's stranded sweep, whose
window `docs/notes/sentry-triage-pipeline.md` documents. Both are tracked on
issue #1994; adopting the sentinel there is a one-option change plus its own
tests, not a redesign.

`scripts/sentry/triage/sentry-triage-requeue.mjs` reached 1,042 lines with the
unwind inline, past the 1,000-line hard cap the brief suite enforces for this
family. The unwind moved to `sentry-triage-requeue-sentinel.mjs` (192 lines) and
is listed in that cap test, so the split cannot silently rot.

The mechanism generalises only where a settling writer applies a durable terminal
LABEL before verifying. It says nothing about a settlement whose only trace is
the issue state: `gh issue close` is idempotent and reports nothing, so a
close-only settlement is still invisible to a re-queue that reopens.

## Evidence

- The uncovered ordering, reproduced: `scripts/sentry/triage/sentry-triage-requeue.test.mjs` lands the archive's settlement immediately after the compensation restores `sentry:needs-triage` — the point at which the archive's post-settlement verification has already passed. With the sentinel disabled the compensation returns `requeued: true` and leaves the stub open, `sentry:needs-triage` restored and `sentry:archived` shed (`expected false, got true`); with it, the re-queue unwinds and the stub ends closed, archived and unselectable.
- Withholding the marker is load-bearing, not cosmetic: restoring `except: []` on the shed while keeping the read-back reds four of the five new cases, because the shed erases the marker before anything reads it.
- Both halves of the completeness argument are pinned in one suite: the sentinel cases, and `settlementHeld` returning false for a stub the compensation has reopened or stripped of its verdict.
- The three verification gaps review passes found are pinned as their own cases: a settlement first visible to the shed retry's read still unwinds; an unwind whose marker restoration never lands is a hard failure; and an unwind that cannot leave a verdict on the stub fails rather than declining. Removing any one check reds exactly its case.
- The declaration is validated before any I/O — policy, label and `declineNote` — because a sentinel missing its note would throw at the DETECTION site, after the writes and before any correction, leaving the exact stub this prevents. The unwind's confirming read carries the same bounded retry the revalidating read has, so a transient 5xx does not raise a manual-repair alarm over a settled stub. Both are pinned, and removing either check reds its case.
- `node scripts/sentry/gate/sentry-suite-gate.mjs` — 14 suites asserted from their own output. No floor moved down; the re-queue suite emitted 41 cases before and 52 now, and its floor rose 40 → 52.
- Platform facts: `consumeApprovalLabel` in `scripts/sentry/triage/sentry-triage-archive.mjs` documents the DELETE/404 primitive (issue #1371); the single-pending-run behaviour of a shared concurrency group is recorded in `docs/notes/sentry-triage-pipeline.md` and in `sentry-triage-archive.yml`'s own `concurrency:` comment.
