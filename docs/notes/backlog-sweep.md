---
title: Backlog Sweep
status: active
owner: eng
canonical: true
last_verified: 2026-09-02
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
this note owns the contracts it produces against, and
[ADR 0077](../adr/0077-operator-triggered-backlog-sweep.md) records why the
operating model is shaped this way. Queue labels, claiming, and
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

Claims are sequential. Immediately before each claim, the orchestrator repeats
the live issue read and checks the body for a new external dependency. It skips
the claim when that body-only blocker appears. Any replacement follows the
print-and-wait rule below. It computes `--body-sha256` from the body in that same
JSON snapshot. Each claim then uses `--sweep-eligible`, so the helper
revalidates the open queue state, risk label, package label, native blockers,
and the selected Project item's ID-bound `Blocked` status around its label and
ownership transition. It rejects every
missing, changed, or `Blocked` Status it observes. It never writes Status.
Project Status is human-owned, so a human change after the final observation
remains visible and linearizes after the claim. The receipt still owns the fit
cap. The helper does not classify free-form body text. It verifies the expected
body digest during locked pre-transition and post-transition reads. Each claim
passes a stable `--claim-id` and required `--branch` with the branch the worker
will push. The worker is briefed with that exact name. The helper rejects a
sweep claim before it takes the mutex when the branch or body digest is absent.
A direct GitHub body edit does not acquire the mutex. An edit after the final
check remains visible because the helper never writes the body.

The persistent per-issue mutex serializes claim, review, release, sync, and
backfill helper calls. All repo-owned writes to Claim ID, Agent, Branch, Claimed
At, and PR use this mutex. Direct external writes stay outside it. Project V2
cannot make a field write conditional. A direct external same-field write in the
read-write gap can be overwritten without detection. Stop all helpers before a
manual owner-field repair. The helper re-reads external state and compensates a
failed change when it can prove a safe endpoint. It can leave a stale `LOCK` for
operator recovery when the result is uncertain. Every helper preserves the
human-owned Project Status. The operator must first prove that the original
helper cannot resume. See
[`agent-issue-workflow.md`](agent-issue-workflow.md#workboard-commands).

A claim can lose a race to another session between ranking and claiming, so
each claim result is read before its worker is briefed. Only a successful claim
gets a worker; a refused one is recorded in the report, and an exhausted receipt
finishes with a smaller batch. A claim the sweep then cannot staff — a spawn
that fails on a runtime's concurrency limit or any other error — is released
immediately rather than left parked in `agent-active` with no worker. An
ordinary claim command that exits nonzero is retried once with the same Claim
ID. The helper uses that token to recover its own valid partial claim and keeps
any partial failure out of `agent-ready`. An exact active Project Claim ID can
be retried with the same token and exact non-empty ownership values. The helper
writes only ownership fields that its latest snapshot reports as missing. A
Branch move requires the explicit review rebind. An exact `needs-grooming`
quarantine with a durable Branch can be cleared with
`issue:release --needs-grooming`. When recovery observes empty, foreign, or
branchless Project ownership, it does not overwrite those fields. The owned
mutex instead moves a still-ready failed item to `needs-grooming`; report that
quarantine for operator inspection. A newer non-ready label state is preserved.

Retry once only for an ordinary nonzero claim result. Reuse the same Claim ID
and Branch. When comments are enabled, the retry verifies or creates the
matching trusted claim comment before it reports success. Never retry a result
that reports `ISSUE_MUTATION_LOCK_STALE`, an
unknown mutex outcome, a stale `LOCK`, or a candidate `LOCK` or `UNLOCK`. The
operator must first prove that the original helper cannot resume. The operator
must then read the current ref and board state and complete the ADR 0082
recovery. After a body-only pre-claim skip or a refused claim, a replacement
drawn from the next eligible receipt entry is printed before it is claimed and
gets the same abort window as the original batch. The printed batch is the
record of what the sweep worked on, and an unannounced substitute makes that
record wrong.

Stopping at READY is the design, and it is the same reason stage 1 stopped at
the recommendation. The operator gets finished PRs with their evidence and
decides what merges. A sweep that merged its own output would remove the only
place a human still reads the batch.

## Roles

**The orchestrator** is the session the operator invoked. It runs no author
check, edits no source file, and opens no PR — prohibitions that keep concurrent
workers out of each other's trees, and so bind only while separate workers
exist. A runtime that cannot spawn one works the batch sequentially, taking both
roles, one issue at a time. Merging is not one of those prohibitions: that
boundary is unconditional, in every shape of the run. Its work is selection,
claiming, and keeping workers alive.

**A worker** is one subagent per issue, with one checkout, one branch, and one
PR. Workers never share a checkout: a repair applied through another worker's
clone lands on the wrong branch, and the worker that owns that branch has no
way to notice.

Every worker command runs from inside its own clone. `git clone` does not move
the shell and a worker can inherit the orchestrator's directory, so a brief
that only says which path to clone into would let setup, the branch, the edits,
and the author checks run in the orchestrator's checkout — the tree the whole
scheme exists to keep workers out of.

A worker's clone path is derived from its issue number, so it is deterministic
and can already exist — an interrupted run leaves one behind, and a released
issue can be selected again later. An existing directory is resumed only on
proof that it belongs to this sweep — a `.git/sweep-owner` file written
immediately after the clone and holding the sweep id, kept inside `.git/` so it
never shows up as untracked state that blocks validation or shipping. The
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

Every checkout runs `./scripts/setup.sh`. Before resuming one, inspect
`git status --short`, committed, staged, unstaged, and untracked changes. Review
lifecycle and install effects for any manifest, lockfile, pnpm configuration,
or patch change before setup. Stop if the change set is unclear. Before fresh
setup, fetch and run `git switch --detach origin/main`. Setup prepares the staged
formatter, dependencies, codegen, and browser tools; markers skip unchanged work.

The split exists because subagents cannot wait across turns. A subagent that
ends its turn while an author check is running stalls permanently. Nothing
re-invokes it, and the background process has no one left to record its result.
A worker polls its author checks and push inside the turn that started them.
The orchestrator re-invokes a worker that went quiet and collects the facts
only workers can see.

## Eligibility

A sweep is narrower than the ranking that feeds it, and the ranking receipt
does not carry the difference: its Top 15 is `Rank | Issue | Score | Reason`,
and it scores `needs-grooming` issues beside `agent-ready` ones. Selection by
`rank-backlog` is a ranking verdict, not a batch verdict. Candidates are read in
receipt order — Selected, runner-up, then the Top 15, since ranking reads that
pair "whatever their rank" and grooming issues can push them off the table. Each
is read directly — `gh issue view <n> --repo mento-protocol/monitoring-monorepo
--json number,title,state,labels,body,projectItems,blockedBy`, where `labels`
settles the queue state, risk, and `pkg:*` area, `projectItems[].status.name`
settles `Blocked`, `blockedBy` carries GitHub's own blocked-by relationship,
and `body` is where an external dependency is named. Only the fit cap
comes from the receipt. `state` must read `OPEN`, since a closed issue passes
every rule below and is refused only later by `issue:claim`; `--repo` is
explicit because an unqualified read resolves against the current checkout's
remote or `GH_REPO` and could grade a same-numbered issue elsewhere.

The ranking skill's `Stop There` section ends a standalone ranking at the
recommendation, where nothing is authorized to claim. It does not halt a sweep:
the operator authorized this batch by starting the sweep, the sweep owns the
claiming, and ranking hands its receipt back rather than ending the run.

An issue enters a batch only when all of the following hold:

- **`agent-ready`** — never `needs-grooming`. Ranking scores grooming issues
  and never Selects one; a sweep that claimed one would be grooming unattended
  on the operator's behalf.
- **Exactly one `risk:*` label, and it is `risk:low`** — the batch is
  implemented and pushed with no human reading the diff first, and the risk
  label is this repo's own judgement about where that gap matters. Only state
  labels are mutually exclusive, so an issue can carry `risk:low` beside
  `risk:high`; testing the set rather than the presence of `risk:low` is what
  keeps that issue out.
- **Fit not authority-capped** — ranking caps fit and names the cap when an
  issue needs a product decision, a credential the loop cannot reach, or an
  issue-specific human approval before the work is even ready to review. A
  capped issue cannot be finished unattended however well it scores, so it is
  ineligible here even at rank 1. The merge approval every PR needs is not such
  a cap; it applies to the whole batch equally and so distinguishes nothing.
- **Not blocked by any of three records** — not projected to `Blocked` on the
  workboard, no non-empty `blockedBy` relationship, and not waiting on an
  external dependency named in its body. None of the three implies another.
- **Carries exactly one `pkg:*` label** — no package area makes the independence
  test vacuous, while several areas make ownership ambiguous. The
  `--sweep-eligible` claim path enforces the same rule.
- **Mutually independent** — no two issues in one batch share a `pkg:*` label.
  That label is the repo's existing ownership area
  ([`agent-issue-workflow.md`](agent-issue-workflow.md)), so "same subsystem" is
  a lookup rather than a per-batch judgement. Otherwise the second PR pays for
  a merge, repeated author checks, and a fresh review round caused only by its
  sibling.

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
clean session worktree, working `gh` auth, and that
`git remote get-url --push origin` serves `mento-protocol/monitoring-monorepo`.
It does not probe or change the legacy gate's lock.

A fork checkout is a stop. The operating card refuses every fork head and tells
a fork to stop rather than first-publish, and workers inherit this checkout's
remote — so a sweep started from a fork would claim, implement, and validate a
whole batch that can never open a PR. That is the preflight's whole purpose:
each check here costs one command, and skipping one fails late, with issues
already claimed and a worker mid-validation.

Workers apply the direct author checks from operating-card step 3 in isolated
checkouts. The batch cap remains the CPU and memory bound. Run no more than
three ordinary command-heavy check sets at once. Run dashboard coverage or
scoped related tests, browser work, production builds, and size-limit work
alone. Other workers can keep editing. A browser check that finds its fixed
port in use fails and reports the conflict. It never waits for, stops, or
reuses another process.

## Resilience duties

These belong to the orchestrator, and they are what makes an unattended run
survive the night:

- **Wake a quiet worker.** Workers poll their own author checks and push in-turn, so the
  orchestrator carries no timers and never learns a worker's pids. Its duty is
  the residue: a worker parked at a turn end, or silent while its siblings
  advance, gets a message naming where it stopped and what comes next.
- **Collect the report-backs.** Five of the report's facts — the verbatim
  ready-state line, the release form and reason, the deferral issues, the
  operator-decision items, and any checkout conflict — exist only inside a
  worker's turn. The orchestrator records each closing message as it arrives
  and asks for what is missing before writing the report.
- **Author-check concurrency stays bounded.** A batch of four runs at most
  three ordinary command-heavy check sets at once. Dashboard coverage or scoped
  related tests, browser work, production builds, and size-limit work run alone.
  Other workers can keep editing. Each worker owns its checkout, so no
  package-manager process can recreate or invalidate another's `node_modules`.
- **Serialized instructions.** One checkout per worker, and no instruction ever
  names another worker's path.
- **Resume, never restart, after a usage-limit interruption.** The worker's
  clone still holds its branch, its claim, and often an open PR. A restart
  re-claims an issue already `agent-active`, repeats completed author checks, and can
  open a second PR on the same branch. The orchestrator also records each
  worker's allocated clone path and hands it back on any respawn: a worker
  displaced to a suffixed path cannot recognise its own checkout from the
  deterministic base name alone, and would otherwise clone fresh and abandon
  its branch and open PR.
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

- **Never merge.** The sweep ends at READY and reports the PR links. A human can
  open those links and merge in the GitHub UI.
- **Never weaken or widen a control that blocks the run.** Root
  [`AGENTS.md`](../../AGENTS.md) states it, and the hand-off procedure and its
  one narrow exception are in the
  [operating card](pr-operating-card.md). A required author-check or CI failure,
  a failing hook, a denied permission, or a sandbox block is reported and
  handed to an independent session. Reclassifying the blocking change as a
  separate task does not qualify.
- **Never bypass retained hooks.** No `--no-verify` or hook-skipping environment
  variable.
- **Release a bad pick honestly.** A misgroomed issue, or a worker that stalls
  before opening a PR, runs
  `pnpm issue:release --issue <n> --claim-id <claim-id>` — add
  `--needs-grooming` when clarity is missing — and comments what it learned:
  what it tried, where it stopped, and what a human must decide. The helper
  accepts only the matching owner token on `agent-active`. It refuses `in-pr`
  and repeats the claimed-branch PR proof before and after each write and after
  its final state reads. A PR found before the final proof normally restores
  the prior active state and exact ownership snapshot. If a `--needs-grooming`
  release already reached the exact grooming state with empty ownership,
  recovery preserves that completed non-ready endpoint and exits nonzero. A PR
  can still open after the final proof because GitHub exposes separate APIs. A
  silent release sends the next run into the same
  wall. A stall with an open PR keeps `in-pr` and hands the PR to the operator.
  After the operator closes it unmerged, run
  `pnpm issue:release --issue <n> --claim-id <claim-id> --closed-unmerged-pr`.
  This path proves the stored closed PR, repository, and branch and refuses an
  open replacement PR. If the operator instead merges a partial-stage PR and
  the issue remains open, update the remaining scope and run
  `pnpm issue:release --issue <n> --claim-id <claim-id> --merged-pr --needs-grooming`.
  This separate post-sweep path proves the stored merged PR and never restores
  `agent-ready`. Deferred follow-ups get GitHub issues,
  linked from the PR's `## Deferrals` section; an evidence-backed won't-fix is
  not a deferral.

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
like the batch that was asked for. It names the holder's `Claim ID` when the re-read
shows one, and otherwise records a state change between the read and the claim —
a closed or re-groomed issue has no holder, and an old comment would name a
session unrelated to the refusal.
A checkout conflict line names the taken path and the fresh one: the taken path
is never inspected or deleted, so the line is the only record that something is
sitting there. The same summary is printed to the terminal.

Every fact is recorded by whoever performed the action: the orchestrator for the
receipt, the refused claims, and anything it did itself — releasing a claim it
could not staff, for one; a worker's closing message for everything inside its
own turn, which the orchestrator does not observe directly. A worker that ends without reporting back, and
without answering the request for one, still gets its row: written from the
issue, branch, and any PR the orchestrator can see, marked as not reported, and
listed under the operator's decisions. A missing row would read as an issue
that was never claimed while its claim is still on the board.

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

The report ends with one URL for each READY PR. A human can open each link and
merge in the GitHub UI. Listing a link is not merge approval. The sweep never
merges.

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
