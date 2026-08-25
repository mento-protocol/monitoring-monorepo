---
title: Review Skill Evaluation
status: active
owner: eng
canonical: true
last_verified: 2026-08-25
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
what is measured. The skill under test is snapshotted once, before the first
cell, and every cell stages from that snapshot: the plan records one skill
digest for the whole matrix, and two hours is long enough to edit the installed
skill under a running evaluation. A snapshot that no longer matches the planned
digest refuses the run instead of mixing two treatments into one row. Every
cell writes its own resumable output directory, and a failed cell is never
cached — a finder that exits non-zero fails its cell even when it wrote a
partial report, because a truncated review cached is a permanent zero-recall
score. A cached cell is reused only when its stored
fingerprint — skill digest, kind, contract digest — matches the current run,
and the run directory carries the kind and the skill digest in its name, so an
aborted run followed by a skill edit re-runs instead of scoring the old skill
under the new digest. The run stops at a six-hour deadline and reports a
partial matrix rather than a table with quietly missing cells. A PR whose
draw-2 cell never ran is scored on draw 1 alone: the defect's bit vector is as
long as the draws its own PR completed, so a missing cell shrinks the
denominator instead of recording misses that were never possible.

To evaluate a candidate skill, run it against the installed one in one sitting:

```bash
pnpm review:eval:run -- --kind full --skill-ref ~/work/review-candidate
```

That stamps `skill_ref` and `dirty: true` into the ledger row. Never compare a
candidate against a ledger row from three months ago: that comparison silently
includes an unknown amount of model drift.

The run ends by printing the branch, commit and `gh pr create` commands for the
ledger PR. Pass `--pr` to execute them instead. There is no auto-merge; a human
reads the twenty-line report and approves.

### Install the scheduler

The plist is a template. A plist has no variable substitution, so the install
step substitutes its two placeholders: `__REPO_CHECKOUT__` (the checkout that
holds `run-eval.sh`) and `__USER_HOME__` (the log location). Run this from the
root of your checkout.

```bash
sed -e "s|__REPO_CHECKOUT__|$PWD|g" \
    -e "s|__USER_HOME__|$HOME|g" \
    scripts/review/launchd/org.mento.review-eval.plist \
    > ~/Library/LaunchAgents/org.mento.review-eval.plist
grep -q "$PWD/scripts/review/run-eval.sh" ~/Library/LaunchAgents/org.mento.review-eval.plist
launchctl bootstrap gui/"$(id -u)" ~/Library/LaunchAgents/org.mento.review-eval.plist
launchctl kickstart -p gui/"$(id -u)"/org.mento.review-eval   # optional smoke test
```

The `grep` is the check that the substitution actually landed: launchd reports
a missing program only in its log, and a template that silently kept someone
else's home directory would look installed while never running.

It fires on the 8th at 10:20 and logs to
`~/Library/Logs/mento-review-eval.log`. launchd, not cron: a laptop is asleep
at that hour about half the time, and launchd runs a missed calendar interval
on the next wake while cron drops it. `--kind auto` reads the ledger and picks
`full` when the last full run is more than 100 days old, otherwise `canary`.

## Read the verdict

| verdict        | it means                                                                                                                                                                                                                      | do this                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **GREEN**      | nothing below fired                                                                                                                                                                                                           | merge the ledger PR                                                       |
| **AMBER**      | recall below baseline but McNemar not significant; or fewer than three paired defects, which never ranks; or the run did not complete; or judge calibration under 38/40; or a leak signal; or `control` moved with `pipeline` | merge the row, do not rank on it, read the reason                         |
| **RED**        | `b − c ≥ 6` net flips; or pooled P1 recall under 0.60 where P1 was measured; or wrong claims at twice the baseline rate, the baseline floored at one; or a condition found nothing on two or more PRs                         | open a priority issue naming the flipped defects before changing anything |
| **PROMOTE**    | `c − b ≥ 6` and the change was intentional                                                                                                                                                                                    | re-anchor the baseline in a PR that says what changed and why             |
| **INCOMPLETE** | the run failed, or a canary did not finish                                                                                                                                                                                    | fix the harness and re-run; the row stays as a trace                      |

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
                           scorer_digest ‖ calibration_digest ‖ judge_model)
```

`scorer_digest` covers every module that can move a recorded number or a
recorded verdict — the scorer, the per-condition fold, the recompute and the
verdict rules — not the extraction alone. An edit to any of them re-anchors the
series, which is the conservative direction: a refused comparison is visible,
a silently paired one is not.

`--report` refuses to compute McNemar across rows with different
`comparability_key` unless the row is a bridge run, and `--score --against`
stores `vs_baseline.mcnemar: null` for such a pair rather than numbers nobody
may read. Rows with different keys are different series and plot separately.

| drift vector      | control                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------- |
| fixture content   | eval tags plus a tree-hash check in `build-fixture.sh`                                        |
| truth content     | committed verbatim, per-file `sha256`, never re-derived from the API                          |
| scorable set      | explicit frozen id list in the contract                                                       |
| run prompts       | frozen files with `sha256` in the contract                                                    |
| scoring pipeline  | `scorerDigest()` over the scorer, run, result-shape and report modules and every judge prompt |
| judge model       | model id and CLI version in the row, plus 40 calibration pairs every run                      |
| calibration set   | its `sha256` is bound into `comparability_key`                                                |
| reviewed model    | isolated by the `control` condition; model id and CLI version recorded                        |
| skill text        | `skill_digest` over `SKILL.md` and `references/**` — this is the treatment                    |
| `codex-review.sh` | `codex_review_sh_digest`                                                                      |
| machine and shell | host, CLI versions, `--setting-sources ""`, clean worktree of `origin/main`                   |

**Judge calibration runs before every scoring pass.** Forty frozen
`(claim, defect, verdict)` pairs replay through the current judge. Agreement
under 38/40 marks the run AMBER and excludes it from baseline comparison. It
costs about $2 and it is the only mechanism that separates "the review skill
regressed" from "the `claude-opus-5` alias now points at different weights and
the scorer got stricter".

**Model retirement needs a bridge run.** Pinned models get retired and history
cannot be re-run. When that happens, run old and new model on the same day, on
the same machine, both `kind: full`, and append one row with `kind: "bridge"`
recording both scores and the delta. Then re-anchor the baseline to the new
model. Never swap a model and keep comparing against the old baseline. A judge
retirement follows the same procedure, and a human re-audits the calibration
set before the new judge's labels are trusted.

## Establish the baseline

The baseline is the first `kind: "full"`, `status: "complete"` row on the
current `comparability_key`. Until one exists, every run reports without a
paired comparison and only the absolute floors apply.

Every later run pairs against that anchor, never against the run before it: a
five-point slide repeated four times never trips the per-run flip threshold,
but it does show against the anchor. The anchor moves only for a `PROMOTE`
row, which is where the runbook already requires a reviewed PR; from then on
that promoted row is the baseline of record.

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

## Files

| path                                             | what it is                                               |
| ------------------------------------------------ | -------------------------------------------------------- |
| `docs/evals/review-skill-fixtures.json`          | the contract: PRs, pinned SHAs, scorable ids, thresholds |
| `docs/evals/review-skill-truth/`                 | frozen answer keys, one per PR                           |
| `docs/evals/review-skill-finder-reports/`        | frozen codex reports for the `replay` condition          |
| `docs/evals/review-skill-judge-calibration.json` | 40 frozen judge pairs                                    |
| `docs/evals/review-skill-result.schema.json`     | the schema for one ledger row                            |
| `docs/evals/review-skill-ledger.jsonl`           | append-only score ledger, one row per run                |
| `docs/evals/review-skill-runs/`                  | per-run scored detail                                    |
| `scripts/review/review-eval.mjs`                 | the CLI                                                  |
| `scripts/review/run-eval.sh`                     | the orchestrator that spends model quota                 |
| `scripts/review/build-fixture.sh`                | leak-proof fixture materialization                       |
| `scripts/review/launchd/`                        | the monthly scheduler                                    |
| `.github/workflows/review-eval-freshness.yml`    | the LLM-free contract and freshness guard                |
