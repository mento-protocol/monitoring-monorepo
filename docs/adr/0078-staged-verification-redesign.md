---
title: Staged replacement of the mandatory local gate with existing CI
status: active
owner: eng
canonical: true
last_verified: 2026-08-29
scope: ci/process
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0078 — staged replacement of the mandatory local gate with existing CI

**Status:** Accepted (Aug 2026). The migration is in force. The current gate
stays mandatory until the approved cutover stage completes.

**Scope:** ci/process

## Context

The local quality gate combines path routing, validation, process cleanup,
cross-worktree scheduling, result reuse, and crash recovery. The raw Phase 0
manifest records 96,688 counted control-plane lines at the terminal pre-M1
source. Recent local runs spent more time waiting for shared capacity than
running mapped commands. The system protects real shared resources, but its
mandatory push path now slows local and hosted development.

The repository already has fixed GitHub Actions jobs, path filters, a
fail-closed `CI / ci` aggregate, automated review, two readiness projections,
and exact-head human merge consent. Replacing those controls with a new remote
execution platform would add another policy and operations surface.

The repository has one active human maintainer. A required second approval for
every control-plane change would stop routine delivery. This decision therefore
targets accidental regressions and a trusted contributor model. It does not
claim to stop a malicious repository administrator, a compromised GitHub
runner, or a maintainer who uses the ruleset bypass deliberately.

## Decision

### Reuse and harden the existing CI fan-out

Keep the fixed jobs in `.github/workflows/ci.yml`. Keep `CI / ci` as the stable
required aggregate. Add contract tests for exact job membership, conditional
skips, filters, and fail-closed aggregate results. Unknown paths and
control-plane changes must select all conditional jobs. Do not add a dynamic
task graph, custom scheduler, verdict cache, signing service, GitHub App, or
cloud project.

Pull request validation must become read-only and secretless before it becomes
the sole source-regression authority. A pull request job must not save any
cache. It may restore only disposable setup data written by protected `main`.
A cache hit must never skip a required command or generated-output comparison.
Credential use must run outside candidate-code execution, or a later human
decision must accept and document the exact remaining exposure.

The current audit found `checks: write`, Codecov tokens, implicit setup-node
cache saves, and direct `actions/cache` saves in pull request jobs. Those are
migration blockers. The positive Sentry contract remains: its built-in gate
runs before install, with `contents: read`, no secret, and no earlier candidate
code.

### Keep local checks bounded and non-authoritative

After cutover, pre-commit runs staged formatting only. Pre-push starts no
repository validation, fetch, lock, or wait. The `/ship` workflow selects
direct package commands from named change triggers and records each result as
`passed`, `failed`, or `not run: <reason>`. It runs the selected author checks
before first publication and after a material fix, not on every commit.

Dashboard React or client changes require the React Doctor diff command.
Changed routes or interactions also require the documented build and browser
verification. Indexer schema, configuration, ABI, entry-point, handler-
reachability, and dashboard GraphQL consumer changes require their applicable
code generation. Other workspace packages use their direct lint, typecheck,
and test commands when those scripts exist.

These local results shorten feedback. Required CI remains merge authority. A
manual push can omit author checks, but it cannot omit required CI.

### Audit selection with a distinct no-skip lane

The no-skip audit is a protected default-branch `workflow_dispatch` entry
point. Its input identifies one pull request, an immutable source SHA, and an
immutable base SHA. It verifies that the pull request still names those SHAs,
normalizes pull-request-only semantics, and runs every deterministic CI job.
It excludes deployment, apply, publication, live-provider, and other
credentialed effects. It publishes a distinct non-required result. It must not
publish a candidate-head pull request check. GitHub binds the protected-branch
dispatch run to the protected-branch `GITHUB_SHA`, not the candidate input SHA.
GitHub documents this default-ref binding in the
[`workflow_dispatch` event reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch).
The workflow uses a distinct run and display name. Its run ID and recorded
immutable inputs are operational shadow evidence. They cannot satisfy pull
request readiness.

The audit uses existing GitHub Actions jobs. It adds no status writer, custom
reporter, app, personal access token, task service, or result database. Phase 0
records a 41.18-runner-minute cold planning estimate from comparable retained
runs. It is not an upper bound or an observed current all-cache-miss run. Before
shadow execution, run every current deterministic job at immutable trusted SHAs
with cache reads and writes disabled. Stop if that proof breaches the approved
ceiling. A scheduled run uses the same deterministic no-skip coverage after
this proof passes.

The 10-PR Phase 0 cost baseline counts every non-skipped job execution and
selected setup step across all 13 attempts. It excludes successful jobs copied
into a rerun payload when their start time precedes that attempt's creation
time.

### Use staged evidence and separate approvals

The migration has these gates:

1. Inventory every current safeguard and record the Phase 0 baseline.
2. Remove pull request credential and cache-write authority.
3. Add fixed CI selection and aggregate contracts.
4. Compare path-gated CI with no-skip CI on at least 10 distinct pull requests
   over at least 7 calendar days.
5. Require explicit human approval before removing the mandatory local gate.
   A separate human-approved administration step applies any ruleset change.
6. Observe at least 10 distinct merged pull requests over at least 7 calendar
   days after cutover.
7. Require separate human approval before deleting the legacy implementation.

Shadow execution also needs a human-approved spend ceiling and stop condition.
A selection omission, false success, or accepted cost breach stops the rollout.

### Preserve mixed-worktree and process-safety obligations

The legacy coordinator keeps `run.lock` while old and new worktrees coexist.
Do not use `--no-lock`, clear live coordinator state, repurpose its state root,
or let new work run beside an older gate that owns the legacy lock.

Issue #2042 closed as completed on 2026-08-29 through PR #2131 at terminal
commit `e0346ec4756f9577bcbb1e13e06566ccc507e9e4`. The earlier provisional
snapshot at `8e2965a6ffbd92bcc0c2793a6892754e4c674a6b` remains historical evidence
only. The terminal source has a ten-file, 12,543-line shared closure for Darwin
process identity, coherent lineage, autoreview provenance, and Sentry process
identity. Retain that closure and its tests. Before cutover, relocation, or
deletion, issues #2127 and #2128 must re-audit each terminal consumer. Gate-only
coordinator, routing, prewarm, and Trunk wrapper or check code remains a
deferred retirement candidate.

The process contract never signals a bare PID or process-group ID without a
matching non-reusable identity. It settles coherent lineage before release and
fails closed on unsupported self-daemonization. A Trunk daemon must be contained
or classified as a bounded trusted external service. Sentry may signal a
detached group only while its verified leader is alive. It must not use the PID
or process-group ID after that leader is reaped.

### Keep the replacement smaller than the removed system

The migration adds no service, GitHub App, cloud project, database, queue,
daemon, signer, dynamic DAG, verdict cache, artifact protocol, cross-worktree
lock, socket, lease, journal, or global port owner. It may add at most one thin
orchestration script below 300 non-test lines. No new replacement file can
exceed 500 lines. Replacement-specific tests must stay below twice the new
implementation size.

The raw manifest counts every `scripts/gate/**` file as a whole file. This
keeps the full gate-rooted before surface even when another consumer must retain
a file. It also counts gate references and the full pre-push hook. At terminal
source `e0346ec4756f9577bcbb1e13e06566ccc507e9e4`, the manifest records 220
files and 96,688 counted lines. This includes 95,769 whole-file implementation
and test lines plus 919 shared-reference and hook lines. The retained shared
closure contributes 12,543 of the whole-file lines. The reviewed gate-specific
implementation and test deletion denominator is therefore 83,226 lines.
Replacement additions must be smaller than the gate-specific code they replace
at each cutover stage. Final retirement must remove at least 80% of that
83,226-line denominator.

## Rollback

Before legacy deletion, restore the recorded ruleset first and revert the
cutover commit. The retained gate runtime then resumes the mandatory hook.

After legacy deletion, first revert the retirement commit. Restore the gate
runtime, coordinator, aliases, tests, and mixed-version lock behavior before
re-enabling the hook by reverting the cutover commit. Never restore the hook
while its runtime is absent. Never clear coordinator state during rollback.

A false success stops merges through the normal human ruleset administration
path. Add a regression fixture, correct the inventory or CI contract, and
repeat shadow evidence for the affected risk class. Do not bypass a required
check to regain throughput.

## Alternatives considered

### Keep the mandatory local gate

Rejected as the target state. It preserves current controls, but it keeps
cross-worktree waiting and retains the large scheduling and recovery system.

### Replace the gate with a dedicated verification platform

Rejected. A protected planner, remote executor, attestor, result store, and
custom merge authority address a stronger threat model than this repository
has accepted. They would add infrastructure and operational failure modes.

### Run every deterministic job on every pull request

Rejected as the routine path. It is simple but spends runner time on unrelated
packages. The fixed affected fan-out plus an independent no-skip audit gives a
measurable omission check at lower routine cost.

### Add a path-aware pre-push replacement

Rejected. Correct selection would require base resolution, cross-package
routing, generated-file rules, timeouts, and shared-resource behavior. That
would recreate the local gate.

## Consequences

- The migration does not change blocking behavior in Phase 0.
- Required CI, review, readiness, merge consent, deployment proof, Terraform
  approval, and secret ownership remain separate controls.
- Local author feedback becomes faster after cutover, but a developer can first
  discover an omitted local check in CI.
- Filter and aggregate correctness become explicit tested contracts.
- A trusted administrator can still weaken candidate-controlled workflow code
  and use the existing bypass. This is an accepted threat-model limit.
- Legacy deletion waits for two evidence windows and its own approval.

## Evidence

- [Simple Verification System Plan](../PLAN-progressive-verification-graph.md)
- [Phase 0 evidence](../notes/verification-redesign-phase-0-evidence.md)
- [Safeguard inventory](../metrics/verification-redesign-safeguards.jsonl)
- [Control-plane before manifest](../metrics/verification-redesign-control-plane-before.json)
- Issues #2006, #2032, #2042, #2094, #2122, and #2123
- ADRs [0007](0007-agent-quality-gate-and-merge-oracle.md),
  [0069](0069-gate-routing-table-as-data.md),
  [0072](0072-md-only-docs-checks-job.md),
  [0075](0075-pr-merge.md), and
  [0076](0076-fair-quality-gate-coordinator.md)
