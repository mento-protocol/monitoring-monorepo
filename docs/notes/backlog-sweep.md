---
title: Backlog Sweep
status: active
owner: eng
canonical: true
last_verified: 2026-09-03
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
Hand each to a worker. Keep the workers awake. Groom the queue for the next run.
Write the report. Stop at READY.

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

**The orchestrator** is the session the operator invoked. It runs no quality
gate, edits no source file, and opens no PR — prohibitions that keep concurrent
workers out of each other's trees, and so bind only while separate workers
exist. A runtime that cannot spawn one works the batch sequentially, taking both
roles, one issue at a time. Merging is not one of those prohibitions: that
boundary is unconditional, in every shape of the run. Its work is selection,
claiming, keeping workers alive, and grooming the queue for the next run.

**A worker** is one subagent per issue, with one checkout, one branch, and one
PR. Workers never share a checkout: a repair applied through another worker's
clone lands on the wrong branch, and the worker that owns that branch has no
way to notice.

Every worker command runs from inside its own clone. `git clone` does not move
the shell and a worker can inherit the orchestrator's directory, so a brief
that only says which path to clone into would let setup, the branch, the
edits, and the gate run in the orchestrator's checkout — the tree the whole
scheme exists to keep workers out of.

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

Every checkout runs `./scripts/setup.sh`, fresh or resumed. That script sets
`core.hooksPath`, so a checkout that only ran `pnpm install` has no pre-push
hook — and a worker there could push without the gate these boundaries forbid
bypassing. The marker is written straight after the clone, so an interruption
between the two leaves an owned checkout with no hooks; rerunning is free, since
the script skips its own work when inputs are unchanged.

The split exists because subagents cannot wait across turns. A subagent that
ends its turn to wait for a gate stalls permanently — nothing re-invokes it,
and the background process it was waiting on has no one left to observe it. So
a worker polls its own gate and push inside the turn that started them, and the
orchestrator exists for the residue: re-invoking a worker that went quiet
anyway, and collecting the facts only workers can see.

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
- **Mutually independent** — two tests, in order. The docs-catalog test runs
  first and ignores labels: two candidates that both regenerate
  `docs/README.md` conflict whatever packages they sit in, below. Then the
  label test — no two issues in one batch share a `pkg:*` label.
  That label is the repo's existing ownership area
  ([`agent-issue-workflow.md`](agent-issue-workflow.md)), so "same subsystem" is
  a lookup rather than a per-batch judgement. Otherwise the second PR pays for
  a merge, a re-gate, and a fresh review round caused only by its sibling.
  `pkg:tooling` is the one area where a path test replaces that lookup, below.
- **Outside its own grooming veto window** — a candidate whose newest
  _trusted_ `sweep-groomed:` marker comment is less than 12 hours old waits
  for the next run, whatever version that marker carries, and the report names
  when that window closes. The window gives a human a bounded chance to
  disagree with a label an agent applied, before that label selects work for
  another agent. An issue a human labeled by hand carries no marker and is
  never delayed. An operator who wants to fast-track a groomed issue waits the
  window out or deletes the marker comment: a window its caller can waive is
  not a window. What makes a marker trusted is below.

Fewer qualifying issues than the batch size is a normal result: take fewer and
say so. Zero is also a result — write the report with an empty table rather
than relaxing a rule to fill it.

**Zero eligible issues does not end the run.** An empty batch is the case
grooming exists for, so the pass below still runs, and the report is written
after it. A sweep that returned early on an empty batch would leave the queue
exactly as it found it and the next run would find the same nothing.

### Trusting a veto marker

The marker is a comment, and anyone who can comment on an issue can write one.
Read it as untrusted input.

**The window runs from GitHub's `createdAt`, never from the marker's own `at`
field.** `createdAt` is GitHub's, the JSON is the comment author's, and a
caller-supplied future timestamp would otherwise extend the window at will. `at`
stays in the payload for a human reading the comment and is never read for
timing.

**A marker counts only from an author who can set labels**, in this order:

1. The account the sweep itself authenticates as — `gh api user -q .login`.
   That is the marker the veto exists for, and it needs no second call.
2. Any other login, only when its repository role is `triage`, `write`,
   `maintain`, or `admin`. Those roles can already apply the labels the marker
   describes, so honouring their marker grants nothing new.

```bash
gh issue view <n> --repo mento-protocol/monitoring-monorepo \
  --json comments \
  --jq '.comments[]
        | select(.body | startswith("<!-- sweep-groomed:"))
        | {login: .author.login, created: .createdAt}'

repo=mento-protocol/monitoring-monorepo
gh api "repos/$repo/collaborators/<login>/permission" --jq '.role_name'
```

`authorAssociation` is not that check. It names a relationship, not a permission
level: a read-only outside collaborator is `COLLABORATOR` and could otherwise
renew a veto every twelve hours on an issue it cannot label — the queue
denial-of-service the rule exists to stop.

Ignore a marker whose author fails both tests, and one whose role lookup errors,
and say so in the report. Ignoring costs at most 12 hours of veto on an issue
the sweep did not groom itself; honouring an unverified marker costs the queue.
The sweep's own marker never depends on the lookup, so the case the veto is for
never turns on a failed API call.

### Docs-catalog independence

This test runs before the label test, on every pair, whatever labels the two
candidates carry. A candidate carries the catalog when its work adds, moves, or
removes a Markdown surface, changes any front matter of an existing one, or
adds or removes an internal link, because the catalog lists broken internal
links beside an entry per file. Only a body-prose edit that leaves the front
matter and every link alone is exempt, and a body whose documentation effect
cannot be read carries the catalog: nothing to compare is not evidence of no
conflict. Two candidates that both carry it are never independent.

[`context-standards.md`](../context-standards.md) requires that generated
catalog to index every Markdown file, and `pnpm docs:index --check` fails while
it is stale, so both workers regenerate `docs/README.md` and their PRs conflict
on that one file even when they share no package and no other named path.
Scoping the rule to `pkg:tooling` would miss the pair the label test cannot
see: a `pkg:dashboard` issue adding a README beside a `pkg:indexer` issue
adding one shares no label and no path, and still produces two PRs that
regenerate one catalog.

Do not restate which fields the catalog renders: `classifyDocumentation` and
`catalogEntry` in `scripts/context/docs-index-helpers.mjs` decide that, they
already read `canonical` and `doc_type` beyond the fields an earlier draft of
this rule listed, and any list written here rots against them in silence.

### `pkg:tooling` independence

The label test assumes a `pkg:*` label maps to a collision surface. It does for
`pkg:indexer` and `pkg:dashboard`. `pkg:tooling` spans `scripts/`, `docs/`,
`.agents/`, `.claude/`, and the root tooling files, so two candidates that
touch nothing in common still share it, and the batch loses a slot to a
conflict that does not exist.

Two `pkg:tooling` candidates are independent when all three hold:

- each body names its expected files or directories;
- no path either body names equals or contains a path the other names, compared
  on whole path segments — `scripts/pr/` against `scripts/sentry/` is disjoint,
  `docs/` against `docs/notes/` is not, because the first contains the second
  and two workers would edit one file;
- neither names a shared root file or a control root: `package.json`,
  `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.trunk/**`, `.github/workflows/**`,
  `scripts/agent-quality-gate.sh`, or `scripts/gate/**`.

A candidate that carries the docs catalog above brings `docs/README.md` into
this comparison as well, so it also conflicts with a candidate that names that
file outright.

Normalize the mirrored skill trees before comparing, by path segments rather
than by text: any path whose first two segments are `.claude/skills` is read
with those segments replaced by `.agents/skills`, whatever follows and whether
or not it ends in a slash. `.claude/skills/foo`, `.claude/skills/foo/`, and
`.claude/skills/foo/SKILL.md` all normalize. The two trees are one collision
surface — the mirror check makes every edit land in both — so an issue naming
one and an issue naming the other would otherwise pass a literal containment
test and then produce two PRs touching the same files.

A candidate with no path list conflicts with every other `pkg:tooling`
candidate. Nothing to compare is not evidence that the paths are disjoint, and
an unverifiable pass here would reintroduce exactly the collision the label test
was blocking.

The printed batch names the independence basis for every pair that relied on
this refinement, so the audit line records which paths were compared. Every
other area keeps the label test, and `pnpm issue:claim --sweep-eligible`
enforces neither form: it grades one issue's own labels and never sees the
batch, so independence stays the orchestrator's judgement.

## Batch size and cost

Default 2. Maximum 4, and a larger request is **refused**, not clamped: an
operator who asked for 6 needs to know what they got.

The limit is about the weekly usage window. One shipped PR costs roughly 3% of
it, and the dominant cost is not the first implementation — it is the review
rounds, one per push, each producing findings that cost replies and often
another push. A batch sized on implementation effort alone underestimates by
the number of rounds it will take.

The grooming pass sits outside that model. It reads issues and writes labels
and one comment each, opens no PR, and buys no review round. Its cap of 10
candidates a run bounds it against the GitHub API rather than against the
usage window.

## Preflight

The orchestrator verifies, before anything is claimed: `origin/main` fetched, a
clean session worktree, working `gh` auth, and that
`git remote get-url --push origin` serves `mento-protocol/monitoring-monorepo`.
It does **not** probe the gate's lock.

A fork checkout is a stop. The operating card refuses every fork head and tells
a fork to stop rather than first-publish, and workers inherit this checkout's
remote — so a sweep started from a fork would claim, implement, and gate a
whole batch that can never open a PR. That is the preflight's whole purpose:
each check here costs one command, and skipping one fails late, with issues
already claimed and a worker mid-gate.

That omission is deliberate. Gate `--run` requests share a transient
machine-wide coordinator that admits independent work from different worktrees
under a weighted capacity, and a new gate joins a compatible coordinator rather
than queueing behind it
([`agent-quality-gate-mechanics.md`](agent-quality-gate-mechanics.md)). The
coordinator adopts the legacy `run.lock` while scheduled or recovery work
exists, so `run.lock/owner` names a live pid for as long as anyone on the
machine is gating — hours at a time under ordinary parallel work. A sweep that
treated that record as a busy signal would refuse to start in the normal case.
Local workers wait with `--lock-wait 3600`. Hosted workers use the hook's exact
1,800-second default so the push can reuse the warm stamp. Both waits span
scheduler admission, a command lease, a coalesced result, and an older legacy
holder. No sweep passes `--no-lock` or deletes the lock directory: the gate owns
its reclaim rules, and a record that looks stale from outside is routinely a
live holder inside a long browser suite.

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

## Grooming the queue

A sweep can only pick issues that already carry the labels its eligibility step
reads, and nothing else in the loop writes those labels. Ranking scores what it
finds, eligibility rejects what is under-labeled, and neither repairs it. The
grooming pass is the repair, applied to the next run rather than this one.
[ADR 0077](../adr/0077-operator-triggered-backlog-sweep.md) records the measured
gap that made the pass necessary.

**It runs after the batch is claimed and every worker is spawned, and before the
report.** That position is the whole safety argument. This run's eligibility
step has already finished, so no label the pass writes can select work for this
run. An unattended agent that labels an issue `risk:low` and then works it in
the same run has no risk gate at all, which is the root
[`AGENTS.md`](../../AGENTS.md) rule against weakening a control that blocks your
own work, applied to the sweep's own gate. Never move the pass earlier and never
re-run selection after it.

### Candidates

**Pin the tree before the walk.** Fetch `origin/main` and pin one OID for the
whole pass, before any candidate is read, because the skip key below compares
per-path digests at that OID and every later read in the pass must use the same
tree. The pass runs long after Preflight — after the batch is claimed and every
worker is spawned — so it pins its own OID rather than inheriting Preflight's,
and the marker records the ref and OID it used. That record is what makes a
verdict reproducible.

```bash
git fetch "$(git remote get-url --push origin)" main
oid="$(git rev-parse FETCH_HEAD)"   # the commit this fetch just wrote
git rev-parse "$oid:<path>"         # one blob or tree id; non-zero when absent
```

Fetch the validated push URL, not the remote name. Preflight grades
`git remote get-url --push origin`, and a remote that carries a `pushurl`
fetches from a different URL than it pushes to, so `git fetch origin main`
would resolve every path in the pass against a URL no check ever read. Naming
the validated URL binds the read to the repository Preflight approved, and it
leaves Preflight one check on one URL — the check the fork stop needs — rather
than a second check whose only reader is this pass.

Pin `FETCH_HEAD`, not `origin/main`. Every fetch writes the commit it fetched
there, while a fetch by URL updates no remote-tracking ref at all and a clone
made with `--single-branch` on another branch has no `refs/remotes/origin/main`
to read either, so `git rev-parse origin/main` fails after the batch is already
claimed. The marker's `ref` still records `origin/main`: the remote and branch
that was fetched.

Address each path as `<oid>:<path>`, not with `git ls-tree`. A body may name a
directory, with or without a trailing slash, and `git ls-tree "$oid" -- docs/notes/`
lists that directory's children instead of returning its one tree id.
`git rev-parse "$oid:<path>"` returns exactly one id for a file, for a directory,
and for a directory written with a trailing slash, and exits non-zero when the
path is absent — the case the marker's map omits.

Order, then filter, then cap at 10. Ordering is by `rank-backlog` score,
highest first, then by issue number, newest first. The outside-the-queue set
carries no score, so it orders by age alone and sits behind every scored
candidate. Two sets qualify:

- `agent-ready` issues that lack exactly one `risk:*` or exactly one `pkg:*`
  label. Eligibility cannot admit one of these as written, whether or not this
  run read it.
- Issues carrying no queue-state label, read from the roster the ranking
  already fetched, where they are counted as outside the queue
  ([`backlog-ranking.md`](backlog-ranking.md)). Exclude bot records: every
  issue authored by `app/github-actions`, and every issue carrying
  `drift-detection`, `sentry-triage`, a `sentry:*` label, `dependencies`,
  `security-advisories`, or `file-size-watchlist`. Those workflows own their
  own lifecycles, and labeling their output into the human queue would bury
  the issues a person wrote.

**Skip a candidate the pass cannot improve.** Without such a rule an
`agent-ready` issue whose body names no path stays a candidate for ever: it can
never earn a `pkg:*` label, and ten of them would hold the cap every run and
starve everything below.

**The skip runs before the cap.** The cap bounds grooming attempts, not
candidates examined. Capping first and skipping second gives the same ten
unchanged high scorers every slot on every run, and no lower-ranked candidate is
ever reached — the starvation the skip rule was written to prevent, moved one
step up. So order the candidates, drop the bot records, then walk that order and
test the skip key as you reach each one, stopping at the first 10 survivors. The
test costs one comment read per candidate examined, so walk it lazily rather
than pre-filtering the whole queue.

That cost is bounded by the candidate set, not by the cap: a run in which every
candidate skips reads every candidate's comments and grooms nothing. Record the
number of candidates examined in the report beside the number groomed, so the
read cost is measured rather than assumed. A fixed ceiling on candidates
examined was rejected: the walk order is stable, so a hard stop at the same
depth every run never reaches the tail of the queue, which is the starvation
this ordering exists to remove.

**The skip key has four parts**, read from the candidate's newest trusted
`sweep-groomed:v2` marker. Skip only when all four hold:

- the SHA-256 of the issue body still matches the marker's `body`;
- the marker's `paths` map still matches, path for path and digest for digest,
  resolved at this run's pinned `origin/main` OID;
- every label in the marker's `applied` list is on the issue;
- the issue's current `risk:*`, `pkg:*`, `kind:*`, and queue-state labels equal
  the marker's `labels` snapshot plus its `applied` list.

The fourth condition compares two sets that must cover the same label classes.
The snapshot and this test both read `risk:*`, `pkg:*`, `kind:*`, and
queue-state because those are every class the pass can write into `applied`. A
class the pass writes but the snapshot omits would sit on the right side and
never on the left, and the test would fail for every issue that carries one.
Any future label class the pass writes joins both sides together.

Each guards a different way the verdict can go stale. The body is what the pass
reads. The `paths` map is the rest of it — a named path that was absent then and
exists now changes the answer, one since deleted changes it too, and one whose
contents changed under a stable name changes it as well: a helper that becomes a
production-data writer flips the Low-risk rule without touching the body or the
path list. Comparing the map catches all three. The `applied` labels prove the
previous run finished: a marker whose labels are missing records a write that
failed after the comment landed, and skipping on the digest that failed run
wrote would strand the issue permanently.

The `labels` snapshot is what makes a human's correction reopen the candidate.
The pass stops without writing on an issue carrying two `risk:*` labels and on a
`risk:low` its verified paths contradict, and both stops write `applied: []`.
Against an empty list the third condition succeeds vacuously, so a human who
removes one of the two risk labels — the fix the stop was asking for — leaves
the body and the path map unchanged and the issue skipped for ever. The snapshot
is compared as a set against `labels` plus `applied`, because the pass's own
write lands after the marker and must not invalidate it.

Count every skip in the report, so a stuck issue is visible rather than silent.
A candidate re-groomed because the key broke gets its reason named too: which
path changed, which label a human moved, or that the marker was `v1`.

Compare the body, not `updatedAt`: posting the marker updates the issue, so a
timestamp test would compare the pass against its own write and never skip
anything. The digest is the same primitive `pnpm issue:claim --body-sha256`
already pins a sweep claim with. The limit is worth stating: only paths the body
names are covered, so a verdict that would change because some file the body
never mentions changed is not caught.

### What the pass applies

Read the body, then read the paths it names against the OID pinned at the start
of the pass. Every label below comes from what that tree holds, not from what
the body claims.

**The resolution basis is the shared ref, not the session checkout.** Read every
path as `<oid>:<path>` against that one pinned OID. Preflight
fetches `origin/main`
and requires a clean worktree, but never requires the checkout to be _at_
`origin/main`, so a sweep started from a clean feature branch would classify live
issues against that branch's tree. A path that exists only on the branch produces
a `pkg:*` the issue should not have, and one deleted on the branch produces the
wrong risk verdict. The labels are repository-wide state while the checkout is
session-local, and the pass never removes or downgrades a label, so a later
correct run can add a label beside the wrong one but cannot retract it and the
issue is left ambiguously routed and permanently sweep-ineligible. That rule
stays; the resolution basis is the thing that moves. The fetch and the pin
happen once, at the start of the pass, under Candidates above.

**The pass never writes a label that leaves an issue sweep-eligible.** Work out
the label set the write would produce; when that set satisfies the sweep
predicate — `agent-ready`, exactly one `risk:*` equal to `risk:low`, exactly one
`pkg:*` — the label goes in the marker's `proposed` list instead, and a human
applies it. This is one rule rather than a list of labels because which label
completes eligibility depends on what the issue already carries: for an issue
holding `risk:low` and no package area it is the `pkg:*`, and for one holding a
package area and no risk label it is the `risk:low`. The pass may narrow
eligibility freely and may never widen it.

The run boundary alone does not cover this. The veto is passive, the next run is
the same agent population, and an issue nobody read would become claimable on a
timer. One human label is the acknowledgement that ordering cannot supply, and
it is the same click the `agent-ready` promotion already needs.

- **`pkg:*`** — every package area the named paths fall in. One label when the
  paths sit in one area; several when the issue genuinely spans packages, which
  leaves it correctly labeled and still sweep-ineligible. Several areas can be
  written freely: they narrow. A single area that would complete eligibility is
  proposed. When the body names no path, apply none and say so in the marker.
- **`risk:*`** — one, and only when the issue carries none. The pass writes
  `risk:medium`, or `risk:high` when the issue touches secrets, IAM, a
  production apply, or deploy identity; both narrow. `risk:low` is proposed,
  never written, citing the
  [Low-risk rule](agent-issue-workflow.md#low-risk-rule) clause it relied on.

  Read that rule at its anchor rather than from memory, and when it cannot be
  read, propose nothing and say so: an agent that reconstructs the criterion for
  its own `risk:low` is choosing its own gate.

  Leave a risk label the issue already carries — the pass never removes one and
  never downgrades one. Two cases stop the pass on that issue instead, with the
  reason in the marker and no label written at all: an issue already carrying
  two risk labels, because removing one is the human judgement the pass is not
  making; and an issue carrying `risk:low` whose verified paths touch secrets,
  IAM, a production apply, or deploy identity, because completing its `pkg:*`
  routing would hand an unattended worker exactly the issue the risk label
  misdescribes.

- **`kind:*`** — one, when the work type is obvious from the body: `kind:bug`,
  `kind:refactor`, `kind:hardening`, or `kind:workflow`.
- **State** — the pass writes no state label at all. `agent-ready`,
  `needs-grooming`, `agent-active`, and `in-pr` are mutually exclusive, and
  [ADR 0082](../adr/0082-persistent-issue-board-mutation-mutex.md) serializes
  every queue-state write behind the per-issue mutex. `gh issue edit` does not
  take that mutex, so a raw write against a roster snapshot can land
  `needs-grooming` beside an `agent-active` a claim added a moment earlier. The
  pass proposes the state instead — `needs-grooming` for an unlabeled candidate,
  never `agent-ready` — and an operator or a mutex-owning helper applies it.

  Promotion to `agent-ready` was never the pass's to make: it is the human
  judgement that an issue is implementable as written. When the body already
  meets that bar — goal, acceptance criteria, expected files, and a verification
  command — say so in the marker comment so an operator sees it at a glance.

  Say in the same comment that an issue absent from the workboard needs adding
  to it. `hasSweepClaimAttributes` requires an exact non-Blocked selected
  Project status, so an issue with no Project item stays unclaimable by a sweep
  however it is labeled, and promotion alone would not be enough.

**Post the marker comment before the first label write, on every issue.** The
two writes are separate API calls, and a label that lands without a marker is an
issue the next sweep can select with no veto window at all — the control this
pass exists to keep. Marker first, labels second, so the failure that costs
something is a marker with no labels: harmless, and visible in the report. When
the comment cannot be posted, write no label for that issue and record the
failure. When a label write then fails, post one follow-up comment naming the
label that did not land; the marker stays, so the window still holds.

Label writes go through `gh issue edit --add-label`. No issue-board helper
offers a routing-label write: `issue:claim`, `issue:review`, and `issue:release`
move state labels and Project ownership fields only. The pass writes no Project
field, and it never touches the state label of an owned issue — one carrying
`agent-active` or `in-pr` belongs to a live claim.

### The marker comment

One comment per groomed issue, opening with a machine-readable marker:

```text
<!-- sweep-groomed:v2 {"sweep":"<sweep_id>","at":"<ISO-8601 UTC>","ref":"origin/main","oid":"<40-hex>","body":"<sha256>","paths":{"<path>":"<blob or tree sha>"},"labels":[...],"applied":[...],"proposed":[...]} -->
```

`ref` and `oid` name the tree the paths were resolved against, so a later reader
can tell what a verdict was based on and reproduce it. `body` is the SHA-256 of
the issue body this pass read. `paths` maps each named path that resolved at
that OID to the one blob or tree id `git rev-parse "<oid>:<path>"` returns; a
path the body names and the
tree does not hold is absent from the map. `labels` snapshots the issue's
`risk:*`, `pkg:*`, `kind:*`, and queue-state labels as read, before this pass
writes anything — every class the pass can write, so the skip key compares like
with like. Together with `applied` those four fields are the skip key above.
`applied` lists the labels the pass writes immediately after posting this
comment; the comment is written first, so the field names an intent that the
label call then carries out. `proposed` lists everything the pass judged right
and will not write itself: a `risk:low` it is not allowed to apply, the state
label the mutex owns, the `agent-ready` promotion only an operator can make,
workboard enrollment, and a risk label withheld from an issue already carrying
two or contradicted by its own paths.

`at` records when the pass ran, for a human reading the comment. The veto window
is measured from GitHub's `createdAt` on the comment instead, and only on a
comment from a trusted author, both settled under Eligibility above.

**The version in the prefix is what retires an old contract.** `v2` added `ref`,
`oid`, `labels`, and per-path digests, so the skip key matches the literal
`sweep-groomed:v2` prefix and every `v1` marker is ignored by construction:
issues groomed under `v1` re-groom once, on a tree the marker never named.
The veto window is the exception and reads any `sweep-groomed:` version, because
it asks whether a human has had a chance to see the labels and that question
does not depend on the payload shape. Reading `v2` only there would un-veto
every issue the last run groomed. The next contract change bumps to `v3` on the
same terms.

Under it, in prose: the labels applied, the paths checked, the Low-risk rule
clause that decided the risk label, and — for an unlabeled issue — whether the
body meets the agent-ready bar. The marker's timestamp is what the veto window
reads; the prose is what a human reads before promoting the issue.

### The veto window

A candidate whose newest `sweep-groomed:` marker is younger than 12 hours is
ineligible, and the eligibility step above enforces it. The window is a bounded
chance for a human to disagree with an agent's label before that label picks
work for another agent. Only a sweep writes this marker, so an issue a human
labels by hand is never delayed by it.

The cost is real and belongs in the open: an operator who wants to fast-track an
issue the sweep just groomed waits the window out or deletes the marker comment.
There is no shorter path by design, because a window its caller can waive stops
being one.

### When grooming fails

The pass never blocks the report. A failure on one issue — a rate limit, a label
that no longer exists, a path read that errors — is recorded against that issue,
and the pass continues with the next candidate.

One failure is not survivable that way. A marker comment that cannot be posted
stops that issue there, before any label is written, because a labeled issue
with no marker is eligible immediately. Every other failure leaves the issue
either untouched or marked and under-labeled, and both are safe: the next run
sees an issue it will not select, and the report says why.

## Boundaries

Four rules bind every sweep, and they are MUST-level because nobody is watching
while it runs:

- **Never merge.** The sweep ends at READY and reports the PR links. A human can
  open those links and merge in the GitHub UI.
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
deferral issues filed, the checkout conflicts, anything needing the operator's
decision, and what the grooming pass labeled for the next run. A refused claim
gets its own line rather than a table row — no work was done on it — and without
that line a shrunken batch would look like the batch that was asked for. It
names the holder's `Claim ID` when the re-read shows one, and otherwise records
a state change between the read and the claim — a closed or re-groomed issue has
no holder, and an old comment would name a session unrelated to the refusal.
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

The grooming section states two run-wide facts above its table: the
`origin/main` OID every path was read against, the same value the marker
carries, so a verdict in the report is reproducible from a named ref rather than
from whatever tree the session happened to hold; and how many candidates the
walk examined to reach the groomed set. Both are one value a run, so neither is
a column.

The table itself is `Issue | Labels applied | Proposed for a human | Rule basis
| Veto ends`. `Proposed for a human` is the
column an operator acts on: a `risk:low` the pass may not write, the state label
the mutex owns, workboard enrollment, an `agent-ready` promotion the body already
deserves. `Rule basis` names the Low-risk rule clause behind the risk verdict,
and on a skipped or re-groomed row it carries the reason instead.
`Veto ends` is the end of that issue's 12-hour window, and it says when the
window closes rather than when the issue becomes selectable — a proposal nobody
has applied, a `risk:medium`, or several `pkg:*` labels all keep it ineligible
whatever the clock says. Name the remaining requirement beside the time whenever
one applies. Zero groomed issues is a valid line and gets written rather than
omitted — an empty candidate set and a pass that never ran read identically once
the section is missing. Candidates skipped against their last marker get a row
too, so a permanently stuck issue is visible, and so do candidates the key sent
back for re-grooming. Both put their reason in `Rule basis`: for a skip, that
the key held; for a re-groom, what broke it — the path whose digest moved, the
label a human changed, or a `v1` marker.

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
