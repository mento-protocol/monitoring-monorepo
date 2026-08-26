---
name: rank-backlog
description: "[repo-skill] Rank the open monitoring-monorepo issue backlog into an auditable receipt under `.rankings/` and recommend one issue to work next. Use when asked to rank the backlog, decide what an agent loop should pick up next, or produce a ranking receipt. It recommends only: it never claims an issue and never starts implementation."
title: Rank Backlog Skill
status: active
owner: eng
canonical: true
last_verified: 2026-08-26
doc_type: skill
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# Rank Backlog

Score the open backlog in one pass, leave the score sheet on disk, and
recommend one issue. This skill recommends; the operator picks. It stops at the
recommendation: claiming is `pnpm issue:claim`, and it happens after a human has
read the receipt.

Receipt format, the exclusion-ledger contract, and the staging plan are
canonical in
[`backlog-ranking.md`](../../../docs/notes/backlog-ranking.md). Queue labels and
the claim lifecycle are canonical in
[`agent-issue-workflow.md`](../../../docs/notes/agent-issue-workflow.md).

## Build The Roster

```bash
mkdir -p .rankings
gh issue list --state open --limit 1000 \
  --json number,title,url,labels,assignees,updatedAt \
  > .rankings/roster-raw.json
```

`--limit` is a ceiling, not a page size: `gh` pages up to it. If that file ever
comes back holding exactly the limit, the backlog outgrew one fetch and the
roster is silently short. Raise the limit and refetch. Never rank a roster you
know is truncated — record the returned count in Method so a reader can check.

Linked pull requests are not on that projection. Fetch them separately:

```bash
gh api graphql --paginate --slurp -f query='
query($owner: String!, $repo: String!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    issues(states: OPEN, first: 50, after: $endCursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        timelineItems(last: 100, itemTypes: [CROSS_REFERENCED_EVENT]) {
          totalCount
          pageInfo { hasPreviousPage startCursor }
          nodes {
            ... on CrossReferencedEvent {
              willCloseTarget
              source { ... on PullRequest { number state } }
            }
          }
        }
      }
    }
  }
}' -F owner=mento-protocol -F repo=monitoring-monorepo \
  > .rankings/linked-prs.json
```

`--slurp` makes that file one JSON array with a page per element. Without it
`--paginate` writes the pages back to back, which parses only while the backlog
fits in a single page and breaks once it does not.

`last: 100` reads the newest 100 cross-references per issue. That is a window,
so make the window's edge visible rather than trusting it: `totalCount` and
`pageInfo.hasPreviousPage` say whether an issue's timeline was cut off. An
older open pull request can hide behind a cut-off edge.

**A truncated timeline is resolved before the issue is ranked, not just before
it is Selected.** When `hasPreviousPage` is true for a candidate, walk that one
issue's timeline in full before it enters the Top 15, stands as the runner-up,
or is Selected. Gating only the Selection step is not enough: the pull request
hiding behind the cut-off edge may be the one that closes the issue, so an
already-owned issue could hold a ranked slot and distort the very comparison the
Selected section is built on. Where the full walk is genuinely not possible,
keep the issue out of all three outputs and count it in Method as unresolved
rather than ranking it on a timeline you know is partial. Walk it **forwards**:
`--paginate` follows `hasNextPage`/`endCursor` only, so a query written with
`before`/`startCursor` returns its first page and stops, which looks like a
complete answer and is not one.

```bash
gh api graphql --paginate --slurp -f query='
query($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      timelineItems(first: 100, after: $endCursor,
                    itemTypes: [CROSS_REFERENCED_EVENT]) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ... on CrossReferencedEvent {
            willCloseTarget
            source { ... on PullRequest { number state } }
          }
        }
      }
    }
  }
}' -F owner=mento-protocol -F repo=monitoring-monorepo -F number=<n>
```

Say in Method how many issues needed that second pass. A cross-referencing
pull request does not guarantee that `agent-active` or `in-pr` was applied, so
the label check is a second net here, not a substitute for this one.

`willCloseTarget` is what separates a claim from a mention. It is true only when
the referencing pull request closes the issue on merge — `Closes #n`. The repo
requires `Refs #n` instead whenever the issue's Done means is not fully
satisfied, so dependency, exploratory, and partial-work pull requests
cross-reference issues nobody has claimed. Treating every open cross-reference
as ownership hides exactly those.

Drop a candidate for any of the following, and keep the count dropped for each
reason. The rules are ordered, and an issue is counted under the **first** one
that applies: an owned issue is owned, never also "outside the queue", so the
per-reason counts and the outside-queue count sum to the number dropped instead
of double-counting the issues that satisfy both.

- it has an assignee;
- it carries `agent-active` or `in-pr` — this repo claims through labels and
  Project fields, so an owned issue can still have no assignee;
- a cross-referencing pull request is `OPEN` **and** its `willCloseTarget` is
  true. An open `Refs #n` pull request is not a claim; note it in the reason if
  it bears on the pick, but do not drop the issue for it;
- the newest `.rankings/excluded.json` entry for its number has not expired yet
  — see the ledger contract under Stop There. A lapsed or superseded entry is
  not a drop: that issue belongs back in the roster. A missing file is an empty
  ledger, not an error: on the first run there is nothing to exclude;
- it carries no queue-state label at all — none of `agent-ready`,
  `needs-grooming`, `agent-active`, or `in-pr`. This repo's workflows open
  issues outside the queue: drift reports, supply-chain advisories, and Sentry
  triage records, none of which a ranking run can select. Count these in Method
  as outside the queue rather than ranking them into slots a workable issue
  should hold.

Keep `needs-grooming` issues in the roster. They score badly on ease and fit on
their own merits, and seeing where they land is the point. Never Select one:
recommend the top `agent-ready` candidate instead, and say in the Selected
section when a higher-scoring issue was passed over for that reason.

## Score Each Candidate

Four factors, 0-25 each, 100 total. Break ties alphabetically by title.

| Factor            | 0-25 for                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Ease              | Can one agent loop plausibly finish it? Named files, stated acceptance criteria, and a verification command beat prose. |
| Benefit           | User-facing correctness and money-path accuracy beat cosmetics: a wrong number on a dashboard outranks a spacing fix.   |
| Dependency effect | Does closing it unblock other open issues, or is it a leaf?                                                             |
| Fit               | Can it be done with the code, docs, and access this loop holds?                                                         |

Cap fit, and name the cap in the reason:

- needs a product, design, or policy decision this repo does not own —
  **fit at most 8**;
- needs credentials, a provider console, or an account the loop cannot reach —
  **fit at most 8**;
- needs an issue-specific human approval before the work is even ready to review
  (Terraform apply, secret rotation, indexer promote) — **fit at most 12**.

The merge approval every PR in this repo needs is not that cap. It applies
equally to every issue, so capping on it would flatten the factor to a constant
and stop it distinguishing anything. Cap only where an approval blocks the work
itself, ahead of normal PR readiness.

A capped issue can still be strong work. Say that plainly instead of quietly
scoring it down: name the cap, and name what would lift it.

Read the full body of every issue that can plausibly reach the top 15. Score the
rest from the list line. A reason must come from a body actually read; an issue
whose reason rests on its title alone does not belong in the table.

## Write The Receipt

Write `.rankings/ranking-<YYYY-MM-DD>.md` in UTC. If that name is taken, append
the lowest number not yet used that day — `-2`, then `-3`, and on — so a third
run never lands on the second run's file. Never overwrite a receipt.

Claim the name by creating the file exclusively, and treat a collision as the
answer rather than an error: under `set -o noclobber`, `: > "$name"` fails when
the file already exists, so move to the next suffix and try again. Checking that
a name is free and then writing it are two steps, and two runs in the same
checkout can both pass the check before either writes — the later write would
then destroy the earlier receipt the audit trail depends on.

Three sections:

1. **Method** — fetch timestamp, open-issue count, how many of those sat outside
   the queue, roster count, the per-reason drop counts, how many bodies were read
   in full, how many issues were scored from the list line, and any cap that
   applied to a whole class of issues.
2. **Top 15** — one table with the columns `Rank | Issue | Score | Reason`. The
   reason is one line: what the issue is, why it scores where it does, and the
   cap when one applied.
3. **Selected** — one issue, its number and title, and why it beats the
   runner-up. State the first concrete step and what would make it stop.

**An empty ready queue is a result, not a failure.** When no `agent-ready`
candidate survives the drops — every one claimed, parked, or awaiting grooming —
write `Selected: none` with the reason, and skip the runner-up comparison there
is nothing to make. Method and the table still carry the run. Never groom, claim,
or invent a candidate to fill the section.

Print the Selected section, the top five rows, and the receipt path to the
terminal. The receipt is the artifact; the terminal output is its summary.

## Stop There

Ranking ends at the recommendation. Do not claim, do not branch, do not edit
code. Hand the receipt path to the operator and stop.
`pnpm issue:claim --issue <n> --agent <name>` is theirs to run.

Record a parked issue in `.rankings/excluded.json` so the next run skips it:

```json
[
  {
    "issue": 1936,
    "reason": "parked until the alert-noise measurement re-runs",
    "excluded_at": "2026-08-26T09:14:00Z",
    "expires_at": "2026-09-03T00:00:00Z"
  }
]
```

Every entry carries an `expires_at`, because every park here is time-boxed. A
run drops an issue only while the **newest** entry for that number is still
unexpired; once it expires the issue returns to the roster on its own.

The file is absent until the first park. Read a missing file as `[]` and rank
the whole roster; do not create an empty one to make the read succeed.

Append only. To un-park early, append a fresh entry for the same number with an
`expires_at` already in the past — never edit or delete the old one. The ledger
records what earlier runs decided, and rewriting it makes their receipts
unreadable.

`.rankings/` is gitignored, so the ledger is local to one checkout. A permanent
exclusion belongs on the issue itself, by closing it or moving it to
`needs-grooming`.
