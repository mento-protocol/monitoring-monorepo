---
title: Review Skill Evaluation
status: active
owner: eng
canonical: true
last_verified: 2026-08-29
doc_type: runbook
scope: ci/process
review_interval_days: 90
garden_lane: operator-runbooks
---

# Review skill evaluation

This evaluation measures whether the `review` skill still finds real defects in
real pull requests from this repository. It replays six merged PRs at the
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
It was harvested once, on 2026-08-21, and frozen as bytes. It is never
re-derived from the GitHub API, because comments get edited, bodies get deleted
and bots get renamed. The contract records a `sha256` for every truth file.

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

| condition  | what it runs                                          | why it exists                                                          |
| ---------- | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `pipeline` | live `codex exec review` then `claude` with the skill | the number of record; exactly what production does                     |
| `replay`   | the frozen finder report then `claude` with the skill | zero finder sampling variance; the only variance-free signal           |
| `control`  | the bare pinned model, no skill, no codex             | if control and pipeline fall together the model moved, not our tooling |

`control` is the cheapest line item and carries the most interpretive weight.
Cut it last.

Per condition the run records recall, P1 recall, novel-real count,
wrong-claims count, dollars, seconds, and a per-defect bit vector for every
draw. The bit vector is the load-bearing field: every later comparison runs on
committed booleans, so no model is ever re-invoked to compare two months. A
condition's dollars are its contestant cells alone; what the judges cost is
recorded once per row as `scoring_usd`, and the report prints both.

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
`pipeline` over every fixture in two draws, `replay` over the grid fixtures in
one draw per frozen finder report and `control` over every fixture in one draw;
a canary is `replay` over every grid fixture in one draw. Both axes are checked,
which PRs each condition scored and how many draws it recorded. A complete full
row is the score of record — it refreshes the full-run clock and becomes the
automatic baseline — and a complete canary is read against
`canary_min_matched_grid`, so neither may claim its matrix on a subset of it.

Then plan and run. `--plan` prints the matrix and the cost estimate without
spending anything.

```bash
pnpm review:eval -- --plan --kind canary --json   # 3 cells, about $15, ~25 min
pnpm review:eval -- --plan --kind full --json     # 24 cells, about $88, ~2 h
pnpm review:eval:run -- --kind canary             # the monthly smoke test
pnpm review:eval:run -- --kind full               # the quarterly score of record
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
helper copies the wrapper and the other two sourced helpers, creates a PID-bound
random owner marker, seals the directory, and restarts the wrapper. The
restarted process accepts only that sealed, non-symlink direct child. The
read-only directory and files prevent in-place writes and entry replacement
before a later helper source. Cleanup unlinks only the four fixed source files
and the authenticated marker, then removes the empty directory. Every later
helper stage uses the same snapshot. Before a paid cell starts, the snapshot
helper recomputes the framed source digest and requires the persistent plan to
record the same digest. An edit during planning makes the run stop instead of
executing bytes outside its recorded provenance. The skill
under test is snapshotted once, before the first cell, and every cell stages
from that snapshot: the plan records one skill
digest for the whole matrix, and two hours is long enough to edit the installed
skill under a running evaluation. A snapshot that no longer matches the planned
digest refuses the run instead of mixing two treatments into one row. Every
cell writes its own resumable output directory, and a failed cell is never
cached — a finder that exits non-zero fails its cell even when it wrote a
partial report, because a truncated review cached is a permanent zero-recall
score. A cached cell is reused only when its stored
fingerprint — skill digest, kind, contract digest, the two CLI versions, the
finder argv digest and the orchestrator digest — matches the current run. The
one cache-compatibility rule accepts the recorded pre-split orchestrator digest
only when the current digest is the exact reviewed four-source split with
the sealed source-snapshot provenance guard. It requires one complete,
historically valid legacy treatment pair: `installed` with `dirty: false`, or a
normalized absolute candidate path with `dirty: true`. Raw-cell reuse stays
keyed to the recorded skill bytes. The tests reconstruct the pre-split
bytes from the extracted payloads and exercise the stable-source behavior of the
final wrapper. An edit to the wrapper or any of the three helpers changes the
current digest and disables this rule. The
scorer preserves that fingerprint and a separate installed-or-candidate
treatment identity in every result and in `calibration.json`. Local validation
and CI check both records against the plan. Changing only the row and plan
inputs cannot relabel a candidate as an installed run. The run directory
carries the kind and the skill digest in its name, so an
aborted run followed by a skill edit re-runs instead of scoring the old skill
under the new digest. A run that ends before it scores keeps its cells on disk
for that retry — publishing strips them from the commit with an exclude
pathspec rather than deleting them — and only a run that reached a score
removes them, having nothing left to resume. The directory belongs to one
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
the run returns, even when the direct child exits first. A PR whose
draw-2 cell never ran is scored on draw 1 alone: the defect's bit vector is as
long as the draws its own PR completed, so a missing cell shrinks the
denominator instead of recording misses that were never possible.

To evaluate a candidate skill, run it against the installed one in one sitting.
Run the installed skill first, **publish its row before starting the
candidate**, then name that row as the candidate's baseline with `--against`:

```bash
pnpm review:eval:run -- --kind full --pr    # publish the installed row first
git -C . checkout main                      # the candidate run branches from here
pnpm review:eval:run -- --kind full --skill-ref ~/work/review-candidate \
  --against "${TMPDIR:-/tmp}/review-eval-installed-row.json" --pr
```

The baseline is that file, not the installed row's `executed_at`. Publishing
commits the row and its detail directory on the new `eval/review-skill-*`
branch and leaves the checkout there; `git checkout main` then deletes both,
because neither exists on local main. An `--against` naming the `executed_at`
would resolve against a ledger that no longer holds the row and the candidate's
pre-flight would abort — the right failure, and still a wasted installed run.
So a successful `--pr` on an installed run keeps one copy of `row.json` outside
the checkout, where no branch switch reaches it, and logs the exact `--against`
argument. A row carries every bit the comparison reads, so no detail directory
is needed for the baseline.

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

The run ends by printing the branch, commit and `gh pr create` commands for the
ledger PR. Pass `--pr` to execute them instead. There is no auto-merge; a human
reads the forty-line report and approves.

A run that fails publishes the same way. Its `status: failed` row is already in
the checkout's ledger, and a run that leaves it there uncommitted wedges the
schedule: the next run refuses to start against a ledger with uncommitted
changes, and nothing reaches the freshness workflow. A scored row wedges it the
same way, and the installed job runs without `--pr`, so both endings follow one
rule: with `--pr` the row gets its own PR and the run exits zero; without it the
run prints the publish commands and exits non-zero, so launchd records that a
human still has to finish the job.

### Install the scheduler

The plist is a template. A plist has no variable substitution, so the install
step replaces three placeholders: `__REPO_CHECKOUT__` (the checkout that holds
`run-eval.sh`), `__USER_HOME__` (the log location), and `__RUNTIME_PATH__` (the
current `PATH` after the installer verifies `node`, `git`, `codex`, and
`claude`). launchd does not inherit values that a login startup file exports.
The installed job uses fixed `/bin/zsh` and `/bin/bash` interpreters. The login
shell loads model credentials, then the command restores the captured path
before it invokes the runner. Run this from the root of your checkout.

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

## Read the verdict

| verdict        | it means                                                                                                                                                                                                                      | do this                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **GREEN**      | nothing below fired                                                                                                                                                                                                           | merge the ledger PR                                                       |
| **AMBER**      | recall below baseline but McNemar not significant; or fewer than three paired defects, which never ranks; or the run did not complete; or judge calibration under 35/40; or a leak signal; or `control` moved with `pipeline` | merge the row, do not rank on it, read the reason                         |
| **RED**        | `b − c ≥ 6` net flips; or pooled P1 recall under 0.60 where P1 was measured; or wrong claims at twice the baseline rate, the baseline floored at one; or a condition found nothing on two or more PRs                         | open a priority issue naming the flipped defects before changing anything |
| **PROMOTE**    | `c − b ≥ 6` and the change was intentional                                                                                                                                                                                    | re-anchor the baseline in a PR that says what changed and why             |
| **INCOMPLETE** | the run failed, or a canary did not finish                                                                                                                                                                                    | fix the harness and re-run; the row stays as a trace                      |

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
than nine of the twenty-two grid defects, or any run emits no parseable
finding.

## The noise rule

**Never rank on fewer than three defects.** Thirty-four defects across six PRs
with two draws is 68 opportunities, and draws on the same defect are
correlated, so the effective sample is smaller than it looks. The
pre-registered red line is `b − c ≥ 6` net flips on the paired per-defect
vectors; at `b + c = 10`, `b = 8` gives a one-sided p of about 0.055. Anything
below six flips is the noise floor. The rule is written down here so nobody
re-derives it after seeing a result they dislike.

`verdict()` enforces the floor: when a candidate and its baseline share fewer
than `noise_floor_defects` scored defects, the row is AMBER and the reason says
the comparison was refused. It never reads as green, and it never promotes.

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
process execution, cell identity and leak checks, condition folding, row
assembly, the recompute, timestamp validation, and verdict rules. It also
covers the two fixture helpers:
`review-eval-fixtures.mjs` picks the matrix, the truth file and the recall
denominator, and `build-fixture.sh` materializes the checkout the contestant
reviews and carries the checks that verify it, so an edit to either moves what
was reviewed or what it was scored against. `orchestrator_digest` is a
length-framed digest over `run-eval.sh`,
`run-eval-source-snapshot.sh`, `run-eval-lifecycle.sh`, and
`run-eval-runtime.sh`. Together they fix source authentication, sealing,
restart and cleanup, plus the contestant's allowed tools, turn limit, skill
staging, finder-report truncation, and cell environment. They shape the
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

| drift vector      | control                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| fixture content   | eval tags plus a tree-hash check in `build-fixture.sh`, whose bytes are in `scorerDigest()`                  |
| truth content     | committed verbatim, per-file `sha256`, never re-derived from the API                                         |
| scorable set      | explicit frozen id list in the contract                                                                      |
| run prompts       | frozen files with `sha256` in the contract                                                                   |
| scoring pipeline  | `scorerDigest()` over the scorer, run, result-shape, ledger, report and fixture files and every judge prompt |
| judge model       | model id and CLI version in the row, plus 40 calibration pairs every run                                     |
| calibration set   | its `sha256` is bound into `comparability_key`                                                               |
| reviewed model    | isolated by the `control` condition; model id and CLI version recorded                                       |
| skill text        | `skill_digest` over every file in the skill directory, symlinks refused — this is the treatment              |
| finder command    | `argv` pinned in the contract; `finder_argv_digest` records what a cell spawned                              |
| orchestrator      | length-framed digest over the wrapper and three helpers: in the key and every cell fingerprint               |
| machine and shell | host, CLI versions, `--setting-sources ""`, clean worktree of `origin/main`                                  |
| CLI upgrade       | versions in every cell fingerprint; a pair across one is labelled in the verdict, not in the key             |

**Judge calibration runs before every scoring pass.** Forty frozen
`(claim, defect, verdict)` pairs replay through the current judge. Agreement
under 35/40 marks the run AMBER (floor = the contract judge's measured 37/40 blind baseline on the audited set minus a two-pair drift margin; re-anchor on any judge or set change), excludes the row from baseline comparison, and
keeps it off the full-run freshness clock. It costs about $2 and it is the only
mechanism that separates "the review skill regressed" from "the judge alias now
points at different weights and the scorer got stricter". It fired on the very
first baseline run (2026-08-28): the original labels — the frozen 2026-08
judge's own decisions — scored 29/40 against two independent modern judges,
which agreed with each other on 36/40. The set was re-audited against the modern
consensus, which held for all six matched -> unmatched flips. All three
unmatched -> matched flips it proposed were declined on full context: each cited
the same file while describing a different problem, so both blind modern judges
share an over-matching bias on file overlap and that direction has to be
adjudicated, not trusted. Six records were then replaced with fresh matched
pairs so the set still clears the balance guard at 18 matched / 22 unmatched
(provenance in the calibration file). The contract judge is now
`claude-fable-5` at max effort, the judge whose full-context adjudication
settled the contested labels.

The forty outcomes are written to `calibration.json` in the run's detail
directory. `--validate` re-derives `agreement` and `total` from them and checks
each `expected` against the frozen pair, so the gate that caps a run at AMBER is
evidence on disk rather than two integers the row states about itself. A detail
directory holding cell results but no `calibration.json` fails validation.

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
row, which is where the runbook already requires a reviewed PR; from then on
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
3. Run `pnpm review:eval:run -- --kind full` from a clean checkout. Budget
   about $88 and two hours.
4. Open the ledger PR. Its body is the generated report. State in the PR
   description that this row is the baseline of record and name the
   `comparability_key` it anchors.
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

## What this evaluation cannot tell you

- **The sample is small and will stay small.** Thirty-four defects, six PRs,
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
  it is the only variance-free signal, and it must never become the headline
  number.
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
| `scripts/review/review-eval-plan-evidence.mjs`              | plan, result, and calibration evidence checks            |
| `scripts/review/review-eval-run-evidence.mjs`               | matrix completeness and evidence reuse checks            |
| `scripts/review/review-eval-appended.mjs`                   | appended-row evidence revalidation                       |
| `scripts/review/review-eval-split-equivalence-fixtures.mjs` | generated Node and shell equivalence harnesses           |
| `scripts/review/testdata/review-eval-split-equivalence/`    | frozen split inputs and observable-behavior snapshot     |
| `scripts/review/review-eval-split-equivalence.test.mjs`     | frozen pre-split entry-point equivalence                 |
| `scripts/review/run-eval.sh`                                | the orchestrator that spends model quota                 |
| `scripts/review/run-eval-source-snapshot.sh`                | source authentication, sealing, restart, and cleanup     |
| `scripts/review/run-eval-lifecycle.sh`                      | locks, deadlines, failure traces, and publication        |
| `scripts/review/run-eval-runtime.sh`                        | skill staging, fixtures, cache, and cell runtime         |
| `scripts/review/build-fixture.sh`                           | leak-proof fixture materialization                       |
| `scripts/review/launchd/`                                   | the monthly scheduler                                    |
| `.github/workflows/review-eval-freshness.yml`               | the LLM-free contract and freshness guard                |
