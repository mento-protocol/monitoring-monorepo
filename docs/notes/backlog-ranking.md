---
title: Backlog Ranking
status: active
owner: eng
canonical: true
last_verified: 2026-08-26
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Backlog Ranking

This loop decides which open issue an agent picks up next, and writes the
reasoning down. Without a written answer, every session re-derives one from
whatever sits at the top of the issue list, and no session preserves its
reasoning for the next one.

The procedure is the `rank-backlog` skill
([`.agents/skills/rank-backlog/SKILL.md`](../../.agents/skills/rank-backlog/SKILL.md));
this note owns the contracts it produces against. Queue labels, claiming, and
release stay canonical in [`agent-issue-workflow.md`](agent-issue-workflow.md).

## The loop

Fetch the open issues. Drop the ones already owned. Score what is left. Write
the receipt. Recommend one issue. Stop.

Stopping is the design. A loop that ranks and then starts the work hands the
operator a running agent instead of a decision, and leaves no moment to
disagree with the pick.

## Vocabulary

The loop reuses the workflow's terms and adds none:

- `agent-ready` — eligible to be Selected.
- `needs-grooming` — scored and ranked, never Selected. A high-scoring
  `needs-grooming` issue is a grooming prompt, and the receipt says so.
- `agent-active` and `in-pr` — already owned, so dropped from the roster. This
  repo claims through labels and Project fields rather than assignees, so
  neither state shows up in an assignee check — and the reverse holds too: an
  assignee is not a claim. `listReadyIssues` applies no assignee filter, so an
  `agent-ready` issue assigned for triage stays eligible.
- **conflicting queue state** — an issue carrying both `agent-ready` and
  `needs-grooming`. The lifecycle treats them as mutually exclusive and the
  board reports the conflict, but a snapshot taken mid-repair can see both. Such
  an issue is held out as unresolved and named in Method rather than ranked,
  because ready and grooming give the selection rules opposite answers.
- **outside the queue** — an open issue carrying none of the four labels above.
  Workflows open these on their own: drift reports, supply-chain advisories,
  Sentry triage records. They are never ranked and never Selected; Method counts
  them so a reader can see the gap between open issues and the roster. An owned
  issue is never one of these: the drop rules are ordered and each issue counts
  under the first that applies, so ownership and outside-the-queue cannot both
  claim it.
- **claim** — `pnpm issue:claim`, run by the operator after reading the receipt.

## The receipt

`.rankings/ranking-<YYYY-MM-DD>.md`, one per run, never overwritten. The date is
UTC, and a second run the same day appends the lowest unused suffix — `-2`, then
`-3`. Each name is claimed by an exclusive create, so two runs in one checkout
cannot pick the same one. It carries Method, a Top 15 table, and a Selected
section; the skill owns the field list and the retry mechanics.

Two properties make a receipt worth keeping:

- **Every reason in the table is grounded in a body actually read.** A reason
  inferred from a title alone is not supported by the issue it cites. Issues
  scored from the
  list line alone are ranked but stay out of the table, and the Method section
  states how many bodies were read in full and how many were scored from the
  list line, so a reader can tell the two apart.
- **Fit is capped by authority, and the cap is stated.** An issue that needs a
  product decision, a credential, or an issue-specific human approval cannot be
  finished by the loop however good the issue is. Scoring it down silently reads
  as a judgement on the issue. Naming the cap keeps those two separate and tells
  a human exactly what would lift it. The merge approval every PR needs is not a
  cap: it applies to all work equally, so scoring on it would say nothing.

A run whose ready queue is empty writes `Selected: none` and the reason. That is
a valid receipt — the alternative is inventing a candidate to satisfy the format.

## The exclusion ledger

`.rankings/excluded.json` is an append-only array of
`{ "issue": <number>, "reason": "<what happened>", "excluded_at": "<ISO 8601>", "expires_at": "<ISO 8601>" }`.
A run drops an issue while the newest entry for that number is unexpired. The
file does not exist until the first park; a run reads a missing file as `[]`
rather than failing or creating an empty one. Appending is a read-modify-write,
so a lock is held across the whole of it and released only after the write
lands, removed on failure too, and broken only after confirming its owner is
gone. Re-reading and comparing before the write is not an accepted substitute:
both runs can re-read, both see no change, and both write, losing an entry just
the same. Two sessions parking different issues concurrently would otherwise
lose one park or leave the file unparsable, and a lost park returns that issue
at the top of the next run.

The lock records its owner — a PID and a token generated for that run — because a
lock holding nothing cannot be recovered safely: breaking it would be a guess,
and a PID on its own can match an unrelated process once the number is reused.
The rewrite is published by writing a temporary file in the same directory and
renaming it over the ledger while the lock is still held. The lock serializes
writers, and ranking runs read the ledger without taking it, so only the atomic
rename keeps a reader from seeing half a file — or a killed writer from
truncating the ledger for good.

It exists so a parked issue does not resurface at the top of every run and force
the same decision again. Entries are appended, never edited or deleted: an
edited ledger makes earlier receipts unreadable, because the roster they were
built from can no longer be reconstructed.

`expires_at` is what keeps append-only from meaning permanent. Every park is
time-boxed, so an issue parked until some measurement re-runs returns to the
roster by itself once its entry lapses, without anyone editing the file.
Un-parking early is also an append: add a fresh entry for the same number whose
`expires_at` has already passed, and the newest-entry rule puts the issue back
while the original decision stays on the record.

`.rankings/` is gitignored, so the ledger is local to one checkout and does not
travel between machines or agents. That fits the run artifacts and is a real
limit on the ledger. A permanent exclusion belongs on the issue itself — close
it, or move it to `needs-grooming`. The ledger holds only short-lived
"not this run" decisions.

## Staging

**Stage 1: ranking only.** The loop produces a receipt and a recommendation. A
human claims the issue. This is what `rank-backlog` does, and it remains the
whole of that skill — running a sweep does not change it.

**Stage 2, delivered in operator-triggered form: the backlog sweep.** The
`backlog-sweep` skill takes a receipt's eligible top N, claims each issue by
number, and drives each through its own worker to a ready-for-review PR. The
loop, the eligibility rules, the boundaries, and the report contract are
canonical in [`backlog-sweep.md`](backlog-sweep.md).

The three questions stage 2 was waiting on are answered there rather than here:
a claim that stays safe under concurrency is the specific-number claim and the
helper's own `Claim ID` guard; the stop condition for a bad pick is an honest
`pnpm issue:release --issue <n> --claim-id <claim-id>` with a comment saying
what was learned; and an issue that
turns out to need a decision mid-flight is released the same way — with
`--needs-grooming` when clarity is what is missing — as long as no PR is open
for it yet. Once one is, the issue stays `in-pr` and the PR goes to the operator
as a decision instead, since releasing it there would return work already under
review to the ready queue. Eligibility also excludes
authority-capped fit up front, so the mid-flight case is rarer than it was when
this was deferred.

**Still future work: cron-triggered autonomy.** A sweep that starts itself on a
schedule is not in scope for the operator-triggered form and is not required by
it. The operator invoking each run is the trust gate — the batch is printed with
a short abort window before the first claim, and every PR stops at READY for
them to read before any merge.

Issue #2071 tracked stage 2 and closes with the operator-triggered form its
grooming decisions chose. Cron autonomy carries no tracking issue by design: it
is an idea the operator descoped, not work this loop deferred, and it gets a
fresh issue if it is ever wanted.
