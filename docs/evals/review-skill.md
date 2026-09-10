---
title: Review Skill Evaluation
status: active
owner: eng
canonical: true
last_verified: 2026-09-09
doc_type: runbook
scope: ci/process
review_interval_days: 90
garden_lane: operator-runbooks
---

# Review skill evaluation

This evaluation measures whether the `review` skill still finds real defects in
real pull requests from this repository. It replays nine merged PRs at the
commit they had before review, runs the reviewer against them, and scores the
result against the defects that human-reviewed CI bots actually raised and the
author actually fixed. It runs on a developer Mac under launchd; CI never holds
a model credential and only checks that the committed ledger is fresh and
internally consistent.

## The exam and the answer key

Each fixture is an **exam paper**: a detached checkout of the monorepo at a
pull request's first head, with `base` as a local branch and every later commit
genuinely unreachable. `scripts/review/build-fixture.sh` deletes every other
ref, removes the remote, expires the reflog, and then asserts that the fix
commit fails `git cat-file -e`. A reviewer that can reach the fix commits, the
review threads, or the merge is taking a memory test, not a review.

The **answer key** is `docs/evals/review-skill-truth/pr-<n>.json`: the defects
four independent CI reviewers raised on that head and the author then fixed.
It was harvested on 2026-08-21 for six PRs and on 2026-09-04 for three more,
and frozen as bytes each time. It is never
re-derived from the GitHub API, because comments get edited, bodies get deleted
and bots get renamed. The contract records a `sha256` for every truth file.

`scripts/review/review-eval-harvest-truth.mjs` harvests a new key, keeping the
2026-08-21 severity rule, key order and byte style. Six rules differ from that
`extract_truth.py` harvest, so its keys are not byte-comparable with the six it
froze. The first head is the earliest submitted bot review's `commit_id`, not
`commits[0]`, because a bot raises a finding against the head it read. Findings
are that head's bot-authored root comments alone, and the tool prints how many
it dropped for sitting on a later head, because that count moves the
denominator. Dispositions read only the pull request author's replies, so a bot
quoting `Fixed in` no longer marks a finding fixed. Title and body are derived
after `<details>` blocks, HTML comments and a leading CodeRabbit badge line are
stripped, so a collapsed analysis chain cannot push the finding statement past
the 2500-character body cut; severity still reads the raw body, where the badge
lives. `base_sha` is `git merge-base <first head> <the PR's base ref>` with
that ref fetched through `--src`, not the moving `meta.base.sha`. Pages come
from `gh api --paginate --slurp` and are flattened as values, so a body holding
`][` survives. Two independent bots sometimes raise one defect twice; the
harvester cannot tell, so a curator adds `"duplicate_of": <earliest id>` to the
later record afterwards, and `--check-fixtures` refuses a `scorable_ids` or
`p1_ids` entry that names it, a `duplicate_of` that names no finding in the
same file, its own finding, or another duplicate. A truth file's `counts` is
the raw harvest total and predates those hand-added marks, so the scorable
denominator is the contract's `scorable_ids`, not `counts`. The six 2026-08-21
keys are not re-harvested here, so they still carry findings raised on later
heads: issue 2289 tracks re-harvesting them and the denominator change that
would follow.

The answer key never travels with the exam. It lives on `main`; the fixture is
a detached checkout at a 2026-08 commit and is materialized under
`~/.cache/mento-review-eval/`, outside every monorepo working tree. That
structural separation is the strongest leak control.

Everything else is **defense in depth, not containment**. A cell runs with
`Bash` under `bypassPermissions` and with the network open, because the model
API has to be reachable, so nothing here stops a determined contestant from
looking. What the harness does do: every cell runs under `env -u GH_TOKEN -u
GITHUB_TOKEN -u GITHUB_PERSONAL_ACCESS_TOKEN -u GH_ENTERPRISE_TOKEN`, with
`GH_CONFIG_DIR` pointing at an empty directory, with a `gh` that refuses first
on `PATH`, and with git stripped of its global and system config, its
credential helper, its terminal prompt, its askpass and every protocol but
`file`. The fixture is reset with `git reset --hard` and `git clean -xdff`
before every cell, so no cell reviews the previous cell's edits. `--score`
flags a transcript that names the PR number, one of its reviewers, or one of
the commits withheld from the fixture — the last is what a successful fetch of
the answer key leaves behind. Reviewer logins that already appear in the
fixture's own tree are excluded from that check, because quoting the line under
review is what the prompt asks for. The durable control would be a per-cell
network sandbox that allows only the model hosts; until that exists these are
speed bumps, and a leak has to be careless to trip them.

The scorable defect ids are frozen explicitly in
`docs/evals/review-skill-fixtures.json`, not recomputed from a predicate. A
later parser change must not be able to move the denominator quietly.
`--check-ledger` holds every committed row to that: a condition that scored a
PR at all carries every defect id that PR froze, so no row can drop one and
report recall over the smaller denominator.

## What one run measures

Three conditions, every one of them load-bearing:

| condition  | what it runs                                          | how many cells                                  | why it exists                                                          |
| ---------- | ----------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| `pipeline` | live `codex exec review` then `claude` with the skill | one draw of each of the nine fixtures           | the number of record; exactly what production does                     |
| `replay`   | the frozen finder report then `claude` with the skill | both frozen reports of each of the six grid PRs | zero finder sampling variance; the verifier is still sampled fresh     |
| `control`  | the bare pinned model, no skill, no codex             | one draw of each of the six grid PRs            | if control and pipeline fall together the model moved, not our tooling |

`control` is the cheapest line item and carries the most interpretive weight.
Cut it last.

**Why 27 cells and not 39** (2026-09-09,
[ADR 0090](../adr/0090-canonical-eval-matrix-freshness-floor.md)).
Until 2026-09 a full run took two live `pipeline` draws of every fixture and a
`control` cell on all nine, which is 39 cells, about $145 of contestant spend
and about $155 more for the judge pass — the judge pass alone ran about six
hours. The second live draw was there because
the finder samples — one codex configuration drew 19 and then 10 known defects
on identical diffs — but two points do not measure that spread, and they do
not remove it either: the scorer folds a condition's draws with OR, so the
second draw only damped the noise. Ranking two skills is the experiment lane's
job, and the lane holds the finder fixed to do it: every draw of a lane replays
one frozen report through both arms
([ADR 0086](../adr/0086-review-eval-lane-any-grid-multi-draw.md)). The
canonical row is a freshness floor and the baseline anchor, so it now buys one
live draw per PR.

`control` narrowed to the grid for the same reason: it is read as a paired
per-defect difference against the previous run's control, and the grid's 39
defects carry that comparison. The three non-grid fixtures — PRs 1982, 1984
and 2001 — stay in `pipeline`, where they widen the wrong-claims and leak
surface.

Two things follow. `pipeline` now records one bit per defect, so its number is
a single live sample that carries the finder's spread. The verdict rules still
call six net flips RED or PROMOTE, and finder sampling alone can reach that on
a run where nothing changed, so **read a `pipeline` flip beside `replay`**:
`replay` runs frozen reports, so it does not move with the finder — though its
own verifier session is sampled fresh like any other, so it is quieter than
`pipeline`, not silent. A `pipeline` flip it does not corroborate is unproven
rather than a regression. On the PROMOTE side the harness holds you to that:
an uncorroborated `pipeline` gain is GREEN, so it never re-anchors the
baseline.
And `control` recall is now measured over the 39 grid defects while `pipeline`
recall covers all 51, so the two rates are over different denominators: read
`control` against the previous run's `control`, never as a within-run
subtraction from `pipeline`.

Per condition the run records recall, P1 recall, novel-real count,
wrong-claims count, dollars, seconds, and a per-defect bit vector for every
draw. The bit vector is the load-bearing field: every later comparison runs on
committed booleans, so no model is ever re-invoked to compare two months. A
condition's dollars are its contestant cells alone; what the judges cost is
recorded once per row as `scoring_usd`, and the report prints both.

A cell is scored on its session, not on its last message alone. The CLI's
single-shot envelope carries only the last one, so a reviewer that filed its
report, ran one more tool call and then posted a short addendum was scored on
the addendum. Each lane captures the session stream instead and rebuilds the
transcript from the assistant messages, in order, joined by a blank line.

Capture is budgeted, and the budget is the judges'. The claim splitter reads the
first 40 000 characters of a transcript and the match judge the first 30 000, so
a session long enough to push its report past those cuts was judged on the notes
that came before it. The transcript therefore starts at the final message and
adds whole earlier messages, newest first, while the total fits in 30 000
characters — the smaller of the two limits, defined once in
`review-eval-stream.mjs` and read by the scorer, so capture and judging cannot
drift apart. The final message is never dropped and never split: one that
exceeds the budget alone is kept whole and the scorer truncates it as before. A
cell records `assistant_messages` and `assistant_messages_kept`, so a trimmed
session is visible after the fact. A sub-agent's own messages stay out: they are
the reviewer's internal delegation, not the report it filed. Judge calls keep
last-message semantics, because a judge's answer is its final message. Scoring
the session also means an interim note the reviewer later retracted, when it
fits the budget, is extracted as a claim like any other: a move in
`wrong_claims` after this change can come from that, not from the skill.

A condition counts a PR as zero-finding only when every draw that completed
for that PR emitted no parseable claim. One empty draw beside a productive one
is sampling variance, not a condition that found nothing.

## Run it

Validate the deterministic contract first. Neither command calls a model.

```bash
pnpm review:eval -- --check-fixtures --offline
pnpm review:eval -- --check-ledger
pnpm review:eval:test
```

The append-only comparison runs against `git merge-base origin/main HEAD`, and
falls back to the `origin/main` tip when no merge base resolves. CI and the
gate add `--require-base`, which fails the check when the base ref does not
resolve at all, so the guard can never turn itself into a silent no-op.

Required CI, the advisory freshness workflow, and the local quality gate add
`--revalidate-appended`.
It recomputes every row the branch adds from the detail the same branch commits.
This check verifies consistency, not authenticity. It rejects missing evidence
and mismatches between the row, plan, scored results, and calibration. It does
not prove that a model produced the committed results. A pull request author
can create a mutually consistent evidence set. The author can also change the
branch-run validator in the same pull request. Git makes both changes visible
for review, but the check does not resist a hostile author. PR review owns this
boundary. Hostile-author resistance requires a protected validator and
execution evidence that the pull request author cannot change.

Schema, id coverage and
append-only history all stay satisfied when a ledger PR edits its own row's
verdict, counters or `per_defect` bits after the local `--validate --append`,
and this is the only PR workflow there is. Like `--require-base` it refuses to
no-op: with no base it cannot tell which rows are new, and it says so instead
of passing. It calls no model — the recompute reads the committed
`result-*.json` and `calibration.json` files — so the workflow stays free of
model credentials. Every scored full or canary row must commit `plan.json`, its
`result-*.json` files, and `calibration.json`. A complete row must carry one
result file for every planned cell. A partial row must carry evidence for every
condition it records. `calibration.json` records the exact cell IDs that the
scorer saw. CI requires that list to match the committed result files and the
row status. Deleting only a completed result cannot turn a complete run into a
partial run. A partial row records an attempted run. It cannot rank, become a
baseline, or refresh the complete-run or full-run freshness clocks. It refreshes
only the any-run clock, which records that the harness ran. CI also checks each
condition's model, effort, and finder against
the planned cells. It regenerates the exact cell list from the frozen contract
and row kind. Changing only `plan.json` cannot remove a required cell. A dirty
`--skill-ref`
candidate row can name an installed baseline that is not committed on the same
branch. CI recomputes that candidate against its own evidence and counts it in
`unpaired_baselines`. An installed row cannot use this waiver.
Each paired row records whether `--against` selected its baseline or append
order selected it automatically. `plan.json` records the same choice before
the run spends model quota. CI requires both records to match. For every
automatic row, including a dirty candidate, CI resolves the baseline from
ledger append order and requires the row to name that exact anchor. An
automatic row cannot name a later row on the same branch as its baseline.

Both the ledger check and `--validate --append` hold the frozen denominator. A
condition that scored a PR at all carries every defect that PR froze, and a
`status: complete` row carries the whole matrix of its own kind: a full run is
`pipeline` over every fixture in one draw, `replay` over the grid fixtures in
one draw per frozen finder report and `control` over the grid fixtures in one
draw; a canary is `replay` over every grid fixture in one draw. Both axes are
checked, which PRs each condition scored and how many draws it recorded. A
complete full row is the score of record — it refreshes the full-run clock and
becomes the automatic baseline — and a complete canary is read against
`canary_min_matched_grid`, so neither may claim its matrix on a subset of it.
The draw check is a floor rather than an equality: a row recorded when the
matrix planned more draws ran a superset of today's cells, and it carries a
different comparability key anyway, so it is history rather than a short run.
One caller keeps the equality: a baseline named with `--against` whose
`comparability_key` equals the generated plan's. That row ran this plan's
matrix — the planner is inside the key — so its draws must equal the planned
count exactly rather than merely reach it. The per-defect bits of a condition
fold with OR, so a baseline carrying two bits per defect against a candidate's
one is a higher hit rate for the baseline alone, which reads as lost defects.
Such a row is refused as a baseline rather than paired.

Then plan and run. `--plan` prints the matrix and the cost estimate without
spending anything.

```bash
pnpm review:eval -- --plan --kind canary --json   # 6 cells, about $22, ~40 min
pnpm review:eval -- --plan --kind full --json     # 27 cells, about $99, hours TBD
pnpm review:eval:run --kind canary                # the monthly smoke test
pnpm review:eval:run --kind full                  # the quarterly score of record
```

`run-eval.sh` adds a detached worktree of `origin/main` and reads the contract,
truth, prompts and scorer from there, so a dirty working tree cannot change
what is measured. The ledger, the baseline it resolves and the branch the PR
commands cut still come from the checkout the script runs in, so a run without
`--skill-ref` refuses to start unless that checkout is at `origin/main` with an
unmodified ledger — on a feature branch it would plan against a ledger missing
newer rows and offer to commit the row on top of unrelated work. The scheduled
launchd job runs the same code path. Only one run at a time may hold the shared
state: every cell resets, cleans and stages `.skill` into the shared per-PR
checkout, and every run appends to the ledger, so a scheduled run starting
under a manual one would rewrite the tree the other is reviewing. The script
takes a `run.lock` owner record under both the checkout's git directory and the
fixture cache — they move independently, under `--repo` and `--cache-dir` — and
refuses to start while another live run holds either. A hard link publishes the
complete owner record atomically. A process also claims a stale lock before it
removes the lock, so two starters cannot both reclaim one killed run. The runner
creates one private directory under the checkout's physical git directory. It
copies and sources `run-eval-source-snapshot.sh` from that directory first. The
helper copies the wrapper, the other three sourced helpers, and the two node
modules the cell path loads — `review-eval-cell-writer.mjs` and the
dependency-free `review-eval-stream.mjs` it imports — creates a PID-bound
random owner marker, seals the directory, and restarts the wrapper. Those two
module names are exact pins in both `ORCHESTRATOR_FILES`
(`review-eval-run-plan.mjs`) and `run-eval-source-snapshot.sh`: the
orchestrator digest hashes them and the snapshot copies them, so a move
updates both lists in the same PR. The
restarted process accepts only that sealed, non-symlink direct child. The
read-only directory and files prevent in-place writes and entry replacement
before a later helper source. Cleanup unlinks only the seven fixed source files
and the authenticated marker, then removes the empty directory. Every later
helper stage uses the same snapshot, and the cell writer runs from it: reading
the stream parser out of the spec worktree instead let it change between two
cells of one run while every cell fingerprint stayed identical. Before a paid
cell starts, the snapshot helper recomputes the framed source digest over all
seven and requires the persistent plan to record the same digest. An edit during
planning makes the run stop instead of
executing bytes outside its recorded provenance. The skill
under test is snapshotted once, before the first cell, and every cell stages
from that snapshot: the plan records one skill
digest for the whole matrix, and two hours is long enough to edit the installed
skill under a running evaluation. A snapshot that no longer matches the planned
digest refuses the run instead of mixing two treatments into one row. Every
cell writes its own resumable output directory, and a failed cell is never
cached — a finder that exits non-zero fails its cell even when it wrote a
partial report, because a truncated review cached is a permanent zero-recall
score. A contestant is bounded in bytes as well as in time: its stream runs
under a 64 MiB file-size limit, the ceiling the node path already enforced, so a
runaway session fails its cell instead of filling the disk and then the reader's
heap. The cell writer is pre-flighted before the paid call, so a writer that
cannot load costs nothing; one that fails afterwards keeps its directory and the
stream it paid for, as `stream.jsonl` and `stream.err`, and the cell re-runs.
A cached cell is reused only when its stored
fingerprint — skill digest, kind, contract digest, the two CLI versions, the
finder argv digest and the orchestrator digest — matches the current run. The
one cache-compatibility rule that once accepted the recorded pre-split
orchestrator digest is closed: the stream-capture change moved the wrapper's
digest, and a cell cached under the old runtime recorded only the reviewer's
final message, so folding it into a run that scores whole sessions would mix
two capture regimes in one row. The audited transition pair stays in
`review-eval-run-cell.mjs` as the record of what was permitted, and the tests
assert the path is closed. The 24 pre-split cells re-run under the current
runtime. The
scorer preserves that fingerprint and a separate installed-or-candidate
treatment identity in every result and in `calibration.json`. Local validation
and CI check both records against the plan. Changing only the row and plan
inputs cannot relabel a candidate as an installed run. The run directory
carries the kind and the skill digest in its name, so an
aborted run followed by a skill edit re-runs instead of scoring the old skill
under the new digest. A run that never published a score keeps its cells on
disk for that retry — publishing strips them from the commit with an exclude
pathspec rather than deleting them — and only a run that published one removes
them, having nothing left to resume. `cells/` carries the judge pass's per-cell
verdicts as well as the paid transcripts, so a retry resumes the scoring too. The directory belongs to one
execution: a run killed before it recorded anything is retried into it, but once
a ledger row points at it the next execution takes the next name and copies
those cells across, because a second run writing there would overwrite the plan,
results, row and report the earlier row still claims and reuse its publication
branch. Seeded cells are fingerprint-checked one by one like any other. The
skill directory itself may hold no symlink: `cp -R` would stage the link, so the
contestant would read bytes `skill_digest` never covered and an edit to that
target mid-run would change the treatment. The digest length-frames every path
and file body, so a path/content boundary cannot alias another skill. The
six-hour deadline bounds the whole run: three quarters
of it start cells and bound each finder and contestant process, the rest bounds
the judge pass, and a run that reaches either bound reports a partial matrix
rather than a table with quietly missing cells. A stalled process is killed
rather than waited on, because a deadline checked only between cells is no
deadline at all. After TERM, the watchdog completes its group-wide KILL before
the run returns, even when the direct child exits first.

The matrix runs its cells as PR groups: the cells of one fixture PR strictly in
sequence on the checkout they share, and up to `REVIEW_EVAL_PR_CONCURRENCY`
groups — 3 by default, 1 for the old strictly serial matrix — at once.
[ADR 0089](../adr/0089-review-eval-canonical-matrix-pr-groups.md) records that
decision for this runner; it is the shape
[ADR 0086](../adr/0086-review-eval-lane-any-grid-multi-draw.md) already gives
the experiment lane, and for the same reason: every cell resets,
cleans and stages `.skill` into its PR's one checkout, so two cells of one PR
would delete each other's tree, while two PRs are separate trees. The cost is
unchanged — the same cells, in the same per-PR order, against the same fixtures
— and the wall-clock time is not yet measured: the 2026-09-04 six-fixture full
run took 100 minutes for 6 serial pipeline cells, which put the 39-cell serial
matrix of the time at 8 to 9 hours against a 4.5-hour matrix deadline. The
matrix is 27 cells since
[ADR 0090](../adr/0090-canonical-eval-matrix-freshness-floor.md), 9 of them live
pipeline draws instead of 18, so the serial worst case is well under that; what
grouping then buys on top of it is still unmeasured. Re-measure on the next full
run and replace the `hours TBD` above with what it took. Each group is its own
process group, and the TERM and EXIT paths take every one of them down before
the run returns; because `run_bounded` puts each cell's bounded child in a
process group of its own, a signalled worker forwards to that group as well
rather than leaving a finder or a contestant orphaned. A cell's log lines are
buffered and emitted as one write, which is indivisible on the regular file the
launchd job redirects to and guaranteed only to `PIPE_BUF` through a pipe, so
`run-eval.sh | tee` can still interleave two failing cells. Every cell's outcome
is written to its own status file and summed by the parent, so
`matrix: D done, F failed, of T` counts each cell exactly once and `T` is the
whole planned matrix.

A PR whose draw-2 cell never ran is scored on draw 1 alone: the defect's bit
vector is as long as the draws its own PR completed, so a missing cell shrinks the
denominator instead of recording misses that were never possible.

To evaluate a candidate skill, run it against the installed one in one sitting.
Run the installed skill first, **publish its row before starting the
candidate**, then name that row as the candidate's baseline with `--against`:

```bash
pnpm review:eval:run --kind full
# Prepare and publish this row through the manual publication flow below.
cp "<installed-detail-dir>/row.json" \
  "${TMPDIR:-/tmp}/review-eval-installed-row.json"
git -C . switch main                        # the candidate run branches from here
pnpm review:eval:run --kind full --skill-ref ~/work/review-candidate \
  --against "${TMPDIR:-/tmp}/review-eval-installed-row.json"
# Prepare and publish the candidate row through the same flow.
```

The baseline is that file, not the installed row's `executed_at`. Publishing
commits the row and its detail directory on the ledger PR branch and leaves the
checkout there; `git switch main` then deletes both, because neither exists on
local main. An `--against` naming the `executed_at` would resolve against a
ledger that no longer holds the row and the candidate's pre-flight would abort
— the right failure, and still a wasted installed run.
Copy the installed `row.json` outside the checkout before the branch switch.
The manual publication helper does not create this copy. The external file
survives the switch and supplies the exact `--against` argument. A row carries
every bit the comparison reads, so no detail directory is needed for the
baseline.

Claude auto-review skips that branch only when the diff contains the ledger and
files under `docs/evals/review-skill-runs/`. Any other changed path keeps normal
auto-review enabled. The branch prefix alone grants no review exemption.

Naming the `executed_at` is correct once the installed PR is merged and main is
pulled, because the row is then in the checkout's ledger. It is never a date
typed from memory: `--against` resolves against rows the ledger already holds,
so a value no row carries fails the pre-flight before the candidate spends
anything. The pre-flight also validates the full baseline row, its frozen
matrix, its comparability key, and that its `executed_at` precedes the plan's
fixed `planned_at` timestamp. These checks finish before the first model call.

Publish first, or both rows land in one working tree and only one of them
reaches a PR: each run appends to the same ledger file, and the candidate's
publish stages that whole file next to its own detail directory alone. The
installed run's detail directory is then never committed, and there is no
second ledger delta left for a PR of its own.

`--against` takes a row file path or an `executed_at` prefix and reaches the
plan, `--score`, `--validate` and `--report` alike. The plan and row therefore
record `baseline_selection: "explicit"` and
`vs_baseline.selection: "explicit"`. The plan also records the resolved row's
identity and digest. Scoring rejects a different row. Without `--against`, the
plan and row record automatic selection, and the candidate resolves the
ledger's stored anchor. A candidate also stamps `skill_ref` and `dirty: true`
into the ledger row. Never compare a candidate against a ledger row from three
months ago: that comparison silently includes an unknown amount of model drift.

The current-key runner still prints low-level recovery commands and accepts
`--pr`. Do not use either publication path. They use the generated report as
the PR body and leave the absolute checkout path in `plan.json.plan_dir`.
Changing those hash-covered orchestrator sources would start a new comparison
lineage. Remove or reroute those paths only as part of a planned re-key.

Required appended-row revalidation rejects a plan unless `plan_dir` is the same
repo-relative path as the row's `detail_dir`. The PR-description check also
rejects the raw generated report. These checks make the old publication path
fail closed before merge while the current comparison key remains valid.

Prepare the local artifacts first. Use the detail directory that the runner
prints. The helper verifies that the selected directory,
`plan.json.detail_dir`, and `plan.json.plan_dir` resolve to the same directory
inside the repository. It then writes a repo-relative `plan_dir` and renders a
PR body that contains the complete generated report under `## Details`.

```bash
DETAIL_DIR="docs/evals/review-skill-runs/<run-directory>"
PR_BODY="${TMPDIR:-/tmp}/review-eval-pr-body.md"
node scripts/review/review-eval-publication.mjs \
  --detail-dir "$DETAIL_DIR" >"$PR_BODY"
```

For a failed run, add `--report-file failure.md`. The helper never runs a
model, appends a row, stages or commits files, pushes, opens a pull request, or
merges. After it succeeds, use the normal `ship` workflow. Stage only
`docs/evals/review-skill-ledger.jsonl` and the selected detail directory. Give
the workflow `$PR_BODY` as the PR description. The scoped `.gitignore` rule
keeps each run's `cells/` resume cache, raw model transcripts, and tool output
out of Git and out of any review input. Scored `result-*.json` evidence remains
in the detail directory above `cells/` and stays eligible for the commit. There is
no auto-merge. A human reads the report and approves.

A run that fails publishes the same way. Its `status: failed` row is already in
the checkout's ledger, and a run that leaves it there uncommitted wedges the
schedule: the next run refuses to start against a ledger with uncommitted
changes, and nothing reaches the freshness workflow. A scored row wedges it the
same way. The installed job uses the non-publishing mode, so both endings follow
one rule: the run prints recovery commands and exits non-zero until an operator
finishes the helper and `ship` workflow. launchd therefore records that a human
still has to finish the job. Writing that row clears the scored artifacts at the
run-directory root, because `--revalidate-appended` would otherwise read them as
the failure row's own numbers; it leaves `cells/` alone, so the judge verdicts a
stopped pass already earned survive for the retry.

A run that failed with `novel judge returned no parseable JSON object` before
the scorer read balanced JSON spans hit the greedy slice, which ran from the
first brace in the judge's reply to the last: a brace in the prose ahead of the
fenced answer — an awk snippet, say — swallowed the JSON. The logged stderr
tail is the only record of it, because `run-eval.sh` deletes the score stderr
file as soon as it prints that tail.

The freshness workflow also routes a new staleness issue through
`review-eval-freshness-publication.mjs`. The wrapper keeps the hash-covered
issue planner unchanged, replaces its legacy PR instruction at the GitHub
boundary, and fails closed if that template drifts. The issue requires
`review-eval-publication.mjs` and `$PR_BODY`; it never starts a model.

### Install the scheduler

The plist is a template. A plist has no variable substitution, so the install
step replaces three placeholders: `__REPO_CHECKOUT__` (the checkout that holds
`run-eval.sh`), `__USER_HOME__` (the log location), and `__RUNTIME_PATH__` (the
current `PATH` after the installer verifies `node`, `git`, `codex`, and
`claude`). launchd does not inherit values that a login startup file exports.
The installed job uses fixed `/bin/zsh` and `/bin/bash` interpreters. The login
shell loads model credentials, then the command restores the captured path
before it invokes the runner. Run this from the root of your checkout, in your
own shell. The installer refuses to start inside a quality-gate run, because the
Darwin broker preflight allowlists it only on that condition.

```bash
./scripts/review/install-review-eval-launchd.sh
```

The installer validates the template, runner, required CLI path, rendered
plist, and any prior plist. It holds the checkout's review-eval run lock and a
per-user target transaction lock while it checks the label, replaces the file,
and loads the label. It never reclaims either lock and never unloads a label. If
the label is loaded, first confirm that no evaluation runs. Then use
`launchctl bootout` as a separate operator action and rerun the installer. A
failed load restores the prior plist or removes the new file. The installer
retains a recovery copy if file rollback fails. It fetches `origin/main` and
refuses a dirty checkout or a checkout whose `HEAD` does not equal the fetched
ref. It does not update the checkout.

Fast-forward the scheduler checkout to current `origin/main` before each
scheduled date. The runner fails closed if the checkout becomes stale after
installation. A dedicated checkout with a safe automatic refresh remains
deferred to [issue #2148](https://github.com/mento-protocol/monitoring-monorepo/issues/2148).

Run this separate opt-in command only when you intend to start a paid
evaluation immediately:

```bash
launchctl kickstart -p gui/"$(id -u)"/org.mento.review-eval
```

Skip `kickstart` if the current baseline already exists. Running it starts
another paid evaluation immediately.

It fires on the 8th at 10:20 and logs to
`~/Library/Logs/mento-review-eval.log`. launchd, not cron: a laptop is asleep
at that hour about half the time, and launchd runs a missed calendar interval
on the next wake while cron drops it. `--kind auto` reads the ledger and picks
`full` when the last full run is more than 100 days old, otherwise `canary`.

## Lightweight experiment lane

Use this lane to reject weak review-skill changes before a canonical run. It
compares one candidate with one incumbent. It never reads or writes
`review-skill-ledger.jsonl`. It cannot update the baseline or freshness clock.
Its only statuses are `PROMISING`, `REJECT`, and `INCONCLUSIVE`.

Planning and validation do not call a model. Both modes validate local inputs
and probe the provider CLI versions. Planning writes `plan.json` with the
complete campaign and canonical full-rerun manifest before paid work can
start. Its cell count is derived from the contract, so a fixture added to the
suite or the grid widens it.

```bash
experiment_root="$HOME/.cache/mento-review-eval-experiments/manual-$(date -u +%Y%m%dT%H%M%SZ)"

pnpm review:eval:experiment -- --plan \
  --candidate candidate-a=/absolute/path/to/review-candidate \
  --out "$experiment_root" \
  --live-paired \
  --json

pnpm review:eval:experiment -- --validate-plan "$experiment_root" --json
pnpm review:eval:experiment -- --run "$experiment_root" \
  --stage screen --dry-run --json
pnpm review:eval:experiment -- --run "$experiment_root" \
  --stage screen --json
```

`--run` is the only mode that can call a model. `--dry-run` prints the
planned fixture lanes and treatment order. It does not call a model or estimate
cost.

The plan binds these inputs:

- Contract digest; fixture head and base SHAs; and truth, frozen finder-report,
  and prompt digests.
- Incumbent and candidate skill digests.
- Finder, verifier, control, and judge model and effort settings.
- Scorer identity and the experiment harness digest.
- Stage lanes, treatment order, and the canonical rerun manifest.

The plan records the Claude and Codex CLI versions instead of binding them.
`--validate-plan` and `--run` rebuild the plan from its recorded versions, so a
stored plan stays valid after a provider upgrade, and they probe the live
versions separately. A live difference is a warning: `--validate-plan` reports
`cli_version_drift` and stays `ok`, and `--run` writes one line to stderr.

Cell identity follows the canonical lane exactly. Every cache identity carries
the live version of each provider its own phase invokes — the contestant CLI for
a raw cell, the finder CLI as well on a `live-paired` lane, the judge CLI for a
score or novelty cell that calls the judge. A phase that reaches its answer
without a provider records the empty set instead: an empty reviewer transcript
is scored with no judge call, and a cell with no claim is classified with none,
so a judge upgrade neither reruns those cells nor is charged with their drift.
A cache entry whose phase invokes a changed provider is never found, so that
cell reruns and no phase mixes runtimes; a completed stage result and an entry
independent of the changed provider are still reused. Each artifact stores the
versions it ran under, and a later phase rebuilds an earlier artifact's identity
from the record's stored versions, so a judge upgraded between a screen and its
holdout still loads the screen scores, and a stage retried after a failure
reports the runtime that produced each artifact rather than the runtime of the
retry. The stage decision names every transition with the cells it touched,
screen cells included once a holdout decision folds them in, so a flip on a
straddling pair reads as a possible runtime change rather than a skill change.
Every cell of one stage is keyed on the versions `--run` probes when that stage
starts, immediately before its first arm, not on the versions probed when the
campaign loaded: a provider that ships between the two would otherwise key the
cells on a version no cell ran under. The load-time probe reports plan drift and
nothing else. A CLI that auto-updates while the stage runs leaves the cells that
ran after the update keyed on the earlier version; `--run` re-probes after the
arms and after novelty, and a change between those probes is written to stderr
and named in the decision and the stage payload as
`runtime_change_during_stage`, keyed by the stage that saw it, for the stage as
a whole and never per cell. A holdout decision reads the screen records, so it
carries the screen's recorded change beside its own. Each re-probe reads only
the providers that stage can invoke: every stage runs the contestant and the
judge through the Claude CLI, and only a `live-paired` stage spawns Codex, so a
Codex release during a frozen-report stage is not reported as a change no cell
could have used.

What the canonical lane keeps free of the two versions is its ledger
comparability key, not its cell fingerprint. `claude` and `codex` ship far more
often than the suite runs, so keying the ledger on them would start a fresh
lineage at every upgrade.

The screen reads the first frozen report of every fixture the contract marks
`grid: true`, at least three. `--draws N` repeats each fixture 1..5 times
(default 1) against that report, so a difference between draws is verifier
variance and a stage costs `grid x draws x 2` arms. Each lane runs its arms in
its planned order, draws of one PR run in sequence on its shared fixture tree,
and up to three PRs run at once.

Both stages decide on the paired per-lane difference in known matches, against
bars derived from the panel. The screen returns `PROMISING` only when the net
reaches `max(2, round(0.06 x scorable ids x draws))`, with no net P1 loss and a
non-negative net on at least half the PRs. A net loss reaching that bar, any P1
net loss, an empty candidate arm, a candidate hard leak, or more than one extra
wrong claim under inflation returns `REJECT`; other misses are `INCONCLUSIVE`.

Run the holdout only after a `PROMISING` screen:

```bash
pnpm review:eval:experiment -- --run "$experiment_root" \
  --stage holdout --json
```

The holdout uses the complementary frozen report of each grid fixture and
combines its arms with the screen's, at `max(3, round(0.06 x scorable x draws x
2))`. A finalist also needs `round(0.75 x P1 opportunities)` candidate P1
matches, `max(2, round(P1 opportunities / 6))` net P1 matches, gains on half the
PRs, and no more than one extra wrong claim; both P1 bars are zero on a grid
with no P1 defect. Each decision reports `sign_flip` — pairs, informative pairs,
and an exact one-sided p-value, `null` above twenty — as a non-gating diagnostic.

Claim extraction and known-defect matching run first. Novel-claim
classification runs only when claim inflation requires it or the candidate
reaches the holdout finalist decision. Claim inflation needs at least three
extra claims and a ratio of at least 1.25. Deferred `wrong_claims` fields stay
absent from the arm records.

When planned, `live-paired` requires a `PROMISING` holdout:

```bash
pnpm review:eval:experiment -- --run "$experiment_root" \
  --stage live-paired --json
```

The live stage generates one current finder output for each grid fixture. It
delivers the same final UTF-8 suffix of at most 30,000 bytes to both verifier
arms. It applies the screen thresholds to its own `grid x draws x 2` arms. It
confirms the experiment only. It is not the canonical pipeline score.

The artifact root must be outside the repository. Completed artifacts use these
paths:

- `plan.json` contains the immutable campaign plan.
- `cache/raw/<digest>.json` contains one verifier response.
- `cache/score/<digest>.json` contains extracted claims, known matches, and
  leak evidence for one raw response.
- `cache/novel/<digest>.json` contains optional novel-claim classification for
  one scored response.
- `cache/stage/<digest>.json` contains the complete stage records and decision.

Each cache identity includes the plan digest. Live raw identities also include
the delivered finder-report digest. Score and novelty identities chain the raw
and score artifact digests. The runner validates identities and content digests
before reuse. It publishes a complete JSON file through a temporary file and an
exclusive hard link to the final name. Readers ignore incomplete temporary
files.

A failed stage writes no completed stage entry. Cell-level raw, score, or
novelty entries completed before the failure remain available. Run the same
stage again to reuse exact entries and repeat missing or changed work. A new
live finder output changes the raw identity unless its delivered digest is the
same. The experiment runner does not provide crash-lineage recovery, retry
journals, a campaign lock, calibration receipts, host sandboxing, or
process-group control. Run one command for a campaign at a time. This is an
operator-started local experiment.

The plan contains a `canonical-full-rerun` manifest with
`experiment_artifact_reuse_allowed: false`. No importer exists. Experiment
results and caches never qualify as canonical evidence. Run the selected
candidate through the canonical full runner:

```bash
pnpm review:eval:run --skill-ref /absolute/path/to/review-candidate \
  --kind full
```

The current visible fixtures are development data. They do not prove broad
generalization.

## Read the verdict

| verdict        | it means                                                                                                                                                                                                                      | do this                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **GREEN**      | nothing below fired                                                                                                                                                                                                           | merge the ledger PR                                                       |
| **AMBER**      | recall below baseline but McNemar not significant; or fewer than three paired defects, which never ranks; or the run did not complete; or judge calibration under 37/40; or a leak signal; or `control` moved with `pipeline` | merge the row, do not rank on it, read the reason                         |
| **RED**        | `b − c ≥ 6` net flips; or pooled P1 recall under 0.60 where P1 was measured; or wrong claims at twice the baseline rate, the baseline floored at one; or a condition found nothing on two or more PRs                         | open a priority issue naming the flipped defects before changing anything |
| **PROMOTE**    | `c − b ≥ 6` on the headline, the change was intentional, and where the headline is `pipeline` a net gain of at least 3 on `replay` corroborates it                                                                            | re-anchor the baseline in a PR that says what changed and why             |
| **INCOMPLETE** | the run failed, or a canary did not finish                                                                                                                                                                                    | fix the harness and re-run; the row stays as a trace                      |

**A `pipeline` flip `replay` contradicts is unproven; a flip on a defect
`replay` never scores is unchecked.**
Since 2026-09 `pipeline` takes one live finder draw per PR, and the
finder samples, so six net flips there can be the finder rather than the
reviewer. `replay` runs frozen reports, so it does not move with the finder;
its own `claude` verifier is still sampled fresh, with no seed and no
deterministic decoding, so it removes one source of variance rather than all of
them. It also covers the 39 grid defects only. So a RED still opens its priority issue and a
PROMOTE still records what changed, and both split the flipped defects three
ways: those `replay` moved with, those `replay` held on — where the flip is
unproven — and those from PRs 1982, 1984 and 2001, which `replay` never
scores. That third group has no finder-frozen counterpart at all. Name it
unchecked; it is neither corroboration nor contradiction. And read a
corroborating `replay` flip for what it is: two conditions moving together, each
with its own verifier draw, which is weaker than a repeated measurement and
stronger than one condition alone.

The harness enforces that reading where it matters most. A PROMOTE re-anchors
the baseline on its own — `resolveBaseline()` picks the newest PROMOTE row of
the same key, and `--validate` recomputes the verdict from the row's own
numbers, so it cannot be lowered by hand — so a `pipeline` gain past the flip
threshold is PROMOTE only when `replay` gained at least
`verdict_rules.promote_corroboration_net_flips` (3) net defects on at least
`noise_floor_defects` defects both runs scored. Uncorroborated, the row is
GREEN and the reason states the gain, why `replay` did not corroborate it, and
that it does not re-anchor the baseline. Half the PROMOTE threshold is the bar
because `replay` folds two frozen-report draws over the 39 grid defects: it
confirms the direction beyond noise without asking one verifier to reproduce a
PROMOTE-sized gain on the grid alone.

The gate reads a `pipeline` headline only. A row whose headline is `replay`
scored no live pipeline cell, and `replay`'s finder is frozen, so it has no
finder sampling to corroborate away. RED is unchanged: a spurious RED costs an
investigation, a spurious PROMOTE moves the reference every later run reads.
[ADR 0091](../adr/0091-promote-needs-replay-corroboration.md) records the
decision.

The three AMBER gates — failed judge calibration, a leak signal, and a matrix
that did not complete — are read before the RED lines, not after them. Each says
the numbers under it are untrusted or partial, and a run whose numbers are
untrusted may not be escalated on them any more than it may pass on them: a
subset that missed its P1 cells is not a P1 regression to open an issue about.

All three keep the row off the full-run freshness clock as well. A full run
nothing may rank on did not verify the operating point, so the quarterly clock
keeps running and the next scheduled run asks for a full run again instead of
dropping back to canaries for another cadence window.

A canary is a floor test, never a ranking: RED when `replay` matches fewer
than sixteen of the thirty-nine grid defects, or any run emits no parseable
finding.

## The noise rule

**Never rank on fewer than three defects.** Fifty-one defects across nine PRs
is 51 paired per-defect outcomes, and `replay` measures its 39 grid defects
twice, which the scorer folds into those same 51 bits rather than into a larger
sample: draws on one defect are correlated, so the effective sample is smaller
than it looks. The
pre-registered red line is `b − c ≥ 6` net flips on the paired per-defect
vectors; at `b + c = 10`, `b = 8` gives a one-sided p of about 0.055. Anything
below six flips is the noise floor. The rule is written down here so nobody
re-derives it after seeing a result they dislike.

`verdict()` enforces the floor: when a candidate and its baseline share fewer
than `noise_floor_defects` scored defects, the row is AMBER and the reason says
the comparison was refused. It never reads as green, and it never promotes. The
same floor bounds the PROMOTE corroboration check: `replay` corroborates only
over defects both runs scored, and fewer than `noise_floor_defects` of them
corroborate nothing.

Do not use a two-proportion z-test on these numbers. The comparison is paired
at the defect level, which is the whole point of freezing the fixtures.

## Drift controls

Every comparable input gets a digest, and comparison is refused across
mismatched keys:

```text
comparability_key = sha256(contract_digest ‖ request_prompt ‖ handoff_prompt ‖
                           scorer_digest ‖ calibration_digest ‖
                           orchestrator_digest ‖ judge_model)
```

The two CLI versions are deliberately outside the key. They are recorded on
every row, they are part of every cell fingerprint so one resumed run never
mixes runtimes, and a pair that straddles an upgrade is labelled in the verdict
reasons and the report — "a flip may come from the runtime rather than the
skill". Keying on them would be worse than that: `claude` and `codex` ship far
more often than this suite runs, so every upgrade would start a fresh lineage,
every later run would resolve no baseline, and the flip rules that make a
regression visible would never fire again. The key binds what this repository
controls; a runtime change large enough to move the score shows up as a flip
against the anchor with the version drift named beside it.

`review-eval-score.mjs` owns the `SCORING_MODULES` inventory and computes
`scorer_digest`. The digest covers every file that can move a recorded number
or verdict. This includes the CLI, the run facade, plan construction, scoring
process execution, cell identity, judge-verdict reuse and leak checks,
condition folding, row
assembly, the recompute, timestamp validation, and verdict rules. It also
covers the two fixture helpers:
`review-eval-fixtures.mjs` picks the matrix, the truth file and the recall
denominator, and `build-fixture.sh` materializes the checkout the contestant
reviews and carries the checks that verify it, so an edit to either moves what
was reviewed or what it was scored against. `orchestrator_digest` is a
length-framed digest over `run-eval.sh`,
`run-eval-source-snapshot.sh`, `run-eval-lifecycle.sh`,
`run-eval-runtime.sh`, and `run-eval-matrix.sh`. Together they fix source
authentication, sealing, restart and cleanup, plus the contestant's allowed
tools, turn limit, skill staging, finder-report truncation, cell environment,
and what the matrix may run at the same time. They shape the
transcript every number is derived from as directly as a prompt does. An edit
to any of them re-anchors the series, which is the conservative direction: a
refused comparison is visible, a silently paired one is not.

`--score` rechecks the bytes the contract pins by `sha256` — both prompts, every
truth file, every frozen finder report — before it calls the judge, and refuses
the pass when one of them moved. It reads each truth file once, checks that
exact buffer against the pinned digest, and parses the same buffer before the
first calibration call. A later checkout edit cannot change one cell's
scoring. `--check-fixtures` covers the inputs once, before the matrix starts;
under `--skill-ref` the spec worktree is the live checkout for the two hours in
between, and the contract digest alone would not notice.

**The judge pass resumes per cell.** Judging one cell costs about $4 and nine
minutes, so 27 cells run about four hours and need not fit inside one usage
window: the 2026-09-05 attempt, on the 39-cell matrix, scored nineteen cells,
hit a usage limit, and re-spent them on the retry. `--score` writes each verdict to `cells/<cell_id>/score.json`
as it earns it, under a resume identity carrying the plan's comparability key,
contract digest, matcher digest and calibration digest, the cell fingerprint, and
the digest of the `result.json` that verdict was formed on. A later pass reuses a
record only when every one of those matches; a mismatched or unparsable record
is ignored and re-judged, which costs one cell. The `--json` output reports
`judge_pass.judged`, `judge_pass.reused` and `judge_pass.calibration_reused`, so
the run log says what the pass paid for.

Scored evidence reaches the detail-dir root — `result-*.json` and
`calibration.json` — only once the pass has finished. That is what lets a failed
row publish no scored evidence and a retry still resume: the two needs are one
layout rather than a trade. Editing the scorer moves `scorer_digest`, so the
next run plans a new directory name; seed it by copying the previous run's
`cells/` across, as with any superseded run. A retry that crosses UTC midnight
needs the same copy for the same reason: the directory base carries the date, so
`resolve_detail_dir` finds no earlier run to resume from and the paid cells stay
in yesterday's directory until they are moved.

`--score --against` requires the baseline to carry the plan's
`comparability_key`. It refuses a cross-key pair before model work. `--report`
also refuses to compute McNemar across different keys unless the row is a
hand-assembled bridge run. Rows with different keys are different series and
plot separately.

`--report` reads rows of the current `contract_digest` only. The ledger keeps
the rows a retired contract scored, and reporting one under today's contract
would recompute its verdict against a truth index and thresholds the run never
saw. The default selection is the newest row of this contract, and `--row` on an
older one is refused; pass `--contract` with the archived contract to read it.

| drift vector      | control                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| fixture content   | eval tags plus a tree-hash check in `build-fixture.sh`, whose bytes are in `scorerDigest()`                                            |
| truth content     | committed verbatim, per-file `sha256`, never re-derived from the API                                                                   |
| scorable set      | explicit frozen id list in the contract                                                                                                |
| run prompts       | frozen files with `sha256` in the contract                                                                                             |
| scoring pipeline  | `scorerDigest()` over the scorer, run, result-shape, ledger, report and fixture files and every judge prompt                           |
| judge model       | model id and CLI version in the row, plus 40 calibration pairs every run                                                               |
| calibration set   | its `sha256` is bound into `comparability_key`                                                                                         |
| reviewed model    | isolated by the `control` condition; model id and CLI version recorded                                                                 |
| skill text        | `skill_digest` over every file in the skill directory, symlinks refused — this is the treatment                                        |
| finder command    | `argv` pinned in the contract; `finder_argv_digest` records what a cell spawned                                                        |
| orchestrator      | length-framed digest over the wrapper, its three helpers, the cell writer and the stream parser: in the key and every cell fingerprint |
| machine and shell | host, CLI versions, `--setting-sources ""`, clean worktree of `origin/main`                                                            |
| CLI upgrade       | versions in every cell fingerprint; a pair across one is labelled in the verdict, not in the key                                       |

**Judge calibration runs before every scoring pass.** Forty frozen
`(claim, defect, verdict)` pairs replay through the current judge. Agreement
under 37/40 marks the run AMBER (floor = the contract judge's measured 39/40
blind baseline on the audited set minus a two-pair drift margin; re-anchor on
any judge, set, or calibration-renderer change), excludes the row from baseline
comparison, and keeps it off the full-run freshness clock. It costs about $2 and
it is the only mechanism that separates "the review skill regressed" from "the
judge alias now points at different weights and the scorer got stricter". It
fired on the very first baseline run (2026-08-28): the original labels — the
frozen 2026-08 judge's own decisions — scored 29/40 against two independent
modern judges, which agreed with each other on 36/40. The set was re-audited
against the modern consensus, which held for all six matched -> unmatched flips.
All three unmatched -> matched flips it proposed were declined on full context:
each cited the same file while describing a different problem, so both blind
modern judges share an over-matching bias on file overlap and that direction has
to be adjudicated, not trusted. Six records were then replaced with fresh
matched pairs so the set still clears the balance guard at 18 matched / 22
unmatched (provenance in the calibration file). The contract judge is now
`claude-fable-5` at max effort, the judge whose full-context adjudication
settled the contested labels. Until the issue 2332 fix the replay rendered an
empty `detail:` line for every record, so the judge saw each defect's title and
nothing else. The 2026-08-28 baseline of 37/40 was measured that way. A blind
replay through the fixed renderer measures 39/40 on 2026-09-09, and the three
same-file trap pairs that baseline missed now judge correctly.

The forty outcomes are written to `calibration.json` in the run's detail
directory. `--validate` re-derives `agreement` and `total` from them and checks
each `expected` against the frozen pair, so the gate that caps a run at AMBER is
evidence on disk rather than two integers the row states about itself. A detail
directory holding cell results but no `calibration.json` fails validation. The
replay is also cached beside the cell verdicts, at `cells/calibration.json`,
under the same resume identity those verdicts carry — the comparability key, the
contract digest, the matcher digest, the calibration digest and the cell
fingerprint — with the contract judge standing in for the per-cell transcript
digest. A resumed pass reuses it only when every one of those still matches, so
an edit to a scoring module, which moves `matcher_digest`, replays the forty
pairs again rather than reusing a replay the edit could have changed.

**Model retirement needs a bridge run.** Pinned models get retired and history
cannot be re-run. When that happens, run the retiring model and its replacement
on the same day and on the same machine, both `kind: full`. The model lives in
the contract, so each of those is an ordinary full run against its own
`comparability_key`.

The bridge row is assembled by hand from the newer of the two runs: copy its
`row.json`, set `kind` to `"bridge"`, and record the retiring run's
`executed_at`, its `comparability_key`, `selection: "explicit"`, and the
McNemar delta between the two in `vs_baseline`. `--validate ROW --detail-dir RUNDIR --append --against
RETIRING_ROW` re-derives every recorded number from the run detail before
appending, `vs_baseline` included: the McNemar counts are recomputed from the
two rows' `per_defect` vectors and a stated `baseline_executed_at`,
`baseline_comparability_key` or delta that does not match is a validation
problem. Name the retiring row with `--against`, or there is no baseline to
recompute against and the reviewer of the ledger PR checks those two numbers
against the two run reports by hand. Then re-anchor the baseline to the new
model. Never swap a model and keep comparing against
the old baseline. A judge retirement follows the same procedure, and a human
re-audits the calibration set before the new judge's labels are trusted.

No CLI mode plans a bridge run: `--kind` accepts `full` and `canary`, and
`buildPlan` refuses anything else. What the harness contributes is the row's
standing — `bridge` is a valid ledger kind, `--validate --against` re-derives
its cross-key pairing, and `--report` renders it. Ordinary scoring refuses a
cross-key baseline.

## Establish the baseline

The baseline is the first `kind: "full"`, `status: "complete"` row on the
current `comparability_key`. Until one exists, every run reports without a
paired comparison and only the absolute floors apply.

Every later run pairs against that anchor, never against the run before it: a
five-point slide repeated four times never trips the per-run flip threshold,
but it does show against the anchor. The anchor moves only for a `PROMOTE`
row, which is where the runbook already requires a reviewed PR, and a
`pipeline` PROMOTE needs `replay` to corroborate it; from then on
that promoted row is the baseline of record. Baseline selection uses immutable
ledger append order. A backdated row cannot move ahead of the established
anchor because its machine clock was slow.

1. Merge the harness. The contract must be on `main` before anything is scored
   against it, so the spec worktree can find it.
2. Push and protect the eval tags:
   `git push origin 'refs/tags/eval/review-skill/v1/*'`, then add a repository
   ruleset denying deletion and update on `eval/**` tags. `--check-fixtures`
   resolves every tag against the checkout it runs on, in `--offline` mode too,
   so a checkout without the tags reports every one of them as missing and
   materialization falls back to `refs/pull/<n>/head` and records
   `tag_pinned: false`. CI fetches tags for exactly this reason.
3. Run `pnpm review:eval:run --kind full` from a clean checkout. Budget
   about $99 of contestant spend and two hours, plus the judge pass.
4. Prepare the artifacts with `review-eval-publication.mjs`, then use the
   `ship` workflow to open the ledger PR. Its body contains the complete
   generated report and the execution-authenticity limit. State that this row
   is the baseline of record and name the `comparability_key` it anchors.
5. A later baseline change is a PROMOTE row and needs its own reviewed PR
   saying what changed and why. A fixture refresh never rewrites a baseline.

## Operating point provenance

The pinned operating point — `gpt-5.6-sol` at high effort finding, then
`claude-opus-5` at high effort verifying and extending — comes from benchmark
v2, closed 2026-08-24. On the three-PR grid that pairing reached 64% recall
against the frozen truth, while every solo condition measured at or below 50%.
Treat that 64% as measured in the retired judge's units: the 2026-08-28
calibration re-audit rejected eight of that judge's twenty match labels — six by
modern-judge consensus, two on full-context adjudication — so comparisons against
it carry that inflation. The first re-keyed baseline sets the new reference.
The same benchmark supplied the six fixtures, the frozen truth, the frozen
finder reports for the `replay` condition, and the calibration pairs.

That measurement is now history. It justifies the pinned configuration; it is
not evidence that the configuration still works. The ledger is. If
`docs/evals/review-skill-ledger.jsonl` has no full run that reached
`status: "complete"` in the last 120 days, treat the operating point as
unverified: a failed run leaves a `kind: "full"` trace row, and that row
records that the harness tried, not that the pairing still scores.

Two paired screens run on 2026-09-02 asked whether adding the repo's own local
review adapter to that pairing found anything the pairing missed. Over PRs
1990, 1995 and 1999, the incumbent flow and the flow carrying the extra pass
scored 14 against 14 and 13 against 13 of 22 known defects, and 5 against 5 and
4 against 4 of the P1 subset. The adapter's own pass returned 1, 0 and 1
findings, none of them new; on PR 1995 it reported the patch correct while five
known defects went unfound. On this evidence issue 2239 drops that adapter from
the operating flow: the two-model operating point above is what carries the
recall. The adapter and its runtime are still in the tree at this commit; a
later change in that issue's stack deletes them.

## What this evaluation cannot tell you

- **The sample is small and will stay small.** Fifty-one defects, nine PRs,
  one repository, one two-week era of 2026. The design detects roughly a
  ten-point regression. A five-point real degradation passes as green.
- **The truth is a lower bound.** It is what four CI reviewers happened to
  raise and the author happened to fix. It over-weights defects that are easy
  to state in a comment, and it contains zero defects everyone missed. A
  reviewer that catches the one bug that would have caused an outage scores
  nothing for it.
- **The judge shares a model family with the verifier under test.**
  Self-preference is plausible and only partly measured.
- **`replay` drifts away from production.** It scores against a 2026-08 finder
  report while production uses whatever codex is that month. It stays because
  it removes the finder's sampling from the comparison, and it must never
  become the headline number. Its `claude` verifier is sampled fresh per cell,
  so it is not variance-free either.
- **Local execution is not reproducible by a third party.** Shell environment,
  MCP servers and CLI patch versions all leak in. Two developers running the
  same contract may legitimately differ by several defects.

## Moving files

Two pin classes make a rename of harness files non-trivial. The prompts under
`scripts/review/prompts/` are byte-frozen inputs: their `sha256` values live in
the contract, and `.trunk/trunk.yaml` ignores the directory so a formatter
cannot rewrite them — a move must carry the ignore entry and, for the two
contract-pinned run prompts, a digest recomputation. And `run-eval.sh` resolves
the harness and the prompts from a detached `origin/main` worktree, so a moved
path must exist on `main` before the first run after the moving commit.

## Files

| path                                                        | what it is                                               |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| `docs/evals/review-skill-fixtures.json`                     | the contract: PRs, pinned SHAs, scorable ids, thresholds |
| `docs/evals/review-skill-truth/`                            | frozen answer keys, one per PR                           |
| `docs/evals/review-skill-finder-reports/`                   | frozen codex reports for the `replay` condition          |
| `docs/evals/review-skill-judge-calibration.json`            | 40 frozen judge pairs                                    |
| `docs/evals/review-skill-result.schema.json`                | the schema for one ledger row                            |
| `docs/evals/review-skill-ledger.jsonl`                      | append-only score ledger, one row per run                |
| `docs/evals/review-skill-runs/`                             | per-run scored detail                                    |
| `scripts/review/review-eval.mjs`                            | the CLI                                                  |
| `scripts/review/review-eval-run.mjs`                        | the stable run-helper import facade                      |
| `scripts/review/review-eval-run-plan.mjs`                   | plan, input, matrix, and comparability-key construction  |
| `scripts/review/review-eval-run-execution.mjs`              | judge execution, environment scrub, and fixture reset    |
| `scripts/review/review-eval-run-cell.mjs`                   | cell identity, cache reuse, and leak signals             |
| `scripts/review/review-eval-run-score.mjs`                  | cell scoring, condition folds, rows, and freshness plans |
| `scripts/review/review-eval-score.mjs`                      | scorer logic and scoring-module digest ownership         |
| `scripts/review/review-eval-stream.mjs`                     | dependency-free stream parser, session budget, envelope  |
| `scripts/review/review-eval-cell-writer.mjs`                | one finished contestant stream to one cell result        |
| `scripts/review/review-eval-plan-evidence.mjs`              | plan, result, and calibration evidence checks            |
| `scripts/review/review-eval-run-evidence.mjs`               | matrix completeness and evidence reuse checks            |
| `scripts/review/review-eval-appended.mjs`                   | appended-row evidence revalidation                       |
| `scripts/review/review-eval-harvest-truth.mjs`              | answer-key harvester: first head, findings, frozen bytes |
| `scripts/review/review-eval-publication.mjs`                | current-key-safe local publication preparation           |
| `scripts/review/review-eval-publication.test.mjs`           | publication confinement and PR-body shape tests          |
| `scripts/review/review-eval-freshness-publication.mjs`      | publication-safe staleness issue synchronization         |
| `scripts/review/review-eval-freshness-publication.test.mjs` | staleness issue boundary tests                           |
| `scripts/review/review-eval-split-equivalence-fixtures.mjs` | generated Node and shell equivalence harnesses           |
| `scripts/review/testdata/review-eval-split-equivalence/`    | frozen split inputs and observable-behavior snapshot     |
| `scripts/review/review-eval-split-equivalence.test.mjs`     | frozen pre-split entry-point equivalence                 |
| `scripts/review/run-eval.sh`                                | the orchestrator that spends model quota                 |
| `scripts/review/run-eval-source-snapshot.sh`                | source authentication, sealing, restart, and cleanup     |
| `scripts/review/run-eval-lifecycle.sh`                      | locks, deadlines, failure traces, and publication        |
| `scripts/review/run-eval-runtime.sh`                        | skill staging, fixtures, cache, and cell runtime         |
| `scripts/review/run-eval-matrix.sh`                         | the PR-group matrix scheduler                            |
| `scripts/review/build-fixture.sh`                           | leak-proof fixture materialization                       |
| `scripts/review/launchd/`                                   | the monthly scheduler                                    |
| `.github/workflows/review-eval-freshness.yml`               | the LLM-free contract and freshness guard                |
| `.gitignore`                                                | local-only raw `cells/` transcript boundary              |
