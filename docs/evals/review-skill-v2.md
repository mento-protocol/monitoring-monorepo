---
title: Paired review evaluation v2
status: active
owner: eng
canonical: true
last_verified: 2026-09-30
doc_type: runbook
scope: ci/process
review_interval_days: 90
garden_lane: operator-runbooks
---

# Paired review evaluation v2

Use this diagnostic evaluation to compare two explicit review-skill snapshots.
It scores complete final reviews against audited root causes and checks repaired
counterparts. It preserves reviewer outputs when only the grading changes.
[ADR 0110](../adr/0110-paired-review-evaluation-v2.md) records the decision.

The [v1 evaluation](review-skill.md) retains its ledger, scheduler, and historical
scores. A v2 run cannot update that ledger, its baseline, or its freshness clock.

## Terms and evidence

- A **case** is a frozen source change, optionally with a pinned repair patch.
- A **family** groups an original PR and all its repaired variants. A family
  belongs to one split.
- A **root cause** is one distinct defect, even if several review comments
  describe it.
- A **negative control** is a repaired case where specified root causes are
  absent. Other defects can remain; it is not a globally clean PR.
- **Completion** means every planned reviewer and grading phase returned valid
  evidence. It does not establish that the candidate improves review quality.

The pilot contains two families and four cases. It audits optional repository
fallback, optional branch parsing, and trailing-newline parsing. Labels are
agent-audited and supported by executable source probes. They are not independent
human calibration. The original PRs have prior exposure. The PR-disjoint
confirmation split is prospective organization, not an unseen holdout.

Source probes accept only the four audited source and repair combinations in
`review-eval-v2-probe-trust.mjs`. The probe verifies the complete local import
closure by hash, copies those verified bytes into a private temporary directory,
and runs them with an empty environment. It never imports modules directly from
a supplied fixture. Adding a family requires source and repair review plus new
trust pins; a dataset file alone cannot authorize code execution.

## Plan and run

Freeze both skill directories before planning. Use explicit absolute paths.
Store the run outside the repository. Planning calls no model.

```bash
pnpm review:eval:v2 plan   --dataset "$PWD/docs/evals/review-skill-v2/dataset.json"   --incumbent /absolute/path/to/incumbent-review   --candidate /absolute/path/to/candidate-review   --out /absolute/path/to/eval-run

pnpm review:eval:v2 run --out /absolute/path/to/eval-run
pnpm review:eval:v2 report --out /absolute/path/to/eval-run
```

The pilot uses one draw for each arm of each case: eight reviewer calls, plus
calls for grading. It runs direct source review through Claude. It does not run
a live Codex finder or external security scanners. Provider concurrency is one.
The plan pins model, effort, skill content, source, and execution behavior.
Arm order alternates by sorted family ID and reverses for repaired cases.
The plan records this rule. Reordering cases does not change their arm order.
An odd number of families leaves one extra first position for one arm per variant.
The runner supplies the complete working-tree diff. Reviewers and source graders
can use Read, Grep, and Glob only. They cannot run tests or shell commands.

V2 requires a verified Claude subscription. Before every reviewer or grading
call, it checks `claude auth status --json` with the same environment, working
directory, and empty settings sources as the model call. API-key, alternate
provider, token override, logged-out, and unknown authentication are refused.
Managed policy files, cached remote policy, policy redirection, and macOS managed
preferences are also refused because the auth status probe cannot attest their
effective billing route. Relative `CLAUDE_CONFIG_DIR` and `HOME` paths resolve
against the model call's working directory when checking cached policy.
V2 does not offer an API billing mode. Sign in through the Claude subscription
account and remove provider or credential overrides before running.

Subscription runs have no campaign or per-call dollar stop. Provider-reported
dollar values remain API-equivalent usage estimates; they do not establish an
account charge. Missing usage stays unknown. Subscription service quotas and
account billing settings still apply. Each call retains its turn limit,
20-minute timeout, tool restrictions, and failure records. Concurrency stays one.

`--budget` is retired. Plans from the dollar-budget runtime require a new plan
and output directory. Keep their evidence with the original pinned runtime;
this change does not rewrite plans, ledgers, or cached results. The existing
execution identity checks still reject source drift.

A failed call or missing artifact leaves the run incomplete. Resume the same
run to reuse valid completed work. Do not retry a valid grade merely to obtain
a different judgment.

An A/A run supplies the same skill bytes to both arms. It qualifies the
execution and scoring path. Differences between its outputs reflect sampling;
they do not establish a skill improvement.

## Score and inspect

The caller requires one self-contained final review. The scorer reads that
artifact. Earlier observations and tool results remain available for diagnosis.
An incompatible historical transcript cannot be imported as a complete final
review merely because it has a last message.
Leak checks cover both the captured messages and the final text used for scoring.

Every eligible root cause reaches semantic matching regardless of file type.
A matched verdict carries a verbatim quote from the final review. Code checks
quote provenance; the grader still owns the semantic judgment. The scorer
retains every extracted claim and reports insufficient coverage explicitly.
Uncertain matches and unverifiable claims remain visible.
One extracted claim cannot satisfy two distinct matched roots. Claims linked to
uncertain root matches skip source-only novelty grading. The unresolved links
remain visible; a separate definite root match still counts normally.
Other unmatched claims still receive source-based grading.

Rescore saved reviewer outputs after a dataset or grader change:

```bash
pnpm review:eval:v2 score --out /absolute/path/to/eval-run   --dataset "$PWD/docs/evals/review-skill-v2/dataset.json"
pnpm review:eval:v2 report --out /absolute/path/to/eval-run
```

Rescoring must retain the plan's case IDs. It may reorder cases or revise labels.
To add or remove cases, create a new plan.

Reviewer identity excludes the answer key and grader. Grading identity includes
the immutable reviewer artifact, answer key and its selection code, grading
orchestration, scorer, prompts, and judge settings. Grading orchestration covers
score-cache identity, judge calls, and grading result handling. It lives outside
the reviewer execution module, as does answer-key selection. Judge-specific
command construction also belongs to grading identity. Shared authentication,
transport, and command restrictions remain pinned to both identities. Changes to
grading-only modules do not invalidate saved reviewer outputs. A scoring process pins
its grading source and prompts at startup and rejects later changes. After a
grading edit, start a new scoring process to reuse the saved reviews under the
new grading identity.
A source, skill, reviewer-prompt, runtime, or execution change requires a compatible new
execution identity. A grading-only change must not silently buy another review.

Read paired results by PR family. Inspect serious misses, claims about repaired
roots, other false or unsupported claims, and model-supported novel defects.
Include cost, duration, and incomplete cells. Multiple defects from one PR are
not independent experiments. The report does not promote a skill automatically.

## Validation and limits

```bash
pnpm review:eval:test
pnpm lint:scripts
pnpm docs:index --check
```

The tests and source probes validate dataset structure, source repairs, final-artifact handling,
evidence references, grading completeness, subscription authentication, usage accounting, and cache identity.
They do not establish model-grade accuracy. A meaningful accuracy claim needs
independent domain-expert labels for extraction, matching, and claim correctness,
with development and held-out examples. Broad review-quality claims also need
new PRs that did not guide candidate design.
[Issue #2556](https://github.com/mento-protocol/monitoring-monorepo/issues/2556)
tracks those evidence requirements.

Keep full execution artifacts private. Publish a reviewed summary that names
the source revisions, skill digests, planned/completed cells, grader provenance,
usage, result, and nearest unproven claim. Never publish credentials or unrelated
session content.
