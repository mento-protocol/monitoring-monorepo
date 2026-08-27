---
name: backlog-sweep
description: "[repo-skill] Ship a small batch of ranked monitoring-monorepo backlog issues in one operator-started session: rank, pick the eligible top N, claim each by number, and drive each through its own worker subagent to a ready-for-review PR. Use when asked to sweep the backlog, work the top issues, or run a batch overnight. It never merges: it stops at READY and hands the operator the merge commands."
title: Backlog Sweep Skill
status: active
owner: eng
canonical: true
last_verified: 2026-08-27
doc_type: skill
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# Backlog Sweep

Take the top of the ranked backlog and ship it. The operator starts this in a
session they leave running — `/backlog-sweep`, or `/backlog-sweep 3` for a
larger batch — and reads the report afterwards. Default batch size is 2.

The session that runs this skill is an **orchestrator**. It ranks, picks,
claims, and hands each issue to a dedicated worker subagent. It runs no gate,
edits no source file, and merges nothing.

The loop, the boundaries, the report contract, and the resilience duties are
canonical in
[`backlog-sweep.md`](../../../docs/notes/backlog-sweep.md). Ranking is the
`rank-backlog` skill and its contracts in
[`backlog-ranking.md`](../../../docs/notes/backlog-ranking.md). Queue labels,
claiming, and release stay canonical in
[`agent-issue-workflow.md`](../../../docs/notes/agent-issue-workflow.md). Every
worker works
[`pr-operating-card.md`](../../../docs/notes/pr-operating-card.md) steps 2-7.

## Preflight

Every check here fails cheaply. Skipping one fails late, after issues are
already claimed and a worker is mid-gate.

```bash
git fetch origin main
git status --porcelain    # must print nothing
gh auth status            # must report an authenticated account
```

A dirty session worktree is a stop, not a warning. The orchestrator does not
commit, so nothing it does would clear those changes, and a sweep that runs
beside unfinished work makes the two indistinguishable in the report.

**Do not probe the gate's lock, and never stop on it.** Gate `--run` requests
share a transient machine-wide coordinator that admits independent work from
different worktrees under a weighted capacity, so a new gate **joins** a
compatible coordinator rather than queueing behind it
([`agent-quality-gate-mechanics.md`](../../../docs/notes/agent-quality-gate-mechanics.md)).
The coordinator adopts the legacy `run.lock` while scheduled or recovery work
exists, which makes `run.lock/owner` name a live pid for as long as anyone on
the machine is gating — hours, routinely, during ordinary parallel work. A
sweep that read that record as a busy signal would refuse to start in the
normal case. Workers wait with `--lock-wait 3600`, which covers scheduler
admission, a command lease, a coalesced result, and an older legacy holder.
Never pass `--no-lock` and never delete the lock directory: the gate owns its
own reclaim rules, and a record that looks stale from outside is routinely a
live holder inside a long browser suite.

**State the usage reality before starting.** One shipped PR costs roughly 3% of
the weekly usage window, and every push to it triggers another round of bot
reviews whose findings then cost replies and often another push. Two issues is
the default because the cost is dominated by review rounds, not by the first
implementation. **Refuse a batch size above 4.** Say that plainly and stop
rather than clamping silently — an operator who asked for 6 needs to know they
got a refusal, not a quiet 4.

## Rank And Pick The Batch

Run the `rank-backlog` skill end to end and let it write its normal receipt.
Do not shortcut it to a quick issue list: the receipt is the audit trail this
sweep's report cites, and a batch picked without one cannot be reviewed after
the fact.

**The receipt does not carry eligibility.** Its Top 15 table is
`Rank | Issue | Score | Reason`, and it ranks `needs-grooming` issues beside
`agent-ready` ones. Being Selected by `rank-backlog` is a ranking verdict, not
a batch verdict — the Selected issue can fail any rule below. So walk the Top
15 in order and read each candidate directly, stopping once N qualify:

```bash
gh issue view <n> --json number,title,labels,body,projectItems
```

`labels` settles `agent-ready`, `risk:low`, and the `pkg:*` area;
`projectItems[].status.name` settles `Blocked`; `body` is where an external
dependency is named. Only the fit cap comes from the receipt.

Take the top N — default 2 — that satisfy **all** of:

- **`agent-ready`.** Never `needs-grooming`. `rank-backlog` ranks grooming
  issues and never Selects one; a sweep that claimed one would be doing the
  grooming itself, unattended, on the operator's behalf.
- **`risk:low`.** The batch runs without a human reading the diff before it is
  pushed. `risk:medium` and `risk:high` issues are exactly the ones where that
  gap matters, and the label is the repo's own judgement of which those are.
- **Fit not authority-capped.** `rank-backlog` caps fit and names the cap when
  an issue needs a product decision, a credential the loop cannot reach, or an
  issue-specific human approval ahead of normal PR readiness. A capped issue
  cannot be finished by an unattended worker however well it scores, so it is
  ineligible here even at rank 1. The merge approval every PR needs is not such
  a cap — it applies to the whole batch equally.
- **Not blocked.** Not projected to `Blocked` on the workboard, and not waiting
  on an external dependency named in its body.
- **Mutually independent.** No two issues in one batch share a `pkg:*` label —
  `pkg:dashboard`, `pkg:indexer`, `pkg:alerts`, `pkg:terraform`, `pkg:tooling`,
  listed in
  [`agent-issue-workflow.md`](../../../docs/notes/agent-issue-workflow.md).
  That label is the repo's own ownership area, so it settles "same subsystem"
  by lookup rather than per-batch judgement. Two workers editing one package
  produce PRs whose diffs conflict and whose reviewers see a base moving under
  them, and the second PR then pays for a merge, a re-gate, and a fresh review
  round it did not need.

If fewer than N issues qualify, take fewer and say so in the report. Never
relax a rule to fill the batch. Zero qualifying issues is a valid result: write
the report with an empty disposition table, name what the receipt held, and
stop.

## Hand Each Issue To A Worker

**Print the batch, dwell 60 seconds, then claim.** List every selected issue by
number and title, with the receipt position that put it there, and say plainly
that the sweep is about to claim them and open a PR for each. Then hold about
60 seconds before the first claim — any bounded wait the runtime supports —
and proceed the moment it elapses. The wait must end on its own; never ask a
question and block on the answer.

This is a reviewable audit line with an abort window, not consent. The operator
chose a batch size, not a set of issues, and a full `rank-backlog` run stands
between their keypress and this print — so by the time the batch appears they
have most likely already walked away, which is the point of starting a sweep.
The printed batch is what makes the run auditable afterwards; the dwell is a
cheap abort for an operator who is still watching. Blocking on a reply would
strand every batch started by one who is not.

Work the batch **sequentially**: claim one issue, brief its worker, then move
to the next. Claiming ahead of the briefing would park the whole batch in
`agent-active` while only one worker exists to move it.

**Claim the specific number, never a count:**

```bash
pnpm issue:claim --issue <n> --agent <name>
```

`--count` claims whatever the ready queue holds at that moment, which is not
the set the receipt selected — a race with any other session silently swaps an
issue in, and the report would then cite a receipt that never chose it.

`<name>` is the runtime actually running the sweep — `claude` or `codex`. This
skill is mirrored to both stores, so a hard-coded name would file every Codex
sweep's claim under the wrong owner, and the claim comment and Project `Agent`
field are what a human reads to find the session holding an issue.

**Read the claim result before briefing anyone.** The claim can lose a race —
another session can take the issue between the ranking that selected it and
this command. Spawn the worker only for a claim that succeeded. A worker briefed
on an issue this sweep does not hold duplicates whatever its real owner is
already doing.

On a refused claim, leave the issue alone and record the loss in the report.
The refusal names only the label state it found —
`is not claimable; expected open agent-ready without agent-active/in-pr/needs-grooming`
— so read the holder's `Claim ID` from the issue's project field or its claim
comment for the report line. A replacement from the next eligible receipt entry
is allowed, but **print it before claiming it**, exactly as the batch was
printed: the printed batch is the audit record of what this sweep worked on,
and an unannounced substitute makes that record wrong. When the receipt is
exhausted, finish with the smaller batch.

Then spawn one worker subagent per issue. Give each a brief containing:

- **Its own checkout.** Clone to `/private/tmp/claude/sweep-<issue>`, with
  `issue` holding the number:

  ```bash
  root=/private/tmp/claude          # or "$TMPDIR" where that root is unwritable
  mkdir -p "$root"
  dir="$root/sweep-${issue}"

  if [ -e "$dir/.git/sweep-owner" ] &&
     [ "$(cat "$dir/.git/sweep-owner")" = "$sweep_id" ]; then
    :                               # this sweep's own checkout: resume in it
  elif [ -e "$dir" ]; then
    dir="$dir-$(date +%s)"          # someone else's or unproven: fresh path
    git clone https://github.com/mento-protocol/monitoring-monorepo "$dir"
    printf '%s\n' "$sweep_id" > "$dir/.git/sweep-owner"
  else
    git clone https://github.com/mento-protocol/monitoring-monorepo "$dir"
    printf '%s\n' "$sweep_id" > "$dir/.git/sweep-owner"
  fi
  ```

  `sweep_id` is one value the orchestrator fixes before the first claim and
  passes to every worker — this session's id is the obvious choice, and any
  string is fine as long as one sweep never reuses another's. Write it right
  after the clone: the marker is what the next run reads, so a clone that
  skipped this step can never be resumed, only abandoned for a fresh path.

  Create the parent first. `git clone` does not create intermediate
  directories, and the sweep root is not guaranteed on a fresh machine or in
  the Codex runtime this skill is also mirrored into — so a missing parent
  fails the very first command of every worker.

  In Claude Code, subagents inherit the parent session's Bash worktree pin, so
  git in a sibling worktree under `.claude/worktrees/` is refused for them, and
  a tmp clone is the only checkout those workers can use. The general rule
  outlives that specific block: every worker gets an isolated checkout — a
  clone or a worktree — that its own runtime can actually write to, because two
  workers in one checkout is the failure this is preventing. Then
  `pnpm install --frozen-lockfile` unsandboxed, and `./scripts/setup.sh` when
  hooks require it. Branch from `origin/main`.

  **The path is deterministic, so check it before cloning.** The same issue
  number produces the same directory, and `git clone` fails outright into one
  that already exists — from an interrupted run, or from an earlier sweep of an
  issue that was released and later re-selected. Resume it only on proof it is
  this sweep's own, which is what the `sweep-owner` comparison above decides.
  Keep the marker inside `.git/` — a file at the clone root would be untracked
  in every worker checkout, where a clean-worktree check can refuse the gate or
  the push and broad staging can commit the marker into the PR. Remote and
  branch are not proof — a second sweep of the same issue reproduces both, so
  that test also accepts a checkout a live worker is committing from, and two
  workers would then push from one tree. Anything else gets a
  fresh unique path, and the conflict is named in the report. **Never delete a
  checkout whose contents you have not established** — it may hold another
  session's uncommitted work, and nothing here can tell that apart from litter.

- **The loop:** [`pr-operating-card.md`](../../../docs/notes/pr-operating-card.md)
  steps 2-7, end to end. Implement surgically — touch only what the issue
  needs, and read the scoped `AGENTS.md` for the package first.
- **Formatting before the commit:** `./tools/trunk fmt <changed files>`. The
  gate does not run it, and the required Code Quality check does.
- **The gate**, unsandboxed, backgrounded, and polled inside the turn:

  ```bash
  bash scripts/agent-quality-gate.sh --run --lock-wait 3600
  ```

  Invoke the script directly. The `pnpm agent:quality-gate -- --run` spelling
  mangles the arguments on the way through the package manager. Every worker
  gate goes through the machine's gate coordinator and counts against its
  capacity — 3 by default, `AGENT_QUALITY_GATE_CAPACITY`. Gates from different
  worktrees run together under that capacity; the hour-long `--lock-wait` is
  what covers the rest, since it spans scheduler admission, a command lease, a
  coalesced result, and an older legacy holder.

  **Poll within the turn.** A worker that ends its turn to wait for the gate
  never wakes: subagents die at turn end, and a backgrounded process they were
  waiting on has no one left to notice it finished. Loop on the process inside
  the same turn until it exits.

- **The closeout:** bare `pnpm agent:autoreview`. When the codex engine is
  unavailable, fall back to `pnpm agent:autoreview --engine claude`, with the
  `claude` CLI's install directory prepended to `PATH` — a worker subagent does
  not always inherit the interactive shell's `PATH`, and the fallback engine
  then reports as unavailable too. Address the real findings; an unexplained
  strengthening of a validation claim is itself a finding.
- **The ship:** full repo PR template, all four sections, **ready for review,
  never a draft**. A draft disables CodeRabbit auto-review and the PR
  description check, so it is skipping review rather than staging it. Then
  `pnpm issue:review --pr <pr> --issue <n>`.
- **The babysit:** sweep every feedback surface — top-level comments, review
  bodies, inline threads, annotations, failing logs. **Batch fixes into single
  pushes**, because every push costs another bot review round. Reply before
  resolving, in the two canonical forms: `Fixed in <commit> — <what changed>`
  and `Won't fix: <technical reason why>`. Drive to READY on both projections,
  `pr:feedback-state` clean first, then `pr:ready-state`.
- **The report-back.** End the last turn — at READY, at a release, or at a
  block — with one message to the orchestrator carrying every fact the report
  needs and only the worker can see: the PR URL; the final
  `pnpm pr:ready-state --pr <pr> --compact` line **verbatim**; the release form
  and reason if the issue was released; each deferral issue filed with the PR
  it came from; anything needing an operator decision; and the two paths if the
  deterministic clone path was taken and a fresh one was used. The orchestrator
  observes none of this from outside, so a fact left out of this message is a
  fact missing from the report.

## Keep The Workers Awake

These duties belong to the orchestrator. They are the reason this skill has an
orchestrator at all.

**Re-invoke a worker that has gone quiet.** Each worker polls its own gate and
push inside its turn, so the orchestrator holds no timers and watches no pids —
it never learns their pids in the first place. What it owns is the case
in-turn polling cannot reach: a worker whose task notification shows it parked
at a turn end, or whose last report has gone stale while its siblings advance.
Send that worker a message naming where it stopped and what to do next. Nothing
else re-invokes a subagent that has already ended its turn.

**Collect each worker's report-back.** The report is the orchestrator's to
write, but five of its facts exist only inside a worker's turn — the verbatim
ready-state line, the release form and reason, the deferral issues, the
operator-decision items, and any checkout conflict. Record each closing message
as it arrives. A worker that finished without one is not done: ask it for the
missing facts before writing the report, because nothing on disk reconstructs
them afterwards.

**Keep concurrent gates within the coordinator's capacity.** The coordinator
schedules gate work across worktrees under a weighted capacity, 3 by default,
so a batch of 4 runs at most three gates at once — hold the fourth worker at
its gate step until one finishes rather than letting all four queue. The
non-gate part of a worker's turn stays outside the coordinator, and that is
sound on the axis the operating card warns about: each worker owns its own tmp
clone, so no package-manager process can recreate or invalidate another's
`node_modules`. It is not free on CPU and memory, which is why the batch cap
and the coordinator's capacity both stay small. The card's read-only rule for
spare same-machine workers governs _uncoordinated_ validation; every validation
a worker runs here goes through the coordinator instead.

**Serialize the instructions so two workers never share a checkout.** Each
worker owns exactly one clone and one branch, and no instruction ever names
another worker's path. A repair applied through the wrong checkout lands on the
wrong branch, and the worker that owns it will not notice.

**Resume workers after a usage-limit interruption; never restart them.** The
worker's clone still holds its branch, its claim, and often an open PR. A
restart re-claims an issue that is already `agent-active`, re-runs a gate that
already passed, and can open a second PR for the same branch. Wait for the
limit to reset, then wake the existing worker where it stopped.

**Direct a reclassification after five review-triggered patch cycles.** The
operating card allows five and requires a pause before a sixth. At that point
tell the worker to stop patching: answer the remaining findings as
evidence-backed won't-fix, or file deferral issues and link them from
`## Deferrals`. A converging bot loop costs a review round per push and does
not end on its own.

## Hard Boundaries

These are MUST-level. A sweep runs unattended, so a boundary crossed here is
crossed without anyone watching.

- **MUST NOT merge.** Green CI, a READY ready-state, and a batch that finished
  early are not merge approval. `pnpm pr:merge` refuses outside an interactive
  human session, so the sweep cannot merge even by accident — but the rule binds
  regardless of the wrapper, which mechanizes it rather than replacing it. The
  sweep ends at READY and hands the operator the commands.
- **MUST NOT weaken or widen a control that blocks the run.** Root
  [`AGENTS.md`](../../../AGENTS.md) states it: never weaken a control that
  blocks your own work, because an agent that can widen its own gate has no
  gate. A gate refusal, a failing hook, a denied permission, or a sandbox block
  is reported and handed to an independent session — never edited away by the
  worker it is blocking. Reclassifying the blocking change as a separate task
  does not qualify.
- **MUST NOT bypass hooks.** No `--no-verify`, no hook-skipping environment
  variable, no direct push that dodges the pre-push gate.
- **MUST release a bad pick honestly.** An issue that turns out misgroomed, or
  a worker that stalls with no path forward, releases the issue rather than
  leaving it parked in `agent-active`:

  ```bash
  pnpm issue:release --issue <n>                    # remaining work still clear
  pnpm issue:release --issue <n> --needs-grooming   # clarity is missing
  ```

  Post a comment on the issue saying what the worker learned — what it tried,
  where it stopped, and what a human would need to decide. A silent release
  sends the next run straight back into the same wall.

- **MUST file an issue before deferring.** Every knowingly deferred follow-up
  gets a GitHub issue, linked from the PR's `## Deferrals` section. An
  evidence-backed won't-fix is not a deferral and needs no issue.

## Write The Report

Write `.rankings/sweep-<YYYY-MM-DD>.md` in UTC. `.rankings/` is gitignored and
already holds the ranking receipts, so the two artifacts of one night sit
together. If the name is taken, append the lowest unused suffix — `-2`, then
`-3` — and never overwrite an earlier report.

Reserve the name atomically, with `set -o noclobber` or `mkdir` on a lock, and
retry the next suffix when the reservation fails:

```bash
mkdir -p .rankings                        # noclobber cannot create the parent
base=".rankings/sweep-$(date -u +%F)"
candidate="$base.md"
reserved=""
set -o noclobber
for n in $(seq 1 50); do
  if { : > "$candidate"; } 2>/dev/null; then reserved="$candidate"; break; fi
  candidate="$base-$((n + 1)).md"        # reservation lost: try the next one
done
set +o noclobber                          # or write with >| below
[ -n "$reserved" ] || {
  echo "sweep report: no free name under $base after 50 tries" >&2
  exit 1
}
printf '%s\n' "$report" > "$reserved"
```

Checking that a name is free and then writing it are two steps, and two sweeps
finishing on the same UTC date can both pass the check before either writes.
The reservation is what makes "never overwrite an earlier report" true rather
than merely intended.

A failed reservation is not proof the name was taken. A missing `.rankings/`, a
directory the session cannot write, and a full disk all fail identically, so
create the parent first, bound the loop, and exit loudly past the bound. An
unbounded retry treats a permission error as contention and spins forever, and
the night's report is lost either way — the difference is whether the operator
finds out.

Turn `noclobber` back off, or write with `>|`, before filling the file. The
reservation leaves an empty file in place, so a plain `>` under `noclobber`
refuses it — and a sweep that reserved a name and then silently failed to write
its report would lose the whole night's record.

Six parts. Only the first is the orchestrator's own; the rest are assembled
from the workers' report-backs:

1. **The receipt.** The path of the `rank-backlog` receipt this batch was
   selected from, and the batch size the operator asked for.
2. **A disposition table**, one row per claimed issue, with the columns
   `Issue | PR | Disposition`. For a shipped PR the disposition cell holds the
   worker's final `pnpm pr:ready-state --pr <pr> --compact` line **verbatim** —
   copied, not summarized, because a paraphrase of a readiness verdict is not
   evidence of one. `--compact` is the mode that emits one quotable line; the
   operating card's `--json` stays the machine-readable check and does not
   belong in a table cell. For an issue that was released, the cell holds the
   release reason and which release form was used.
3. **Claims this sweep did not get**, one line per refused claim, naming the
   issue, the `Claim ID` its real owner left on it, and the receipt entry taken
   instead. A refused claim never becomes a disposition row, because no work
   was done on it; omitting it entirely would hide that the batch shrank.
4. **Deferral issues filed**, by number, each with the PR it came from.
5. **Checkout conflicts**, one line per worker that found its deterministic
   clone path already taken and moved to a fresh one, naming both paths. The
   path it left is deliberately unexamined, so this line is the only record
   that something is still sitting there.
6. **Anything needing the operator's decision** — a blocked control, a
   misgroomed issue, a finding the worker could not adjudicate.

Print the same summary to the terminal; the file is the artifact, the terminal
output is its summary.

**End with the merge commands**, one line per PR that reached READY and nothing
for the rest:

```bash
pnpm pr:merge --pr <number>
```

The operator runs those from their own terminal. Listing a command is not
approval to run it, and this skill runs none of them.

Finally, send one spoken line saying the report is ready, through the fallback
ladder in
[`spoken-attention-nudge.md`](../../../docs/notes/spoken-attention-nudge.md).
That note owns the command, the key-file rule, and the `say`/`spd-say`
fallbacks; do not re-derive them here. Run the nudge with escalated execution
rather than inside the workspace sandbox — `sag` needs the network and the local
audio device, and a sandboxed attempt fails in a way that looks like a missing
command.

Keep the spoken text fixed and low-information: no issue numbers, PR numbers,
paths, or findings. It goes to a third-party service, and the report on disk is
where the detail belongs.

When every spoken path fails, **say so in the report** instead of skipping
quietly. A sweep that finished overnight and could not announce itself is a
different situation from one the operator was told about, and only the written
line distinguishes them.
