---
name: backlog-sweep
description: "[repo-skill] Ship a small batch of ranked monitoring-monorepo backlog issues in one operator-started session: rank, pick the eligible top N, claim each by number, and drive each through its own worker subagent to a ready-for-review PR. Use when asked to sweep the backlog, work the top issues, or run a batch overnight. It never merges: it stops at READY and hands the operator the PR links."
title: Backlog Sweep Skill
status: active
owner: eng
canonical: true
last_verified: 2026-09-03
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
claims, hands each issue to a dedicated worker subagent, and grooms the queue
for the next run. It runs no author check, edits no source file, and opens no
PR. Those three prohibitions keep concurrent workers out of each other's trees,
so they bind only while separate workers exist: on a runtime with no way to
spawn one, the session works the batch sequentially and takes both roles
itself, one issue at a time.

**It merges nothing, in either shape.** That boundary is unconditional — it has
nothing to do with tree isolation or with how many actors are running, and the
hard boundaries below state it. The isolated checkout, the rest of those
boundaries, and the report contract hold either way.

The loop, the boundaries, the report contract, and the resilience duties are
canonical in
[`backlog-sweep.md`](../../../docs/notes/backlog-sweep.md), and
[ADR 0077](../../../docs/adr/0077-operator-triggered-backlog-sweep.md) records
why this operating model was chosen over shared checkouts and cron autonomy.
Ranking is the
`rank-backlog` skill and its contracts in
[`backlog-ranking.md`](../../../docs/notes/backlog-ranking.md). Queue labels,
claiming, and release stay canonical in
[`agent-issue-workflow.md`](../../../docs/notes/agent-issue-workflow.md). Every
worker works
[`pr-operating-card.md`](../../../docs/notes/pr-operating-card.md) steps 2-7.

## Preflight

Every check here fails cheaply. Skipping one fails late, after issues are already claimed and a worker is mid-validation.

```bash
gh auth status          # must report an authenticated account
git remote -v           # origin fetch and push must serve mento-protocol/monitoring-monorepo
git status --porcelain  # must print nothing
git fetch origin main   # only after both origin URLs pass
```

**A fork checkout is a stop, before anything is claimed.** The operating card
refuses every fork head and tells a fork checkout to stop rather than
first-publish, because a cross-repository PR is one that workflow can never
drive to ready
([`pr-operating-card.md`](../../../docs/notes/pr-operating-card.md)). Workers
inherit this checkout's remote, so a sweep started from a fork would claim
upstream issues, implement and validate all of them, and only then discover that
none of them can open a PR. Check both effective URLs here, where they cost one
command.

A dirty session worktree is a stop, not a warning. The orchestrator does not
commit, so nothing it does would clear those changes, and a sweep that runs
beside unfinished work makes the two indistinguishable in the report.

**Do not probe or change the legacy gate's lock.** Workers run the direct author
checks from operating-card step 3 in isolated checkouts. The batch cap remains
the CPU and memory bound. Run no more than three ordinary command-heavy check
sets at once. Run dashboard coverage or scoped related tests, browser work,
production builds, and size-limit work alone. Other workers can keep editing.
A browser check that finds its fixed port in use must fail and report the
conflict. It must not wait for, stop, or reuse another process.

**State the usage reality before starting.** One shipped PR costs roughly 3% of
the weekly usage window, and every push to it triggers another Codex review,
whose findings then cost replies and often another push. Claude is not a
per-push cost: `.github/workflows/claude.yml` fires on `opened` and
`ready_for_review` only, so a Claude re-review is opt-in via `@claude review`.
CodeRabbit should not be a per-push cost either — it is configured to review
the opening push and the closeout head only — but PR #2236 observed a run on
every push, all refused by the spending cap, so budget for the attempt until
ADR 0066's open question is settled. Two issues is
the default because the cost is dominated by review rounds, not by the first
implementation. **Refuse a batch size above 4.** Say that plainly and stop
rather than clamping silently — an operator who asked for 6 needs to know they
got a refusal, not a quiet 4. The grooming pass below is outside that model: it
costs issue reads, label writes, and one comment each, opens no PR, and buys no
review round. Keep its cap at 10 grooming attempts a run.

## Rank And Pick The Batch

Run the `rank-backlog` skill's ranking end to end and let it write its normal
receipt. Do not shortcut it to a quick issue list: the receipt is the audit
trail this sweep's report cites, and a batch picked without one cannot be
reviewed after the fact.

**Its `Stop There` section does not stop the sweep.** That section ends a
_standalone_ ranking at the recommendation — it hands the receipt to the
operator and leaves `pnpm issue:claim` to them, because nothing else in that
skill is authorized to claim. Here the operator has already authorized the
batch by invoking this skill, which owns the claiming, so ranking hands its
receipt back to the sweep and the sweep continues at the next section. Read
`Stop There` as the boundary of the ranking skill's own authority, not as a
halt for whatever invoked it. A sweep that stopped there would rank all night
and ship nothing.

**The receipt does not carry eligibility.** Its Top 15 table is
`Rank | Issue | Score | Reason`, and it ranks `needs-grooming` issues beside
`agent-ready` ones. Being Selected by `rank-backlog` is a ranking verdict, not
a batch verdict — the Selected issue can fail any rule below. So read each
candidate directly, stopping once N qualify, in this order: the receipt's
Selected issue, its runner-up, then the Top 15. Those first two are read
"whatever their rank" by `rank-backlog` itself and are not always in the table
— fifteen higher-scoring grooming issues push the best ready candidate off it —
so a sweep that scanned only the table would report an empty batch while the
receipt names a valid pick.

```bash
gh issue view <n> --repo mento-protocol/monitoring-monorepo \
  --json number,title,state,labels,body,projectItems,blockedBy
```

`labels` settles `agent-ready`, `risk:low`, and the `pkg:*` area;
`projectItems[].status.name` settles `Blocked`; `body` is where an external
dependency is named; `blockedBy` is GitHub's own blocked-by relationship, and a
non-empty `blockedBy.nodes` is a rejection on its own. Read all three
blocked-ness sources: a dependency recorded only through the native
relationship appears in none of the others, so a projection that skipped it
would claim work still waiting on something. Only the fit cap comes from the
receipt.

`state` must read `OPEN`, and `--repo` is not decoration. A closed issue
otherwise passes every rule below and is refused only later by `issue:claim`,
after it has already been printed as part of the batch. An unqualified
`gh issue view` resolves against the current checkout's remote or `GH_REPO`, so
from a fork or a redirected environment it would grade a same-numbered issue in
a different repository while the receipt and the claim helper both target this
one.

Take the top N — default 2 — that satisfy **all** of:

- **`agent-ready`.** Never `needs-grooming`. `rank-backlog` ranks grooming
  issues and never Selects one; a sweep that claimed one would be doing the
  grooming itself, unattended, on the operator's behalf.
- **Exactly one `risk:*` label, and it is `risk:low`.** The batch runs without
  a human reading the diff before it is pushed. `risk:medium` and `risk:high`
  issues are exactly the ones where that gap matters, and the label is the
  repo's own judgement of which those are. Test for the whole set, not for the
  presence of `risk:low`: only state labels are mutually exclusive
  ([`agent-issue-workflow.md`](../../../docs/notes/agent-issue-workflow.md)),
  so an issue can carry `risk:low` and `risk:high` together, and a
  presence-only check would admit it while the sentence above excludes it. Two
  risk labels is also a grooming signal, not a tie to break.
- **Fit not authority-capped.** `rank-backlog` caps fit and names the cap when
  an issue needs a product decision, a credential the loop cannot reach, or an
  issue-specific human approval ahead of normal PR readiness. A capped issue
  cannot be finished by an unattended worker however well it scores, so it is
  ineligible here even at rank 1. The merge approval every PR needs is not such
  a cap — it applies to the whole batch equally.
- **Not blocked, by any of the three records.** Not projected to `Blocked` on
  the workboard, no non-empty `blockedBy` relationship, and not waiting on an
  external dependency named in its body. The three do not imply each other:
  a native blocked-by link needs no body sentence and moves no Project field.
- **Carries exactly one `pkg:*` label.** An issue with no package area makes the
  independence test below vacuous: it shares no label with anything, so two
  such issues both pass and then edit the same package. Multiple package areas
  are ambiguous and make the same independence check unreliable. Treat a
  missing or ambiguous package area as ineligible rather than as independence.
- **Mutually independent.** Two tests, in order: the label-independent
  docs-catalog test below, then the label test. No two issues in one batch
  share a `pkg:*` label —
  `pkg:dashboard`, `pkg:indexer`, `pkg:alerts`, `pkg:terraform`, `pkg:tooling`,
  listed in
  [`agent-issue-workflow.md`](../../../docs/notes/agent-issue-workflow.md).
  That label is the repo's own ownership area, so it settles "same subsystem"
  by lookup rather than per-batch judgement. Two workers editing one package
  produce PRs whose diffs conflict and whose reviewers see a base moving under
  them, and the second PR then pays for a merge, repeated author checks, and a
  fresh review round it did not need. `pkg:tooling` gets a path test instead of
  the label test, below.
- **Outside its own grooming veto window.** A candidate whose newest _trusted_
  `sweep-groomed:` marker comment is less than 12 hours old waits for the
  next run, whatever version that marker carries — the window asks whether a
  human has seen the labels, which does not depend on the payload shape, so
  matching `v2` only here would un-veto every issue the last run groomed. The
  skip key below does match `v2` only. The report names when that window
  closes. The window is a bounded
  chance for a human to disagree with a label an agent applied, before that
  label selects work for another agent. An issue a human labeled by hand
  carries no marker and is never delayed. An operator who wants to fast-track a
  groomed issue waits the window out or deletes the marker comment: a window
  its caller can waive is not a window.

  **A marker is a comment, so read it as untrusted input.** Measure the window
  from GitHub's `createdAt`, never from the marker's own `at` field, which its
  author chose. Count a marker only from an author who can set labels: the
  account the sweep authenticates as, or a login whose repository role is
  `triage`, `write`, `maintain`, or `admin`. `authorAssociation` is not that
  check — it names a relationship, so a read-only outside collaborator reads as
  `COLLABORATOR` and could renew a veto every twelve hours on an issue it
  cannot label. Ignore a marker that fails both tests or whose role lookup
  errors, and say so in the report.

  ```bash
  gh issue view <n> --repo mento-protocol/monitoring-monorepo \
    --json comments \
    --jq '.comments[]
          | select(.body | startswith("<!-- sweep-groomed:"))
          | {login: .author.login, created: .createdAt}'

  repo=mento-protocol/monitoring-monorepo
  gh api "repos/$repo/collaborators/<login>/permission" --jq '.role_name'
  ```

**The docs catalog is a pairwise conflict in every package.** Run this test
before the label test, on every pair, whatever labels the two candidates carry.
A candidate carries the catalog when its work adds, moves, or removes a
Markdown surface, changes any front matter of an existing one, or adds or
removes an internal link, because the catalog lists broken internal links
beside an entry per file. Only a body-prose edit that leaves the front matter
and every link alone is exempt, and a body whose documentation effect cannot be
read carries the catalog: nothing to compare is not evidence of no conflict.
Two candidates that both carry it are never independent.
[`context-standards.md`](../../../docs/context-standards.md) requires that
generated catalog to index every Markdown file and `pnpm docs:index --check`
fails while it is stale, so both workers regenerate `docs/README.md` and their
PRs conflict on that one file even when they share no package and no other
path. Scoping the rule to `pkg:tooling` would miss exactly that pair: a
`pkg:dashboard` issue adding a README beside a `pkg:indexer` issue adding one
passes the label test and then produces two PRs regenerating one catalog. Do
not restate which fields the catalog renders: `classifyDocumentation` and
`catalogEntry` in `scripts/context/docs-index-helpers.mjs` decide that, and any
list written here rots against them in silence.

**`pkg:tooling` takes a path test, not a label test.** That one label covers
`scripts/`, `docs/`, `.agents/`, `.claude/`, and the root tooling files, so two
candidates that touch nothing in common still share it and the batch loses a
slot to a conflict that is not there. Treat two `pkg:tooling` candidates as
independent when all three hold: each body names its expected files or
directories; no path either body names equals or contains a path the other
names, compared on whole path segments (`scripts/pr/` against
`scripts/sentry/` is disjoint, `docs/` against `docs/notes/` is not); and
neither names a shared root file or control root —
`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.trunk/**`,
`.github/workflows/**`, `scripts/agent-quality-gate.sh`, or `scripts/gate/**`.
Normalize the mirrored skill trees first, by path segments rather than by text:
a path whose first two segments are `.claude/skills` is read with those replaced
by `.agents/skills`, whatever follows and whether or not it ends in a slash. The
two are one collision surface, so an issue naming one and an issue naming the
other would otherwise pass a literal containment test and then produce two PRs
touching the same files. A candidate that carries the docs catalog above brings
`docs/README.md` into this comparison too, so it also conflicts with a
candidate that names that file outright.
A candidate with no path list conflicts with every other `pkg:tooling`
candidate: nothing to compare is not evidence that the paths are disjoint. Name
the independence basis in the printed batch for every pair that relied on this,
so the audit line records which paths were compared. Every other area keeps the
label test, and `pnpm issue:claim --sweep-eligible` enforces neither form — it
grades one issue's own labels and never sees the batch.

If fewer than N issues qualify, take fewer and say so in the report. Never
relax a rule to fill the batch. Zero qualifying issues is a valid result: write
the empty disposition table and name what the receipt held.

**Zero does not end the run.** An empty batch is the case grooming exists for,
so a 0-of-N run carries on to Groom The Queue For The Next Run below and writes
its report after that pass, not instead of it. Returning here would leave the
queue exactly as it was found, and the next run would find the same nothing.

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

**Re-read the body immediately before every claim.** Claims are sequential, so
minutes pass between selection and the last claim. Run the same live issue read
from the eligibility step against the specific issue immediately before its
claim. If the body now names an external dependency, do not claim the issue.
Record the change. Any replacement must follow the replacement rule below:
print it before claiming it and give it the same abort window as the original
batch.

Capture and print that read once, then hash the exact body from the same JSON:

```bash
issue_json="$(gh issue view "$issue" --repo mento-protocol/monitoring-monorepo \
  --json number,title,state,labels,body,projectItems,blockedBy)"
printf '%s\n' "$issue_json"
body_sha256="$(printf '%s' "$issue_json" | jq -rj '.body // ""' | \
  shasum -a 256 | awk '{print $1}')"
```

**Let the helper revalidate its part of eligibility.** `--sweep-eligible`
rechecks the open queue state, the exact `risk:low` and `pkg:*` sets, native
blockers, and the selected Project item's ID-bound `Blocked` status around the
label and ownership transition. It rejects every missing, changed, or `Blocked`
Status it observes. It never writes Status. Project Status is human-owned, so a
human change after the final observation remains visible and linearizes after
the claim. The receipt still owns the fit cap. The helper does not classify
free-form body text. `--body-sha256` binds the body that the orchestrator
classified to locked pre-transition and post-transition checks. An external
body edit after the final check remains visible because the helper never writes
the body. The custom mutex does not serialize that external editor.

**Claim the specific number with a stable owner token, and name the branch:**

```bash
pnpm issue:claim --issue <n> --agent <name> --branch <worker-branch> \
  --claim-id <claim-id> --sweep-eligible --body-sha256 "$body_sha256"
```

`--count` claims whatever the ready queue holds at that moment, which is not
the set the receipt selected — a race with any other session silently swaps an
issue in, and the report would then cite a receipt that never chose it.

`--branch` and `--body-sha256` are required with `--sweep-eligible`. Decide the
isolated worker's branch name before the claim. The helper rejects a sweep claim
before it takes the mutex when either value is absent. This prevents the
orchestrator's checkout branch from becoming the worker's durable owner value.

`<name>` is the runtime actually running the sweep — `claude` or `codex`. This
skill is mirrored to both stores, so a hard-coded name would file every Codex
sweep's claim under the wrong owner, and the claim comment and Project `Agent`
field are what a human reads to find the session holding an issue.

Generate one `<claim-id>` as `claim-<UUID>` before the command. Record it beside
the worker path in the sweep's durable state, and reuse it unchanged after an
interruption. It must satisfy the helper's 1-200 character token contract. Do
not derive a second token after a nonzero result; the stable value is how the
helper and the sweep distinguish this claim from another session's claim.

The helper serializes claim, review, release, sync, and backfill through one
persistent per-issue Git ref. All repo-owned writes to Claim ID, Agent, Branch,
Claimed At, and PR use that mutex. Direct external writes stay outside the
guarantee. Project V2 has no conditional field write. An external same-field
write in the read-write gap can be overwritten without detection. Stop all
helpers before manual owner-field repair. If an uncertain result leaves a stale
`LOCK`, stop and hand its ref, SHA, and payload to an operator. The operator must
prove that the original helper cannot resume before recovery. Do not delete,
force-update, or steal the lock.

**Read the claim result before briefing anyone.** The claim can lose a race —
another session can take the issue between the ranking that selected it and
this command. Spawn the worker only for a claim that succeeded. A worker briefed
on an issue this sweep does not hold duplicates whatever its real owner is
already doing.

**Retry one ordinary nonzero claim with the same token.** First inspect the
error. Never retry when it reports `ISSUE_MUTATION_LOCK_STALE`, an unknown mutex
outcome, a stale `LOCK`, or a candidate `LOCK` or `UNLOCK`. Stop the sweep for
that issue. An operator must prove that the original helper cannot resume, read
the current ref and board state, and complete the ADR 0082 recovery before any
retry. For an ordinary nonzero result, the helper uses the reserved Claim ID to
recover a valid `agent-active` claim. It verifies or creates the matching
trusted claim comment before it reports recovery success. If that retry also
fails and the Project
Claim ID still equals `<claim-id>` with a durable Branch, release that owned
partial claim to `needs-grooming` with the same token. Empty, missing, foreign,
or branchless Project ownership that recovery observes is not overwritten. The
owned mutex instead quarantines a still-ready failed issue in `needs-grooming`.
It preserves a newer non-ready label state. Report either state for operator
inspection. Do not infer ownership from the absence of a comment.

On a refused claim, leave the issue alone and record the loss in the report.
The refusal names only the label state it found —
`is not claimable; expected open agent-ready without agent-active/in-pr/needs-grooming`
— so re-read the issue for the report line. A holder exists only when it came
back `agent-active` or `in-pr`; take that holder's `Claim ID` from the project
field or the claim comment. When it closed or returned to `needs-grooming`
between the read and the claim there is no holder at all: record the state
change, and do not go looking for one — an old comment would name a session
that has nothing to do with this refusal. After a body-only pre-claim skip or a
refused claim, a replacement from the next eligible receipt entry is allowed.
**Print it before claiming it and give it the same abort window as the original
batch.** The printed batch is the audit record of what this sweep worked on,
and an unannounced substitute makes that record wrong. When the receipt is
exhausted, finish with the smaller batch.

**A claim the sweep cannot staff is released at once.** Spawning a worker can
fail — a runtime's concurrent-agent limit, a transient error — and the issue is
already `agent-active` by then. Release it immediately with
`pnpm issue:release --issue <n> --claim-id <claim-id>`, comment why, and record
it in the report.
Leaving a claimed issue with no worker parks it where nothing will pick it up.
This is also the reason the batch is claimed one issue at a time: the failure
costs one release rather than the whole batch.

Then spawn one worker subagent per issue. Give each a brief containing:

- **Its own checkout.** Clone to `/private/tmp/claude/sweep-<issue>`, with
  `issue` holding the number:

  ```bash
  repo="$clone_url"                 # the orchestrator's own origin URL
  root=/private/tmp/claude
  if ! mkdir -p "$root" 2>/dev/null || [ ! -w "$root" ]; then
    root="${TMPDIR:-/tmp}/claude-sweep"   # unwritable default: fall back
    mkdir -p "$root" 2>/dev/null || exit 1
    [ -w "$root" ] || exit 1              # the fallback gets the same proof
  fi
  dir="$root/sweep-${issue}"

  [ -n "${worker_dir:-}" ] && dir="$worker_dir"   # respawn: use it verbatim

  if [ -e "$dir/.git/sweep-owner" ] &&
     [ "$(cat "$dir/.git/sweep-owner")" = "$sweep_id" ]; then
    :                               # this sweep's own checkout: resume in it
  else
    if [ -e "$dir" ]; then          # someone else's or unproven: fresh path
      for n in $(seq 2 50); do
        if mkdir "$dir-$n" 2>/dev/null; then dir="$dir-$n"; break; fi
        [ "$n" -lt 50 ] || exit 1   # never reuse a path you did not allocate
      done
    fi
    git clone "$repo" "$dir" || exit 1  # never mark a clone that failed
    printf '%s\n' "$sweep_id" > "$dir/.git/sweep-owner" || exit 1
  fi
  cd "$dir" || exit 1                   # everything after this runs here
  ```

  **`$dir` is the working directory for every later command, not just the
  clone.** `git clone` does not move the shell, and a worker can inherit the
  orchestrator's directory, so setup, the branch, the edits, the author checks,
  and the push would all run in the orchestrator's checkout — the one tree this
  whole scheme exists to keep workers out of, and the one the preflight requires
  to stay clean. A shell that does not persist between calls does not make this
  optional: every fresh shell re-enters `$dir` first, and no worker command is
  ever issued from an unstated directory.

  `clone_url` is the orchestrator's own `git remote get-url --push origin`,
  fixed once and passed to every worker beside `sweep_id`. Take the **push**
  URL specifically: `git clone` copies no remote config, `pushurl` included, so
  where a checkout's fetch and push URLs differ a worker cloned from the fetch
  URL passes its checks and then pushes somewhere nobody is watching. `--push`
  returns `pushurl` when one is set and the fetch URL otherwise, so it is right
  either way. Do not hard-code the public HTTPS URL. A worker must push, not
  merely clone, and the transport that
  already authenticates on this machine is the one the operator's checkout is
  using — often SSH, while `gh auth status` says nothing about git's credential
  helper. Cloning over a transport nobody has credentials for succeeds on a
  public repository and then fails at the push, after the whole issue has been
  implemented and validated.

  `worker_dir` is set only on a respawn, to the path the orchestrator recorded
  for this worker. Use it verbatim; do not re-derive. A worker displaced to a
  suffixed path would otherwise start from the base name, fail `mkdir` on its
  own directory, and clone a fresh one — abandoning the branch, commits, and
  open PR that the resume duty exists to keep.

  `sweep_id` is one value the orchestrator fixes before the first claim and
  passes to every worker — this session's id is the obvious choice, and any
  string is fine as long as one sweep never reuses another's. Write it right
  after the clone: the marker is what the next run reads, so a clone that
  skipped this step can never be resumed, only abandoned for a fresh path.

  Write it only after a clone that **succeeded**, which is what the `|| exit 1`
  buys. The existence check and the clone are two steps, so another sweep can
  take the same deterministic path in between; this clone then fails into a
  directory that is not empty, and an unconditional marker write would stamp
  this sweep's id over the owner file of a checkout someone else's live worker
  is committing from — handing away the tree the rest of this section exists to
  protect.

  Create the parent first, and prove it writable rather than assuming it.
  `git clone` does not create intermediate directories, and the sweep root is
  not guaranteed on a fresh machine or in the Codex runtime this skill is also
  mirrored into — so a missing or read-only parent fails the very first command
  of every worker. `mkdir -p` alone does not settle it: it succeeds on a
  directory that already exists and cannot be written.

  The fresh path is allocated with `mkdir`, not stamped with a timestamp. Two
  workers displaced in the same second would derive the same `-$(date +%s)`
  name, and `mkdir` is the atomic claim that makes the loser take the next
  suffix instead.

  Claude subagents cannot use sibling worktrees, so use isolated tmp clones. Use
  the operating-card preflight to bind `BASE_REMOTE` and `baseRefName` to the
  fetched PR base, or verified `origin/main` without a PR. Inspect `git status --short`,
  `git diff "$BASE_REMOTE/$baseRefName"...HEAD`, `git diff --cached`, `git diff`,
  and untracked files. Inspect lifecycle and install effects for manifests,
  lockfiles, pnpm configuration, or patches; stop if the scope is unclear.

  Run `./scripts/setup.sh` in every resumed clone only after that inspection. In
  a fresh clone, fetch and run `git switch --detach origin/main` before setup.
  Setup prepares the staged formatter, dependencies, codegen, and browser tools;
  its markers make unchanged reruns cheap.

  Branch as **the exact name the orchestrator passed to `issue:claim
--branch`**, from `origin/main`. That name is already in the Project `Branch`
  field and the claim comment, and the release guard looks for an open PR with
  `--head` that name. A worker that invents its own leaves all three pointing at
  a branch nobody pushed, and the guard then reads "no open PR" and releases an
  issue that has one.

  **The path is deterministic, so check it before cloning.** The same issue
  number produces the same directory, and `git clone` fails outright into one
  that already exists — from an interrupted run, or from an earlier sweep of an
  issue that was released and later re-selected. Resume it only on proof it is
  this sweep's own, which is what the `sweep-owner` comparison above decides.
  Keep the marker inside `.git/` — a file at the clone root would be untracked
  in every worker checkout, where a clean-worktree check can refuse shipping or
  broad staging can commit the marker into the PR. Remote and
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
  retained pre-commit hook formats staged files, and the required Code Quality
  check enforces formatting in CI.
- **The author checks:** Apply step 3 of the
  [operating card](../../../docs/notes/pr-operating-card.md). Inspect any
  manifest, lockfile, pnpm configuration, or patch change before the first
  package-manager command. Run the selected direct commands in the order that
  step defines. Record every result as `passed`, `failed`, or `not run` with its
  reason. The legacy quality gate is diagnostic and is not the normal worker
  path.

  Start a long author check with the runtime's background mechanism and poll it
  to completion inside the same turn. Judge the command by its exit status,
  never by the tail of its log. A worker that ends its turn while a check is
  still running has no one left to record the result. A failed required check
  blocks the ready handoff as the operating card specifies.

- **The closeout**, chosen by the runtime the worker is in. Outside an active
  Codex session, bare `pnpm agent:autoreview`; when the codex engine is
  unavailable, `pnpm agent:autoreview --engine claude`, with the `claude` CLI's
  install directory prepended to `PATH` — a worker subagent does not always
  inherit the interactive shell's `PATH`, and the fallback engine then reports
  as unavailable too. **Inside an active Codex session the bare command is not
  the closeout**: it silently selects the local deterministic engine, so no
  separate reviewer sees the bundle. Use the prepared-bundle fresh-context flow
  with its manifest checks before and after review, which
  [`pr-operating-card.md`](../../../docs/notes/pr-operating-card.md) owns — this
  skill defers to it rather than carrying a second copy of the commands.
  Address the real findings; an unexplained strengthening of a validation claim
  is itself a finding, and testing those claims is the worker's own job, not
  the bundled reviewer's.
- **The ship:** full repo PR template, all four sections, **ready for review,
  never a draft**. A draft disables CodeRabbit auto-review and the PR
  description check, so it is skipping review rather than staging it. Then
  `pnpm issue:review --pr <pr> --issue <n>`.
- **The babysit:** sweep every feedback surface — top-level comments, review
  bodies, inline threads, annotations, failing logs. **Batch fixes into single
  pushes**, because every push costs another Codex review round. Reply before
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

**Re-invoke a worker that has gone quiet.** Each worker polls its own author
checks and push inside its turn, so the orchestrator holds no timers and watches
no pids. It owns the case in-turn polling cannot reach: a worker whose task
notification shows it parked at a turn end, or whose last report has gone stale
while its siblings advance.
Send that worker a message naming where it stopped and what to do next. Nothing
else re-invokes a subagent that has already ended its turn.

**Collect each worker's report-back.** The report is the orchestrator's to
write, but five of its facts exist only inside a worker's turn — the verbatim
ready-state line, the release form and reason, the deferral issues, the
operator-decision items, and any checkout conflict. Record each closing message
as it arrives. A worker that finished without one is not done: ask it for the
missing facts before writing the report, because nothing on disk reconstructs
them afterwards.

**Keep concurrent author checks within the local resource bound.** A batch of
four runs at most three ordinary command-heavy check sets at once. Hold the
fourth until one finishes. Run dashboard coverage or scoped related tests, browser work,
production builds, and size-limit work without another command-heavy check set.
Other workers can keep editing while that set runs. This is a sweep schedule,
not a global gate lock. Each worker owns its own clone, so no package-manager
process can recreate or invalidate another's `node_modules`.

**Serialize the instructions so two workers never share a checkout.** Each
worker owns exactly one clone and one branch, and no instruction ever names
another worker's path. A repair applied through the wrong checkout lands on the
wrong branch, and the worker that owns it will not notice.

**Resume workers after a usage-limit interruption; never restart them.** The
worker's clone still holds its branch, its claim, and often an open PR. A
restart re-claims an issue that is already `agent-active`, repeats completed
author checks, and can open a second PR for the same branch. Wait for the
limit to reset, then wake the existing worker where it stopped.

**Record each worker's allocated path, and pass it back as `worker_dir` on any
respawn.** Waking a worker is not the only way one comes back; after a crash it
is spawned fresh, and then only the path you hand it keeps it off a new clone.

**Direct a reclassification after five review-triggered patch cycles.** The
operating card allows five and requires a pause before a sixth. At that point
tell the worker to stop patching and classify what is left, honestly, in one of
three ways: an evidence-backed won't-fix; a deferral with its issue filed and
linked from `## Deferrals`; or — for a finding that is valid, in scope, and
genuinely still required — a hand-off. A required fix is neither a won't-fix
nor a deferral, and mislabelling it to end the loop is the failure this rule
exists to prevent. A handed-off PR goes in the report as an operator decision
and is **not** reported as READY, whatever its ready-state line says. A
converging bot loop costs a review round per push and does not end on its own,
but neither does an unfixed defect.

## Groom The Queue For The Next Run

Run this after the batch is claimed and every worker is spawned, and before the
report — including when the batch came out empty, which is the case grooming
exists for. Nothing this pass labels can be selected by this run: the
eligibility step has already finished. Never move the pass earlier and never
re-run selection after it. Ordering alone is not the whole guard, though, which
is why **the pass never writes a label that leaves an issue sweep-eligible**:
the veto is passive and the next run is the same agent population, so writing
one would be the root [`AGENTS.md`](../../../AGENTS.md) rule against widening a
control that blocks your own work, one run later. Narrowing is free.

The full procedure is
[`backlog-sweep.md`](../../../docs/notes/backlog-sweep.md). The operative steps:

1. **Pin the tree, then order, filter, and cap at 10.** Fetch `origin/main` and
   pin one OID for the whole pass before any candidate is read; every path read
   below, the skip key's digests included, uses that one tree. The pass runs
   long after Preflight, so it pins its own OID rather than inheriting
   Preflight's, and the marker records it.

   ```bash
   git fetch "$(git remote get-url --push origin)" main
   oid="$(git rev-parse FETCH_HEAD)"   # the commit this fetch just wrote
   git rev-parse "$oid:<path>"         # one blob or tree id; non-zero when absent
   ```

   Fetch the validated push URL, not the remote name. Preflight verifies both
   effective `origin` URLs. A remote carrying a `pushurl` fetches from a
   different URL than it pushes to, so naming the validated push URL here binds
   this later tree read to the canonical repository the sweep publishes to.

   Pin `FETCH_HEAD`, not `origin/main`: a fetch by URL updates no
   remote-tracking ref at all, and a clone made with `--single-branch` on
   another branch has no `refs/remotes/origin/main` to read either, so
   `git rev-parse origin/main` fails after the batch is already claimed.
   Address each path as `<oid>:<path>`, not with `git ls-tree`: a body may name
   a directory with a trailing slash, and `git ls-tree "$oid" -- docs/notes/`
   lists that directory's children rather than its one tree id, while
   `git rev-parse "$oid:<path>"` returns one id for a file, a directory, and a
   directory with a trailing slash, and exits non-zero when the path is absent.

   Order by `rank-backlog` score, highest first, then by issue number, newest
   first; the
   outside-the-queue set carries no score and so sits behind every scored
   candidate. Two sets qualify: `agent-ready` issues lacking exactly one
   `risk:*` or exactly one `pkg:*`, and issues with no queue-state label read
   from the roster the ranking already fetched. Drop every bot record —
   anything authored by `app/github-actions` or carrying `drift-detection`,
   `sentry-triage`, a `sentry:*` label, `dependencies`,
   `security-advisories`, or `file-size-watchlist`. Then walk that order and
   test the skip key below as you reach each candidate, stopping at the first 10
   survivors; the test costs one comment read each, so walk it lazily rather
   than pre-filtering the whole queue. The cap bounds grooming attempts, not
   candidates examined: capping first would let ten unchanged high scorers hold
   every slot run after run and starve the rest of the queue. The read cost is
   therefore bounded by the candidate set rather than by the cap, so report how
   many candidates the walk examined beside how many it groomed. Do not add a
   fixed ceiling on candidates examined: the walk order is stable, so a hard
   stop at the same depth every run never reaches the tail. Count every skipped
   candidate in the report.

   **The skip key has four parts**, read from the candidate's newest trusted
   `sweep-groomed:v2` marker. Skip only when all four hold: the body digest
   still matches; the marker's `paths` map still matches, path for path and
   digest for digest, at the OID pinned above; the issue carries every label in
   the marker's `applied` list; and the issue's current `risk:*`,
   `pkg:*`, `kind:*`, and queue-state labels equal the marker's `labels`
   snapshot plus its `applied` list — the same four label classes on both sides,
   because those are every class the pass writes into `applied`, and a class
   present on one side only makes the test fail for ever. Each guards a
   different way the verdict goes stale. The body is what the pass read. The `paths` map is the rest of it — a named path that was
   absent then and exists now, one since deleted, and one whose contents changed
   under a stable name all change the answer. Missing `applied` labels mean a
   write failed after the comment landed, so retry rather than skip for ever.
   The `labels` snapshot is what makes a human's correction reopen the issue:
   a pass that stopped on two `risk:*` labels writes `applied: []`, and without
   the snapshot the empty-subset check would succeed vacuously and strand the
   issue after a human removed one of them. Compare the body, never `updatedAt`
   — posting the marker updates the issue, so a timestamp test would compare
   the pass against its own write. A `v1` marker never satisfies the key: it
   carries no `labels`, no per-path digest, and no resolution ref, so every
   issue groomed under `v1` re-grooms once.

2. **Read the body, then read the paths it names against the OID pinned in
   step 1.** Read every path as `<oid>:<path>` against that OID, never from the
   session checkout. Labels are repository-wide state and
   the checkout is session-local:
   a sweep started from a clean feature branch would otherwise classify live
   issues against that branch's tree, and since the pass never removes or
   downgrades a label, a wrong `pkg:*` cannot be retracted later. The marker
   records the ref and the OID, so a reader can tell what a verdict was based
   on. The labels come from what that tree holds, not from what the body claims.

3. **Decide the labels.**
   - `pkg:*` — every area the named paths fall in. Several labels when the
     issue genuinely spans packages, which keeps it correctly labeled and
     sweep-ineligible; none when the body names no path. A single area that
     would complete eligibility is proposed, not written.
   - Before every write, work out the label set it would produce. When that set
     satisfies the sweep predicate — `agent-ready`, exactly one `risk:*` equal
     to `risk:low`, exactly one `pkg:*` — put the label in `proposed` instead
     and let a human apply it. Which label completes eligibility depends on what
     the issue already carries: the `pkg:*` for an issue already holding
     `risk:low`, the `risk:low` for one already holding a package area.
   - `risk:*` — one, only when the issue carries none. Write `risk:medium`, or
     `risk:high` for secrets, IAM, a production apply, or deploy identity; both
     narrow. `risk:low` is always proposed, with the
     [Low-risk rule](../../../docs/notes/agent-issue-workflow.md#low-risk-rule)
     clause behind it. Read that rule at its anchor, never from memory; when it
     cannot be read, propose nothing and say so. Never remove or downgrade an
     existing risk label. Write nothing at all on two issues, naming the reason
     in the marker: one already carrying two risk labels, and one carrying
     `risk:low` whose verified paths touch secrets, IAM, a production apply, or
     deploy identity — completing its `pkg:*` routing would hand a worker the
     issue that label misdescribes.
   - `kind:*` — one, when the work type is obvious.
   - State — write none. Queue-state labels are serialized behind the ADR 0082
     per-issue mutex and `gh issue edit` does not take it, so a raw write
     against a roster snapshot can land `needs-grooming` beside an
     `agent-active` a claim added a moment earlier. Propose the state instead —
     `needs-grooming` for an unlabeled candidate, never `agent-ready` — and let
     an operator or a mutex-owning helper apply it. Write no Project field.

4. **Post the marker comment, then write the labels — in that order, on every
   issue.** The two writes are separate API calls, and a label that lands with
   no marker is an issue the next sweep can select with no veto window at all.
   Marker first means the failure that costs something is a marker with no
   labels: harmless, and visible in the report. If the comment cannot be
   posted, write no label for that issue.

   ```text
   <!-- sweep-groomed:v2 {"sweep":"<sweep_id>","at":"<ISO-8601 UTC>","ref":"origin/main","oid":"<40-hex>","body":"<sha256>","paths":{"<path>":"<blob or tree sha>"},"labels":[...],"applied":[...],"proposed":[...]} -->
   ```

   `ref` and `oid` name the tree the paths were resolved against. `body` is the
   SHA-256 of the issue body this pass read. `paths` maps each named path that
   resolved at that OID to the one id `git rev-parse "<oid>:<path>"` returns,
   so a file whose
   contents changed under a stable name invalidates the marker; only paths the
   body names are covered. `labels` snapshots the issue's `risk:*`, `pkg:*`,
   `kind:*`, and queue-state labels as read, before this pass writes anything —
   every class the pass can write, so the skip key compares like with like.
   `applied` lists the labels the next call writes; `proposed` lists everything
   the pass judged right and will not write itself — a `risk:low`, the state
   label the mutex owns, the `agent-ready` promotion, workboard enrollment, and
   a risk label withheld from a contradicted or double-labeled issue. `at`
   records when the pass ran, for a human reading the comment; the veto window
   is measured from GitHub's `createdAt` instead, on a trusted author's comment
   only. Then, in prose: the labels applied, the paths checked, the Low-risk
   rule clause behind the risk verdict, and — for an unlabeled issue — whether
   the body already meets the agent-ready bar of goal, acceptance criteria,
   expected files, and a verification command. Say there too when the issue is
   absent from the workboard: `hasSweepClaimAttributes` needs an exact
   non-Blocked Project status, so promotion alone would not make it claimable.

   ```bash
   gh issue edit <n> --repo mento-protocol/monitoring-monorepo \
     --add-label pkg:tooling --add-label risk:medium --add-label kind:workflow
   ```

   No issue-board helper writes routing labels: `issue:claim`, `issue:review`,
   and `issue:release` move state labels and Project ownership fields only.

5. **Record a failure and continue.** A rate limit, a missing label, or a path
   read that errors is recorded against that issue; the pass moves to the next
   candidate and never blocks the report. A label write that fails after the
   marker landed gets one follow-up comment naming the label that did not land —
   the marker stays, so the veto window still holds.

## Hard Boundaries

These are MUST-level. A sweep runs unattended, so a boundary crossed here is
crossed without anyone watching.

- **MUST NOT merge.** Green CI, a READY ready-state, and a batch that finished
  early are not merge approval. The sweep ends at READY and gives the operator
  the PR links. A human can open those links and merge in the GitHub UI.
- **MUST NOT weaken or widen a control that blocks the run.** Root
  [`AGENTS.md`](../../../AGENTS.md) states it: never weaken a control that
  blocks your own work, because an agent that can widen its own gate has no
  gate. A required author-check or CI failure, a failing hook, a denied
  permission, or a sandbox block is reported and handed to an independent
  session — never edited away by the worker it is blocking. Reclassifying the
  blocking change as a separate task does not qualify.
- **MUST NOT bypass retained hooks.** No `--no-verify` or hook-skipping
  environment variable.
- **MUST release a bad pick honestly.** An issue that turns out misgroomed, or
  a worker that stalls with no path forward, releases the issue rather than
  leaving it parked in `agent-active`:

  ```bash
  pnpm issue:release --issue <n> --claim-id <claim-id>
  pnpm issue:release --issue <n> --claim-id <claim-id> --needs-grooming
  ```

  Post a comment on the issue saying what the worker learned — what it tried,
  where it stopped, and what a human would need to decide. A silent release
  sends the next run straight back into the same wall.

  The helper accepts only that Claim ID on `agent-active`. It refuses `in-pr`
  and repeats the claimed-branch PR proof before and after each write and after
  its final state reads. If a PR appears before the final proof, the helper
  normally restores the prior active state and exact ownership snapshot. If a
  `--needs-grooming` release already reached the exact grooming state with
  empty ownership, recovery preserves that completed non-ready endpoint. The
  helper exits nonzero in either case. A PR can still open after the final proof
  because GitHub exposes separate APIs. The canonical lifecycle in
  [`agent-issue-workflow.md`](../../../docs/notes/agent-issue-workflow.md)
  releases _after_ an unmerged PR closes. A worker that stalls with an open PR
  keeps `in-pr` and hands the PR to the operator as a decision item.

  After the operator closes that PR unmerged, release through the stored
  PR/repository/branch proof:

  ```bash
  pnpm issue:release --issue <n> --claim-id <claim-id> --closed-unmerged-pr
  ```

  Add `--needs-grooming` when the remaining work is unclear. This explicit path
  refuses a merged PR and any open replacement PR from the stored branch.

  If the operator instead merges a partial-stage PR and the issue remains open,
  revise the ordinary issue body's remaining scope, then use the separate
  post-sweep continuation:

  ```bash
  pnpm issue:release --issue <n> --claim-id <claim-id> --merged-pr --needs-grooming
  ```

  This path proves the exact stored merged PR and refuses an open replacement.
  It never restores `agent-ready`. The sweep has already stopped at READY and
  never performs the merge or this post-merge operator action.

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

Seven parts. Every fact is recorded by whoever performed the action: the
orchestrator for the receipt, for the refused claims, for the grooming pass, and
for anything else it did itself — releasing a claim it could not staff, say; the
worker's closing message for everything that happened inside its own turn.

**Every claimed issue gets a row, reported back or not.** A worker can end
without its closing message and without answering the request for one. That
does not remove the row: write it from what the orchestrator does know — the
issue, the branch, and the PR if one exists — say plainly that the worker did
not report, and list it under the operator's decisions. A silently missing row
would read as an issue that was never claimed, while the claim is still on the
board.

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
   issue, why it was refused, and the receipt entry taken instead. The reason is
   either a holder — give its `Claim ID` — or a state change between the read
   and the claim, which has no holder to name. A refused claim never becomes a
   disposition row, because no work was done on it; omitting it entirely would
   hide that the batch shrank.
4. **Deferral issues filed**, by number, each with the PR it came from.
5. **Checkout conflicts**, one line per worker that found its deterministic
   clone path already taken and moved to a fresh one, naming both paths. The
   path it left is deliberately unexamined, so this line is the only record
   that something is still sitting there.
6. **Anything needing the operator's decision** — a blocked control, a
   misgroomed issue, a finding the worker could not adjudicate.
7. **Groomed for the next run.** State two run-wide facts above the table: the
   `origin/main` OID every path was read against, the same value the marker
   carries, so a verdict is reproducible from a named ref; and how many
   candidates the walk examined. Each is one value a run, so neither is a
   column. The table is
   `Issue | Labels applied | Proposed for a human | Rule basis | Veto ends`.
   `Proposed for a human` is the column an operator acts on — a `risk:low` the pass may not write, the
   state label the mutex owns, workboard enrollment, an `agent-ready` promotion
   the body already deserves. `Rule basis` names the Low-risk rule clause behind
   the risk verdict, and on a skipped or re-groomed row it carries the reason
   instead. `Veto ends` says when the window closes, not
   when the issue becomes selectable: an unapplied proposal, a `risk:medium`, or
   several `pkg:*` labels keep it ineligible whatever the clock says. Name the
   remaining requirement beside the time whenever one applies. List candidates
   skipped against their last marker with the reason, and candidates re-groomed
   because the key broke with what broke it — the changed path, the label a
   human moved, or a `v1` marker. A stuck issue and a re-read one are both
   visible that way. Write the section with a `none` row when the pass groomed
   nothing — an empty candidate set and a pass that never ran read identically
   once the section is missing.

Print the same summary to the terminal; the file is the artifact, the terminal
output is its summary.

**End with the READY PR links**, one URL per PR that reached READY and nothing
for the rest. A human can open each link and merge in the GitHub UI. Listing a
link is not merge approval, and this skill never merges.

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
