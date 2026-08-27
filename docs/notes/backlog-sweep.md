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

Showing the batch is a real step, not a courtesy. The operator triggers a sweep
and names a batch size; the issues themselves come from a ranking they have not
read. Printing the selected numbers before the first claim is what makes the
trigger consent for these specific issues, and it is the last cheap moment to
stop a bad pick. The sweep prints and proceeds rather than waiting for an
answer — an operator starts a sweep in order to walk away, and blocking here
would strand the batch.

A claim can lose a race to another session between ranking and claiming, so
each claim result is read before its worker is briefed. Only a successful claim
gets a worker; a refused one moves to the next eligible receipt entry and is
recorded in the report, and an exhausted receipt finishes with a smaller batch.

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
unique path plus a line in the report. A checkout
whose contents have not been established is never deleted; it can hold
uncommitted work, and nothing available to the sweep tells that apart from
litter.

The split exists because subagents cannot wait. A subagent that ends its turn
to wait for a gate stalls permanently — nothing re-invokes it, and the
background process it was waiting on has no one left to observe it. The
orchestrator holds the wall clock so the workers never have to.

## Eligibility

A sweep is narrower than the ranking that feeds it. An issue enters a batch
only when all of the following hold:

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
- **Mutually independent** — no two issues in one batch touch the same
  subsystem. Otherwise the second PR pays for a merge, a re-gate, and a fresh
  review round caused only by its sibling.

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
clean session worktree, working `gh` auth, and the gate's machine lock.

The lock check is the one that is easy to skip and expensive to skip. Gate runs
are serialized machine-wide, and a sweep takes that lock once per issue and
again for every patch cycle. When another session has held
`<lock-root>/run.lock` for more than ten minutes **and its recorded pid is
still alive on this machine**, the sweep **reports the holding pid and worktree
and stops**. Liveness is part of the test: a crashed gate leaves its owner
record behind, and a sweep that read age alone would stop itself permanently on
a holder that no longer exists. A dead or foreign record is left untouched for
the gate to reclaim on its next run. The sweep does not wait the batch out
behind a live holder, and it never passes `--no-lock` or deletes the lock
directory: the gate owns those reclaim rules, and a lock that looks stale from
outside is routinely a live holder inside a long browser suite.

## Resilience duties

These belong to the orchestrator, and they are what makes an unattended run
survive the night:

- **Wake loop.** Watch each long process — gate, push — with a background
  `kill -0` watcher on its pid, and message the worker when it exits. Watch the
  process, not its log: a buffered or truncated log looks exactly like a
  running one.
- **Serialized instructions.** One checkout per worker, and no instruction ever
  names another worker's path.
- **Resume, never restart, after a usage-limit interruption.** The worker's
  clone still holds its branch, its claim, and often an open PR. A restart
  re-claims an issue already `agent-active`, re-runs a passed gate, and can
  open a second PR on the same branch.
- **Reclassify after five review-triggered patch cycles.** The operating card
  allows five and requires a pause before a sixth. At that point the worker
  stops patching and answers the rest as evidence-backed won't-fix or as
  deferrals with issues filed. A converging bot loop costs a review round per
  push and does not end on its own.

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
same day appends the lowest unused suffix. `.rankings/` is gitignored, so a
sweep report sits beside the ranking receipt it cites and travels no further
than the machine that produced it.

It carries the receipt path and requested batch size, a disposition table of
`Issue | PR | Disposition`, the claims this sweep lost to another session, the
deferral issues filed, and anything needing the operator's decision. A refused
claim gets its own line rather than a table row — no work was done on it — and
without that line a shrunken batch would look like the batch that was asked
for. The same summary is printed to the terminal.

Two properties make the table worth reading:

- **A shipped row quotes its final `pr:ready-state` line verbatim.** A
  paraphrase of a readiness verdict is not evidence of one, and the operator is
  about to decide a merge from this table.
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
report. That trigger is the trust gate: the operator sees the batch before it
starts and the PRs before they merge.

**Future work: cron-triggered autonomy.** A sweep that starts itself on a
schedule needs answers this note does not have — what wakes it, what stops a
run that is burning the usage window unattended, and who reads a report nobody
asked for. Nothing here depends on that step; the operator-triggered form is
complete on its own.
