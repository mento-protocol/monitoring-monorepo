---
title: Verification Redesign M4 Shadow Evidence
status: draft
owner: eng
canonical: false
last_verified: 2026-09-01
doc_type: report
scope: ci/process
review_interval_days: 30
garden_lane: notes-plans-archive
---

# Verification Redesign M4 Shadow Evidence

This receipt records the evidence window for
[issue #2126](https://github.com/mento-protocol/monitoring-monorepo/issues/2126).
It freezes the sample and cost rules. It also records the first eligible run's
retained-target scope and cost incident.

This receipt authorizes no cutover, schedule, ruleset change, local-gate
removal, legacy deletion, or merge. Each action needs the separate approval
defined in [ADR 0078](../adr/0078-staged-verification-redesign.md). Required CI
remains merge authority during this evidence window.

## Sources

- [ADR 0078](../adr/0078-staged-verification-redesign.md)
- [Phase 0 evidence](../notes/verification-redesign-phase-0-evidence.md)
- [Issue #2126](https://github.com/mento-protocol/monitoring-monorepo/issues/2126)
- [M4 additive complexity receipt](verification-redesign-m4-complexity.json)
- [M4 implementation PR #2186](https://github.com/mento-protocol/monitoring-monorepo/pull/2186)
- [No-skip permission repair PR #2197](https://github.com/mento-protocol/monitoring-monorepo/pull/2197)
- [Approved spend ceiling and stop condition](https://github.com/mento-protocol/monitoring-monorepo/issues/2126#issuecomment-5490125645)

GitHub retains the raw Actions job and log detail for 90 days. This committed
receipt retains the derived result and source links. `eng` owns collection and
classification. A human maintainer owns spend, cutover, ruleset, merge, and
legacy-deletion decisions.

## Frozen sample contract

The evidence window uses these rules:

1. Select one immutable head from each distinct pull request.
2. Count each pull request once. More heads or attempts do not increase the
   pull-request count.
3. A same-head audit observation becomes eligible when it reaches the audit job
   graph. Count its pull request in the acceptance cohort even when an audit
   job fails, cancels, flakes, or has an infrastructure failure, unless rule 9
   applies.
4. Do not count a graph-construction or startup failure that creates zero audit
   jobs. Record it as a pre-window incident.
5. Use the qualifying workflow's `createdAt` calendar date in UTC as the
   sampled date. Use the no-skip run for a same-head audit observation. Use the
   ordinary CI run for an ordinary-force-all observation. Order eligible
   distinct pull requests by that timestamp, then by pull-request number for
   equal timestamps. The acceptance cohort is the earliest prefix that
   contains at least 10 pull requests and spans at least seven inclusive UTC
   dates. The last sampled date minus the first sampled date must be at least
   six days.
6. Report median and maximum values over the full acceptance cohort. Report each
   ordinary CI metric and no-skip metric separately. An ordinary-force-all row
   has `N/A` no-skip metrics. Exclude `N/A` values from that metric's numeric
   aggregate and report its observed numerator and cohort denominator. Do not
   report p95 from this cohort.
7. Keep ordinary path-gated `CI` and no-skip audit measurements separate.
8. Classify every failure before a cutover decision. Any product failure found
   only by no-skip CI because path selection omitted its failing job stops the
   rollout.
9. Preserve an eligible run as incident evidence and charge its runner minutes
   when the run proves that the audit target or measurement instrument is
   wrong. Exclude that run from a repaired cutover-acceptance cohort. Stop the
   evidence window until the target is repaired and reviewed. Start the
   acceptance cohort again with the repaired target.
10. Use an ordinary-force-all observation for a pull request that changes a
    package-execution path and therefore cannot enter no-skip. The protected
    `controlPlane` filter must select every retained job. All aggregate
    dependencies and `CI / ci` must conclude `success`. The pull request must
    not change the evidence instrument. Instrument drift cannot count through
    either evidence form. A skipped, missing, or failed retained job invalidates
    the observation. The row can cover package, dependency, toolchain, and
    supply-chain risk. It cannot support cold-audit cost claims.

Rules 1 through 8 were drafted before the first eligible run. Rule 9 makes the
instrument-validity condition explicit after that run exposed a wrong retained
target. Rule 10 repairs the package-risk coverage conflict before the repaired
cohort starts. Neither rule discards the incident or its spend.

Selection is purposive. It targets the required risk classes and does not
represent the full pull-request population. This sample is not a fault canary.
The separate deterministic fault cases in issue #2126 own failed, cancelled,
missing, unexpected, and stale outcome coverage.

## Frozen time and cost formulas

Record these workflow values separately for ordinary `CI` and no-skip:

- **Wall time:** workflow `updatedAt - createdAt`.
- **Time to first useful failure:** terminal timestamp of the earliest failed
  job later classified as actionable, minus that workflow's `createdAt`. Use
  `N/A` when no useful failure occurs. Record the later classification time
  separately when operator latency matters.
- **Runner minutes:** sum the elapsed job windows for every non-skipped job
  across all attempts, then divide by 60. Exclude a copied job when its start
  time predates that attempt's creation time.
- **Retries:** record every attempt and its classified reason. A copied job is
  not a new execution.

Record **time to first terminal required result** once for the pull-request
head under ordinary CI. It is the earliest terminal live-ruleset context minus
the ordinary `CI` workflow's `createdAt`. The non-required no-skip run does not
produce this metric.

The approved no-skip limits are 45 runner-minutes for one run and 450
cumulative runner-minutes for this initial sample. Stop after any run exceeds
45 runner-minutes. Do not start another run when it could exceed 450 cumulative
runner-minutes.

Ordinary `CI` runner minutes do not consume the no-skip ceiling. External
required checks, separate workflows, and provider results do not enter either
workflow's runner-minute sum.

## Pre-window incident

| Field                                         | Recorded value                                                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run                                           | [33513837085](https://github.com/mento-protocol/monitoring-monorepo/actions/runs/33513837085)                                                       |
| Created                                       | 2026-09-01T13:30:50Z                                                                                                                                |
| Candidate                                     | PR #2173 at `53f6fee0dbae03e897a9f2603ee94f3807ff6c39`                                                                                              |
| Protected workflow revision and admitted base | `b235deda17f07f79107e7a5d3efb973712b62aa0`                                                                                                          |
| Result                                        | `startup_failure`                                                                                                                                   |
| Audit jobs                                    | 0                                                                                                                                                   |
| Runner minutes                                | 0                                                                                                                                                   |
| Sample disposition                            | Does not count                                                                                                                                      |
| Cause                                         | The reusable `ci.yml` requested a broader workflow permission ceiling than the caller supplied. GitHub rejected the graph before job creation.      |
| Repair                                        | [PR #2197](https://github.com/mento-protocol/monitoring-monorepo/pull/2197) aligned the caller and reusable-workflow read-only permission ceilings. |

This incident predates the evidence window. It does not consume a sample slot
or the runner-minute ceiling.

## Cold-proof attempt on PR #2199: retained-target scope and cost incident

This section records the first eligible cold proof against
[PR #2199](https://github.com/mento-protocol/monitoring-monorepo/pull/2199).
The dispatcher re-read the open same-repository pull request, its exact head,
its exact `main` base, and the current protected-`main` SHA. Admission passed
and the full audit graph existed. The run remains eligible incident evidence,
but its target included four legacy local-gate steps. It is not Sample 1 of the
repaired acceptance cohort. The evidence window is stopped until the repair
reaches protected `main`. No further dispatch or schedule is authorized.

This receipt does not grant dispatch authority. The user's current instruction
authorized the first eligible cold proof on PR #2199. Run
[33527909998](https://github.com/mento-protocol/monitoring-monorepo/actions/runs/33527909998)
consumed that one-shot authority. Later sample runs remain subject to the linked
45-runner-minute per-run and 450-runner-minute cumulative approval, the stop
conditions, and explicit operator selection and coordination. This receipt
adds no schedule.

### Identity and classification

| Field                      | Value                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| Incident status            | Eligible rollout-stopping incident; excluded from the repaired acceptance cohort           |
| Pull request               | [#2199](https://github.com/mento-protocol/monitoring-monorepo/pull/2199)                   |
| Incident UTC date          | 2026-09-01 from the no-skip run's `createdAt`                                              |
| Coverage class             | Root or control-plane; incident evidence only, with no post-repair coverage credit         |
| Dispatch authorization     | Consumed by run 33527909998                                                                |
| Workflow revision          | `fc72e7261093368265e0c8ae2cc895494d376838`                                                 |
| Source SHA                 | `aaec838c489c94fa4975a6ed3690d9fde8ea2582`                                                 |
| Base SHA                   | `fc72e7261093368265e0c8ae2cc895494d376838`                                                 |
| Purposive-selection reason | First eligible post-permission-repair cold proof; exercises a root or control-plane change |
| Observation snapshot       | Terminal no-skip run `updatedAt` 2026-09-01T15:59:23Z                                      |

### Ordinary path-gated CI

| Field                                  | Value                                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Workflow run and attempt IDs           | [33524301322](https://github.com/mento-protocol/monitoring-monorepo/actions/runs/33524301322), attempt 1 |
| Selected jobs                          | All 20 ordinary `CI` jobs, including the aggregate; see the linked run                                   |
| Result                                 | Success                                                                                                  |
| Failed job                             | N/A                                                                                                      |
| Wall time                              | 34 minutes 34 seconds                                                                                    |
| Time to first terminal required result | Pending: Vercel supplied no timestamps; earliest timestamped required result was Sentry at 71 seconds    |
| Time to first useful failure           | N/A                                                                                                      |
| Runner minutes                         | 69.15 across 20 non-skipped job windows                                                                  |
| Retries and reasons                    | None; attempt 1 only                                                                                     |
| Product failures                       | None observed                                                                                            |
| Flakes                                 | None observed                                                                                            |
| Cancellations                          | None                                                                                                     |
| Infrastructure failures                | None observed                                                                                            |

### No-skip audit

| Field                                   | Value                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Workflow run and attempt IDs            | [33527909998](https://github.com/mento-protocol/monitoring-monorepo/actions/runs/33527909998), attempt 1 |
| Created                                 | 2026-09-01T15:47:37Z                                                                                     |
| Completed                               | 2026-09-01T15:59:23Z                                                                                     |
| Executed jobs                           | Admission plus all 20 jobs from ordinary `CI`; the audit duplicated the full ordinary graph              |
| Result                                  | Cancelled after the operator stopped the run for the retained-target scope and cost incident             |
| Failed or cancelled job                 | Root scripts cancelled; aggregate `ci` failed because the no-skip contract rejects cancellation          |
| Wall time                               | 11 minutes 46 seconds, or 11.77 minutes                                                                  |
| Time to first useful failure            | N/A; no product failure occurred                                                                         |
| Runner minutes                          | 43.48                                                                                                    |
| Cumulative no-skip runner minutes       | 43.48 of 450                                                                                             |
| Retries and reasons                     | None; attempt 1 only                                                                                     |
| Product failures                        | None observed                                                                                            |
| Product failure found only by no-skip   | None observed                                                                                            |
| Flakes                                  | None observed                                                                                            |
| Cancellations                           | Root scripts job cancelled after 10.28 runner-minutes by the operator scope and cost stop                |
| Infrastructure failures                 | None observed                                                                                            |
| Per-run and cumulative ceiling decision | 43.48 is below 45 and 43.48 is below 450; the target defect stopped the window before either ceiling     |

### Retained-target boundary incident

The ordinary run selected all 20 `CI` jobs. The no-skip run executed the same
20-job graph and added only admission. It did not add omitted-path coverage for
this head.

The audit also ran four legacy-heavy steps:

1. `Validate indexer invariant routing inventory` in `indexer` mixed retained
   autoreview owner and fail-closed schema assertions with legacy routing-table
   parity.
2. `Agent quality-gate routing regression suite` in `scripts` mixed retained
   SessionEnd, setup-marker, and package-policy assertions with the legacy Bash
   gate regression suite.
3. `Gate routing-table suite` in `scripts` protected only the legacy local-gate
   router.
4. `Gate routing-table suite` in `docs-checks` protected only the legacy
   local-gate router.

The routing-table sources also route retained generated-output and workflow
safeguards while the old gate exists. Their fixed CI jobs run those safeguards
inside the no-skip target. The skipped suites test the legacy selector itself.
Issues #2127 and #2128 still own final source allocation and deletion evidence.

The second step runs `pnpm agent:quality-gate:test`. The tested Bash gate has
12,223 lines. Its Bash test suite has 25,995 lines. The same step took 32
minutes 6 seconds in ordinary CI. It was still running in the audit when the
operator cancelled the root scripts job after 10.28 runner-minutes.

The repair separates the retained assertions from the legacy suites. The
unconditional `Agent setup and package-policy contracts` step now checks the
SessionEnd hook, setup marker, setup consumers, and package-script policy. The
unconditional `Indexer autoreview invariant contract` step now checks the
autoreview owner inventory and fail-closed schema. Ordinary CI and no-skip both
run these focused suites.

After this extraction, the four skipped steps contain only legacy local-gate
coverage. Ordinary required CI keeps them during the shadow period. The
no-skip audit excludes them because the redesign will remove their subject.
This boundary retains the safeguards that must survive cutover without timing
the implementation that will be deleted.

The repair also keeps `Validate trusted package-script pins` audit-executable
in all three jobs that use it. Before the reusable audit starts, protected
inline admission code compares package manifests, pnpm workspace and lock
files, package patches, the Node and pnpm selections, pnpm configuration, and
tracked `node_modules` paths between the admitted base and source Git trees. It
also compares `ci.yml`, the no-skip dispatcher, the no-skip checker and runtime
parser, and both protected local action trees. Package-execution drift makes
that pull request ineligible for no-skip. It can qualify through the
ordinary-force-all evidence form instead. Evidence-instrument drift cannot
count. The protected `controlPlane` filter must select every retained job.
Every retained job and `CI / ci` must succeed.

The dynamic comparison avoids a content hash registry and recurring pin
updates. The workflow contract pins the comparison step, the semantic retained
`ci.yml` graph, the only audit caller, both focused retained steps, and the four
excluded legacy step shapes. It also rejects unapproved audit-skipped steps and
nonblocking retained steps. The repaired target must reach protected `main`
before a new eligible cold proof can start. This receipt authorizes no further
dispatch.

### Separate assurance surfaces

| Surface                                                                                 | Evidence                                                                                                                                                        |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| External and separate required checks                                                   | All live required contexts passed for the exact sampled head                                                                                                    |
| Local gate result for the same SHA                                                      | Not collected and not required for this incident record; the repair delivery uses the exact user-approved legacy-gate waiver, focused checks, and exact-head CI |
| Credentialed publication, deployment, Terraform apply or plan, and live-provider checks | Excluded from no-skip; record the applicable separate assurance path before cutover                                                                             |

## Coverage ledger

The live sample must fill every row before cutover. One pull request can cover
more than one row. Same-head audit rows cover product and cross-layer selection
risk. Ordinary-force-all rows cover package, dependency, toolchain, and
supply-chain execution risk.

| Required coverage                               | Evidence form      | Status        | Sample or evidence                           |
| ----------------------------------------------- | ------------------ | ------------- | -------------------------------------------- |
| Dashboard-only                                  | Same-head audit    | Pending       | Pending for the repaired cohort              |
| Indexer-only                                    | Same-head audit    | Pending       | Pending for the repaired cohort              |
| Dashboard and indexer cross-layer               | Same-head audit    | Pending       | Pending for the repaired cohort              |
| Root or control-plane                           | Same-head audit    | Incident only | PR #2199; no repaired-cohort coverage credit |
| Package, dependency, toolchain, or supply-chain | Ordinary force-all | Pending       | Pending for the repaired cohort              |
| Required risk-class union                       | Both forms         | Pending       | PR #2199 remains incident evidence only      |

## Window summary

| Measure                                | Current value                                          |
| -------------------------------------- | ------------------------------------------------------ |
| Evidence window status                 | Stopped for a retained-target scope and cost defect    |
| Eligible incident pull requests        | 1                                                      |
| Accepted repaired-cohort pull requests | 0 of at least 10                                       |
| First accepted UTC date                | Pending                                                |
| Last accepted UTC date                 | Pending                                                |
| Inclusive accepted UTC date span       | 0 of at least 7 dates                                  |
| No-skip cumulative runner minutes      | 43.48 of 450                                           |
| Ordinary CI median and maximum         | Pending; no accepted repaired-cohort sample            |
| No-skip median and maximum             | Pending; report observed numerator over cohort size    |
| p95                                    | Not reported for a cohort of at least 10 pull requests |
| Selection-only product failures        | None observed                                          |
| Retained-target scope/cost incidents   | 1                                                      |

The receipt remains draft until the frozen sample contract passes. Passing the
receipt supports a separate human cutover decision. It does not make that
decision.
