---
title: Review-skill experiments use a separate staged non-ledger lane
status: active
owner: eng
canonical: true
last_verified: 2026-09-01
scope: ci/process
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0083 — Review-skill experiments use a separate staged non-ledger lane

**Status:** Accepted (Sep 2026), in force.
**Scope:** ci/process

## Context

The canonical review-skill evaluation has 24 model cells. It measures the full
finder, verifier, and control conditions. It also supplies the ledger verdict,
baseline, and freshness evidence. This matrix is too slow and costly for early
prompt experiments.

The existing three-cell canary cannot select a candidate safely. Its small P1
sample makes one match move the P1 rate by a large amount. Repeated use also
turns the visible fixtures into development data. A candidate-only live run
would add finder variance and model drift to the skill change.

## Decision

Add a separate review-skill experiment lane with these rules:

- The experiment lane writes to a private artifact root outside the repository.
  It never appends to the canonical ledger. It never updates a baseline or
  freshness clock.
- An experiment emits only `PROMISING`, `REJECT`, or `INCONCLUSIVE`. Only a
  complete canonical 24-cell run can emit `RED`, `GREEN`, or `PROMOTE`.
- A campaign starts with one complete immutable plan. The plan binds the
  contract, prompts, model identities, scorer, calibration set, orchestrator,
  stage order, cache identities, and a canonical full-rerun plan. It binds a
  mode-sensitive experiment skill digest for source sealing and the canonical
  content digest for the full-rerun fingerprint. The qualification section does
  not authorize artifact reuse.
- The first stage compares the incumbent and candidate on three frozen replay
  reports. A locked holdout stage uses the complementary three reports. An
  optional live-paired stage gives both arms the same newly generated finder
  report. The handoff uses a UTF-8 suffix of up to 30,000 bytes and retains the
  full raw output with separate raw and delivered digests. This stage requires
  a `PROMISING` holdout and applies the screen thresholds to its three pairs.
  One published finder receipt supplies both arms and every retry for that
  lane.
- The screen needs a known-match net of at least two, no P1 net loss, and a
  non-negative known-match delta on at least two PRs. A known-match net of minus
  two or less, or any P1 net loss, returns `REJECT`. Other misses return
  `INCONCLUSIVE`. Every arm must be complete, non-empty, and free of a hard
  leak signal. An empty candidate arm or candidate hard leak returns `REJECT`.
  Other invalid paired evidence returns `INCONCLUSIVE`.
- The combined screen and holdout need a known-match net of at least three, at
  least 9 of 12 candidate P1 matches, a P1 net of at least two, gains on at
  least two PRs, and at most one extra wrong claim. A known-match net of minus
  two or less, any P1 net loss, or a wrong-claim delta above one returns
  `REJECT`. Other threshold misses return `INCONCLUSIVE`.
- The scorer extracts claims and matches known defects first. It defers novel
  and wrong-claim classification until claim inflation requires it or the
  candidate reaches the finalist decision. Claim inflation requires a gain of
  at least three claims and a ratio of at least 1.25. Deferred novelty data is
  absent. It is never recorded as zero. When classification runs, a candidate
  wrong-claim delta above one returns `REJECT`.
- Raw output, known-match scoring, and novelty scoring have separate content
  identities. Reuse requires every input for that stage to match. Write-once
  atomic publication, self-digests, cache-lineage replay, and decision replay
  protect each persisted stage barrier. Stage validation also authenticates
  the exact calibration receipt and recomputes its frozen outcomes and
  agreement. Authentication means exact identity checks and unkeyed SHA-256
  self-digests inside the confined local artifact root. It does not protect
  against a hostile host user.
- A calibration receipt is reusable for at most six hours. Reuse also requires
  the exact judge model, effort, CLI, scorer, prompt, calibration-set, and host
  identities. A reused receipt must remain valid through the paid stage's
  effective absolute deadline. The runner shortens that deadline when the
  receipt expires first. Calibration must agree on at least 35 of 40 frozen
  pairs. Each published stage artifact records the publication validation time.
  The runner reopens and replay-validates it before returning the stage result.
- A campaign has an absolute deadline six hours after planning. Each paid stage
  fixes an absolute deadline at the earlier of three hours after its start or
  the campaign deadline. It derives that instant from the recorded stage and
  campaign timestamps before it arms the timer. One harness-launched model
  process can use at most one hour. Process termination covers the whole process
  group. The runner aborts a call when captured stdout would exceed 67,108,864
  characters. It retains the final 4,000 stderr characters. Contestant,
  tool-enabled novelty-judge, and blind-judge calls allow at most 80, 60, and 1
  turns, respectively.
- The runner can use at most three fixture lanes at once. On a cache miss, it
  runs the incumbent and candidate sequentially inside one fixture lane. It
  records the `AB` or `BA` order. Later candidates can reuse the exact
  campaign's incumbent artifacts under a candidate-neutral common-control ID.
- One campaign can register at most three candidates. One experiment stage can
  retry at most once after a handled failure or an operator-settled crash. A
  complete decision cannot get another sample. One active command can hold the
  campaign lock. A crash leaves a stale dead-owner lock. The runner does not
  reclaim it because paid process lineage cannot be proven settled. An operator
  must prove that lineage settled before removing the lock and using the one
  retry.
- Each artifact directory must be a child of
  `~/.cache/mento-review-eval-experiments/`. The mutable fixture base must be
  `~/.cache/mento-review-eval-experiment-fixtures/` or one of its children.
  Both roots must be outside the repository and disjoint from each other.
  Campaign, artifact-root, and candidate identities namespace mutable fixtures.
- The parent process seals all skill, truth, prompt, calibration, fixture
  script, and scorer inputs before paid work. It materializes all required
  fixtures before the first model call.
- The live finder, each contestant arm, and each tool-enabled novelty judge get
  a disposable fixture clone. The clone has copied Git objects, no remote, no
  hooks, the planned head, and a separate frozen base SHA. Cleanup removes each
  clone after its one model process.
- The plan skips script launchers. It records the real path, version, and
  executable-byte digest for the direct `claude` and `codex` provider binaries.
  A paid command verifies them again and invokes the recorded absolute paths.
  Claude user and judge prompts use stdin. Treatment instructions use a file
  inside the disposable clone. Every Claude call disables session persistence.
- Paid work requires Darwin `sandbox-exec`. The profile denies all registered
  worktrees, both global experiment roots, every treatment source root, and
  inspection of other processes. It permits self inspection for native runtime
  compatibility. It permits only the active fixture within the denied file
  roots. It wraps the live finder, contestant, and tool-enabled novelty judge.
  Other platforms fail closed. Live Seatbelt probes test the active fixture,
  every protected root, and other-process inspection before paid work.
- `--plan`, `--validate-plan`, `--evaluate`, and dry-run execution are
  model-free. Dry run lists fixture lanes without a call or dollar estimate.
  The plan records harness-scheduled paid work only. Recorded contestant cost
  excludes finder, judge, subagent, and child-CLI spend. The lane has no dollar
  cap or complete cost accounting. `--evaluate` accepts arbitrary result JSON
  and does not authenticate run or cache receipts. Its output is what-if data,
  not evidence.
- The qualification section is a canonical rerun plan only. No importer exists,
  and experiment artifact reuse is disabled. Every selected treatment must run
  all 24 canonical cells again.
- The current visible fixtures are development data. A later broad
  generalization claim requires a new holdout whose truth did not guide the
  candidate edit.

## Alternatives considered

- **Run the canonical matrix for every edit** — rejected because the time and
  model cost prevent rapid experiments.
- **Shrink the canonical matrix** — rejected because this would change the
  score of record and break comparison with existing ledger rows.
- **Promote from the existing canary** — rejected because three cells provide
  too little P1 evidence and one frozen report set can give a misleading pass.
- **Run only the candidate through a live finder** — rejected because finder
  sampling would confound the skill comparison.
- **Write experiment results to the canonical ledger with a new kind** —
  rejected because an experiment could then affect baseline selection or
  freshness logic.

## Consequences

- Most weak changes can stop after a small paired screen.
- A promising change pays for novelty scoring and live confirmation only when
  those stages add useful evidence.
- The experiment result is a selection aid. It is not release evidence and
  cannot make a candidate green.
- Cache reuse saves work only when the recorded identities prove that the
  reused cache entry measures the same input.
- Common-control reuse is limited to one exact campaign and its six-hour
  window.
- The Darwin profile is defense in depth. It uses `allow default`. It retains
  network and broad host filesystem access outside the protected roots. It is
  not adversarial containment. The runner removes four GitHub token variables
  but inherits other environment credentials. Tool-enabled processes can start
  subagents or child model CLIs. Process-group and time limits cover those child
  processes, but cost accounting does not. Deterministic tests and live
  Seatbelt probes are the validation boundary for this control.
- Experiment artifacts are not canonical evidence. The canonical runner reruns
  every required cell.
- The canonical evaluation stays unchanged and remains the final authority.

## Evidence

- Issue #2187
- `docs/evals/review-skill.md`
- `scripts/review/review-eval-experiment-cli-campaign.mjs`
- `scripts/review/review-eval-experiment-cli-evidence.mjs`
- `scripts/review/review-eval-experiment-cli-options.mjs`
- `scripts/review/review-eval-experiment-cli-plan.mjs`
- `scripts/review/review-eval-experiment-cli-run.mjs`
- `scripts/review/review-eval-experiment-cache.mjs`
- `scripts/review/review-eval-experiment-contract.mjs`
- `scripts/review/review-eval-experiment-core.mjs`
- `scripts/review/review-eval-experiment-decision.mjs`
- `scripts/review/review-eval-experiment-evidence.mjs`
- `scripts/review/review-eval-experiment-finder.mjs`
- `scripts/review/review-eval-experiment-isolation.mjs`
- `scripts/review/review-eval-experiment-novelty.mjs`
- `scripts/review/review-eval-experiment-prepare.mjs`
- `scripts/review/review-eval-experiment-process.mjs`
- `scripts/review/review-eval-experiment-run.mjs`
- `scripts/review/review-eval-experiment-runtime.mjs`
- `scripts/review/review-eval-experiment-seal.mjs`
- `scripts/review/review-eval-experiment-stage-evidence.mjs`
- `scripts/review/review-eval-experiment.mjs`
- `scripts/review/review-eval-experiment.test.mjs`
- `scripts/review/review-eval.mjs`
- `scripts/review/review-eval-ledger.mjs`
