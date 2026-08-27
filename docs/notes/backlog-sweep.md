---
title: Backlog Sweep
status: active
owner: eng
canonical: true
last_verified: 2026-08-27
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Backlog Sweep

A sweep ships a small batch of ranked backlog issues in one operator-started
session. The operator invokes it and leaves the session running; the session
ranks, picks, claims, and drives each pick through its own worker to a
ready-for-review PR, then reports.

This is stage 2 of the ranked-backlog loop in its **operator-triggered** form.
[`backlog-ranking.md`](backlog-ranking.md) owns stage 1 — the ranking, the
receipt, and the exclusion ledger — and a sweep never re-derives any of it. The
procedure is the `backlog-sweep` skill
([`.agents/skills/backlog-sweep/SKILL.md`](../../.agents/skills/backlog-sweep/SKILL.md));
this note owns the contracts it produces against. Queue labels, claiming, and
release stay canonical in [`agent-issue-workflow.md`](agent-issue-workflow.md);
every worker's PR loop is
[`pr-operating-card.md`](pr-operating-card.md) steps 2-7.

## The loop

Preflight. Rank. Pick the eligible top N. Show the batch. Claim each by number.
Hand each to a worker. Keep the workers awake. Write the report. Stop at READY.

Showing the batch is a real step, not a courtesy — but it is an audit line with
an abort window, not a consent step. The operator names a batch size; the
issues come from a ranking that has only just finished running, and a full
`rank-backlog` pass separates their keypress from the print, so they have most
likely walked away by the time the batch appears. Printing the selected numbers
before the first claim is what makes the run reviewable afterwards. The sweep
then holds about 60 seconds — a cheap abort for an operator still watching —
on a wait that ends by itself. It never blocks on an answer, which would strand
every batch started by an operator who is no longer there.

Claims are sequential, so eligibility is re-read against each issue immediately
before it is claimed rather than trusted from the ranking: `issue:claim` checks
only that the issue is open and queue-claimable, and `risk:low`, `Blocked`, a
new dependency, or an authority cap can all have changed in between. Each claim
also passes `--branch` with the worker's branch name — without it the helper
falls back to the orchestrator's own branch and files that in the Project
`Branch` field and the claim comment, pointing every reader at a checkout that
owns none of the work.

A claim can lose a race to another session between ranking and claiming, so
each claim result is read before its worker is briefed. Only a successful claim
gets a worker; a refused one is recorded in the report, and an exhausted receipt
finishes with a smaller batch. A claim the sweep then cannot staff — a spawn
that fails on a runtime's concurrency limit or any other error — is released
immediately rather than left parked in `agent-active` with no worker. A replacement drawn from the next eligible
receipt entry is printed before it is claimed, like the original batch — the
printed batch is the record of what the sweep worked on, and an unannounced
substitute makes that record wrong.

Stopping at READY is the design, and it is the same reason stage 1 stopped at
the recommendation. The operator gets finished PRs with their evidence and
decides what merges. A sweep that merged its own output would remove the only
place a human still reads the batch.

## Roles

**The orchestrator** is the session the operator invoked. It runs no quality
gate, edits no source file, and opens no PR. Its work is selection, claiming,
and keeping workers alive.

**A worker** is one subagent per issue, with one checkout, one branch, and one
PR. Workers never share a checkout: a repair applied through another worker's
clone lands on the wrong branch, and the worker that owns that branch has no
way to notice.

A worker's clone path is derived from its issue number, so it is deterministic
and can already exist — an interrupted run leaves one behind, and a released
issue can be selected again later. An existing directory is resumed only on
proof that it belongs to this sweep — a `.git/sweep-owner` file written
immediately after the clone and holding the sweep id, kept inside `.git/` so it
never shows up as untracked state a gate or a push can trip over. The
orchestrator fixes that id once, before the first claim, and gives it to every
worker; a clone whose marker was never written cannot be resumed, only
abandoned for a fresh path. Remote and branch are not that
proof: a second
sweep of the same issue reproduces both, so matching on them alone also accepts
a checkout another live worker is committing from. Anything else yields a fresh
path plus a line in the report, and that path is allocated with `mkdir` rather
than stamped with a timestamp — two workers displaced in the same second would
derive the same name, and the atomic claim is what sends the loser to the next
suffix. A checkout whose contents have not been established is never deleted;
it can hold uncommitted work, and nothing available to the sweep tells that
apart from litter.

Every new clone runs `./scripts/setup.sh`, unconditionally. That script sets
`core.hooksPath`, so a clone that only ran `pnpm install` has no pre-push hook
— and a worker there could push without the gate these boundaries forbid
bypassing.

The split exists because subagents cannot wait across turns. A subagent that
ends its turn to wait for a gate stalls permanently — nothing re-invokes it,
and the background process it was waiting on has no one left to observe it. So
a worker polls its own gate and push inside the turn that started them, and the
orchestrator exists for the residue: re-invoking a worker that went quiet
anyway, and collecting the facts only workers can see.

## Eligibility

A sweep is narrower than the ranking that feeds it. An issue enters a batch
only when all of the following hold:

The ranking receipt does not carry these facts: its Top 15 is
`Rank | Issue | Score | Reason`, and it scores `needs-grooming` issues beside
`agent-ready` ones. Selection by `rank-backlog` is a ranking verdict, not a
batch verdict. So each candidate is read directly —
`gh issue view <n> --json number,title,labels,body,projectItems`, where
`labels` settles the state, risk, and `pkg:*` area, `projectItems[].status.name`
settles `Blocked`, and `body` is where an external dependency is named. Only
the fit cap comes from the receipt.

- **`agent-ready`** — never `needs-grooming`. Ranking scores grooming issues
  and never Selects one; a sweep that claimed one would be grooming unattended
  on the operator's behalf.
- **`risk:low`** — the batch is implemented and pushed with no human reading
  the diff first. The risk label is this repo's own judgement about where that
  gap matters.
- **Fit not authority-capped** — ranking caps fit and names the cap when an
  issue needs a product decision, a credential the loop cannot reach, or an
  issue-specific human approval before the work is even ready to review. A
  capped issue cannot be finished unattended however well it scores, so it is
  ineligible here even at rank 1. The merge approval every PR needs is not such
  a cap; it applies to the whole batch equally and so distinguishes nothing.
- **Not blocked** — not projected to `Blocked` on the workboard, and not
  waiting on an external dependency named in its body.
- **Mutually independent** — no two issues in one batch share a `pkg:*` label.
  That label is the repo's existing ownership area
  ([`agent-issue-workflow.md`](agent-issue-workflow.md)), so "same subsystem" is
  a lookup rather than a per-batch judgement. Otherwise the second PR pays for
  a merge, a re-gate, and a fresh review round caused only by its sibling.

Fewer qualifying issues than the batch size is a normal result: take fewer and
say so. Zero is also a result — write the report with an empty table rather
than relaxing a rule to fill it.

## Batch size and cost

Default 2. Maximum 4, and a larger request is **refused**, not clamped: an
operator who asked for 6 needs to know what they got.

The limit is about the weekly usage window. One shipped PR costs roughly 3% of
it, and the dominant cost is not the first implementation — it is the review
rounds, one per push, each producing findings that cost replies and often
another push. A batch sized on implementation effort alone underestimates by
the number of rounds it will take.

## Preflight

The orchestrator verifies, before anything is claimed: `origin/main` fetched, a
clean session worktree, and working `gh` auth. It does **not** probe the gate's
lock.

That omission is deliberate. Gate `--run` requests share a transient
machine-wide coordinator that admits independent work from different worktrees
under a weighted capacity, and a new gate joins a compatible coordinator rather
than queueing behind it
([`agent-quality-gate-mechanics.md`](agent-quality-gate-mechanics.md)). The
coordinator adopts the legacy `run.lock` while scheduled or recovery work
exists, so `run.lock/owner` names a live pid for as long as anyone on the
machine is gating — hours at a time under ordinary parallel work. A sweep that
treated that record as a busy signal would refuse to start in the normal case.
Workers wait instead, with `--lock-wait 3600`, which spans scheduler admission,
a command lease, a coalesced result, and an older legacy holder. No sweep
passes `--no-lock` or deletes the lock directory: the gate owns its reclaim
rules, and a record that looks stale from outside is routinely a live holder
inside a long browser suite.

## Resilience duties

These belong to the orchestrator, and they are what makes an unattended run
survive the night:

- **Wake a quiet worker.** Workers poll their own gate and push in-turn, so the
  orchestrator carries no timers and never learns a worker's pids. Its duty is
  the residue: a worker parked at a turn end, or silent while its siblings
  advance, gets a message naming where it stopped and what comes next.
- **Collect the report-backs.** Five of the report's facts — the verbatim
  ready-state line, the release form and reason, the deferral issues, the
  operator-decision items, and any checkout conflict — exist only inside a
  worker's turn. The orchestrator records each closing message as it arrives
  and asks for what is missing before writing the report.
- **Gate concurrency within the coordinator's capacity.** Worker gates are
  scheduled by the gate coordinator and count against its capacity, 3 by
  default, so a batch of 4 runs at most three at once. Non-gate worker work
  stays outside the coordinator, which is safe on the `node_modules` axis
  because no two workers share a checkout, and bounded on CPU and memory only
  by the batch cap and that capacity.
- **Serialized instructions.** One checkout per worker, and no instruction ever
  names another worker's path.
- **Resume, never restart, after a usage-limit interruption.** The worker's
  clone still holds its branch, its claim, and often an open PR. A restart
  re-claims an issue already `agent-active`, re-runs a passed gate, and can
  open a second PR on the same branch.
- **Reclassify after five review-triggered patch cycles.** The operating card
  allows five and requires a pause before a sixth. The worker then stops
  patching and classifies what is left as an evidence-backed won't-fix, a
  deferral with its issue filed, or — when the finding is valid, in scope, and
  still required — a hand-off that goes in the report as an operator decision
  and is not reported as READY. A required fix is neither a won't-fix nor a
  deferral. A converging bot loop costs a review round per push and does not
  end on its own; neither does an unfixed defect.

## Boundaries

Four rules bind every sweep, and they are MUST-level because nobody is watching
while it runs:

- **Never merge.** The sweep ends at READY. `pnpm pr:merge` refuses outside an
  interactive human session, so a sweep cannot merge even by accident — the
  wrapper mechanizes the rule rather than replacing it, and the rule holds where
  the wrapper does not reach.
- **Never weaken or widen a control that blocks the run.** Root
  [`AGENTS.md`](../../AGENTS.md) states it, and the hand-off procedure and its
  one narrow exception are in the
  [operating card](pr-operating-card.md). A gate refusal, a failing hook, a
  denied permission, or a sandbox block is reported and handed to an independent
  session. Reclassifying the blocking change as a separate task does not
  qualify.
- **Never bypass hooks.** No `--no-verify`, no hook-skipping environment
  variable, no push that dodges the pre-push gate.
- **Release a bad pick honestly.** A misgroomed issue, or a worker that stalls
  with no path forward, runs `pnpm issue:release --issue <n>` —
  `--needs-grooming` when clarity is what is missing — and comments what it
  learned: what it tried, where it stopped, what a human must decide. A silent
  release sends the next run into the same wall. Deferred follow-ups get GitHub
  issues, linked from the PR's `## Deferrals` section; an evidence-backed
  won't-fix is not a deferral.

## The report

`.rankings/sweep-<YYYY-MM-DD>.md`, UTC, never overwritten; a second run the
same day appends the lowest unused suffix, reserving each candidate atomically
rather than checking and then writing — two sweeps finishing on one date can
otherwise both find the same name free. `.rankings/` is gitignored, so a
sweep report sits beside the ranking receipt it cites and travels no further
than the machine that produced it.

It carries the receipt path and requested batch size, a disposition table of
`Issue | PR | Disposition`, the claims this sweep lost to another session, the
deferral issues filed, the checkout conflicts, and anything needing the
operator's decision. A refused claim gets its own line rather than a table row
— no work was done on it — and without that line a shrunken batch would look
like the batch that was asked for. It names the holder by the `Claim ID` left
on the issue, because the refusal itself reports only the label state it found.
A checkout conflict line names the taken path and the fresh one: the taken path
is never inspected or deleted, so the line is the only record that something is
sitting there. The same summary is printed to the terminal.

Every one of those facts reaches the report through a worker's closing message.
The orchestrator writes the report and observes none of it directly, so a
worker that ends without reporting back leaves a hole nothing on disk fills.

Two properties make the table worth reading:

- **A shipped row quotes its final `pr:ready-state` line verbatim**, taken from
  `--compact`, the mode that emits one quotable line. A paraphrase of a
  readiness verdict is not evidence of one, and the operator is about to decide
  a merge from this table. The operating card's `--json` remains the
  machine-readable form and does not go in a cell.
- **A released row states the reason and which release form was used.** The two
  forms mean different things to the next run: the default returns the issue to
  the ready queue, `--needs-grooming` takes it out of reach until a human
  settles something.

The report ends with the exact merge commands for the READY PRs, one line each:

```bash
pnpm pr:merge --pr <number>
```

Listing them is not approval to run them. The operator runs them from their own
terminal, and the wrapper asks again there.

The sweep then announces the report through the fallback ladder in
[`spoken-attention-nudge.md`](spoken-attention-nudge.md), which owns the
command and its key-file rule. The nudge runs with escalated execution, not
inside the workspace sandbox: it needs the network and the local audio device,
and a sandboxed attempt fails in a way indistinguishable from a missing
command. The spoken text stays fixed and low-information — it goes to a
third-party service, and the detail belongs in the report. When every spoken
path fails, the report says so rather than leaving the operator to assume they
were told.

## Staging

**Delivered: operator-triggered sweeps.** A human starts each run and reads the
report. That trigger is the trust gate, and it rests on two things a sweep
cannot skip: the batch is printed with a short abort window before the first
claim, and every PR stops at READY for the operator to read before anything
merges.

**Future work: cron-triggered autonomy.** A sweep that starts itself on a
schedule needs answers this note does not have — what wakes it, what stops a
run that is burning the usage window unattended, and who reads a report nobody
asked for. Nothing here depends on that step; the operator-triggered form is
complete on its own.
