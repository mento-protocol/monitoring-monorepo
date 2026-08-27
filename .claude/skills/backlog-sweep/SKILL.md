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

**Check who holds the gate's machine lock.** Gate runs are serialized
machine-wide, and one sweep takes that lock once per issue and again for every
patch cycle:

```bash
lock="${AGENT_QUALITY_GATE_LOCK_DIR:-$HOME/.cache/agent-quality-gate}/run.lock"
[ -e "$lock/owner" ] && cat "$lock/owner"
```

The record names `started_at` in epoch seconds, plus the holding pid, machine,
and worktree. Age alone does not settle it. Confirm the holder is alive first —
on the recorded machine, `ps -p <pid>` — because a crashed gate leaves its
record behind, and treating that record as a live holder would stop every later
sweep for good. When a **live** holder has held the lock for more than ten
minutes, **report it and stop**: name the pid and the worktree so the operator
can find the session, and do not start. A long-held lock means another session
is mid-gate, and queueing a whole batch behind it turns a two-issue night into
one late PR. When the recorded pid is gone, or the record belongs to another
machine, leave the lock alone and let the gate apply its own reclaim rules on
the next run. Never pass `--no-lock` and never delete the lock directory to get
past this — the gate owns those reclaim rules, and a lock that looks stale
from outside is routinely a live holder inside a long browser suite.

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

From the receipt's Top 15, take the top N — default 2 — that satisfy **all** of:

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
- **Mutually independent.** No two issues in one batch touch the same
  subsystem. Two workers editing one package produce PRs whose diffs conflict
  and whose reviewers see a base moving under them, and the second PR then pays
  for a merge, a re-gate, and a fresh review round it did not need.

If fewer than N issues qualify, take fewer and say so in the report. Never
relax a rule to fill the batch. Zero qualifying issues is a valid result: write
the report with an empty disposition table, name what the receipt held, and
stop.

## Hand Each Issue To A Worker

**Print the batch before the first claim.** List every selected issue by number
and title, with the receipt position that put it there, and say plainly that the
sweep is about to claim them and open a PR for each. This is the step the trust
model rests on: the operator triggered the sweep, but they chose a batch size,
not a set of issues — the set comes from a ranking they have not seen yet. They
are still at the terminal at this point, so showing the batch is what turns the
trigger into consent for these specific issues, and it is their moment to stop
the run. Do not wait on a reply: the operator starts a sweep to leave it
running, and blocking on input here would strand the batch the first time they
walk away. Print, then proceed.

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
this command. Spawn the worker only for a claim that succeeded. On a refused
claim, leave the issue alone, move to the next eligible entry on the receipt,
and record the loss and its new owner in the report; when the receipt is
exhausted, finish with the smaller batch. A worker briefed on an issue this
sweep does not hold duplicates whatever its real owner is already doing.

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

  Subagents inherit the parent session's Bash worktree pin, so git in a sibling
  worktree under `.claude/worktrees/` is refused for them. The tmp clone is not
  a preference; it is the only checkout a worker can use. Then
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
  mangles the arguments on the way through the package manager. The hour-long
  lock wait is what lets a second worker queue behind the first instead of
  failing outright.

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

## Keep The Workers Awake

These duties belong to the orchestrator. They are the reason this skill has an
orchestrator at all.

**Own the wake loop.** A subagent that ends its turn to wait for something
stalls permanently — nothing re-invokes it. So the orchestrator watches the
long processes and wakes the worker itself. Start a watcher in the background
for each gate or push the worker reports:

```bash
while kill -0 "$pid" 2>/dev/null; do sleep 30; done
```

When it exits, send the worker a message naming the process that finished and
what to do next. Watch the process, not a log file: a truncated or buffered log
looks identical to a running one.

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

Five parts:

1. **The receipt.** The path of the `rank-backlog` receipt this batch was
   selected from, and the batch size the operator asked for.
2. **A disposition table**, one row per claimed issue, with the columns
   `Issue | PR | Disposition`. For a shipped PR the disposition cell holds the
   **final `pr:ready-state` line verbatim** — copied, not summarized, because a
   paraphrase of a readiness verdict is not evidence of one. For an issue that
   was released, it holds the release reason and which release form was used.
3. **Claims this sweep did not get**, one line per refused claim, naming the
   issue, the session that holds it, and the receipt entry taken instead. A
   refused claim never becomes a disposition row, because no work was done on
   it; omitting it entirely would hide that the batch shrank.
4. **Deferral issues filed**, by number, each with the PR it came from.
5. **Anything needing the operator's decision** — a blocked control, a
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
