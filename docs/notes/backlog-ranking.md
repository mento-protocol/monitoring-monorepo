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

Which open issue should an agent pick up next? Without a written answer, every
session re-derives one from whatever sits at the top of the issue list, and the
reasoning dies with the session. This loop writes the reasoning down.

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
  neither state shows up in an assignee check.
- **claim** — `pnpm issue:claim`, run by the operator after reading the receipt.

## The receipt

`.rankings/ranking-<YYYY-MM-DD>.md`, one per run, never overwritten. It carries
Method, a Top 15 table, and a Selected section; the skill owns the field list.

Two properties make a receipt worth keeping:

- **Every reason is grounded in a body actually read.** A reason inferred from a
  title is a guess wearing a citation. The Method section states how many bodies
  were read in full and how many issues were scored from the list line, so a
  reader can tell the two apart.
- **Fit is capped by authority, and the cap is stated.** An issue that needs a
  product decision, a credential, or a human approval cannot be finished by the
  loop however good the issue is. Scoring it down silently reads as a judgement
  on the issue. Naming the cap keeps those two separate and tells a human
  exactly what would lift it.

## The exclusion ledger

`.rankings/excluded.json` is an append-only array of
`{ "issue": <number>, "reason": "<what happened>", "excluded_at": "<ISO 8601>", "expires_at": "<ISO 8601>" }`.
A run drops an issue while the newest entry for that number is unexpired.

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

**Stage 1, current: ranking only.** The loop produces a receipt and a
recommendation. A human claims the issue.

**Stage 2, deferred: auto-start the top item.** Tracked by issue #2071, which
stays open after the stage-1 PR. Stage 2 needs three things that are not settled
yet: a claim that stays safe when several agents rank at once, a stop condition
for a bad pick, and an answer for what happens when the selected issue turns out
to need a decision mid-flight. Shipping the selector first lets a run of
receipts show whether the ranking is good enough to trust with a claim.
