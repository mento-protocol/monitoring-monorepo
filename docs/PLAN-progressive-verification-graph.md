---
title: Simple Verification System Plan
status: active
owner: eng
canonical: false
last_verified: 2026-09-01
doc_type: plan
scope: repo-wide
review_interval_days: 180
garden_lane: notes-plans-archive
---

# Simple Verification System Plan

Replace the mandatory local quality gate with a small verification system.
Keep bounded local feedback for the affected packages. Local work must not wait
for another worktree or session. Pull request CI must retain a high
regression-detection bar. The replacement must remove much more complexity than
it adds.

Open the [visual before-and-after companion](PLAN-progressive-verification-graph.html)
for a concise explanation of the current and proposed systems.

This document is a non-canonical plan. It does not change the current gate,
hooks, required checks, merge policy, deployment policy, or Terraform
authority.

This revision rejects the custom verification platform proposed in the first
draft. It does not add a GitHub App, GCP project, signing key, verdict store,
dynamic task graph, custom scheduler, or merge queue. Those mechanisms solve a
stronger threat model than this repository needs. They would replace one large
control system with another.

## Decision

Build the smallest system that gives fast feedback and a high quality bar:

1. Keep staged formatting on pre-commit. Require package-native author checks
   at named change checkpoints. Do not make local results merge authority.
2. Stop running the full quality gate in the local push path after the
   replacement proves equivalent coverage. Add no replacement pre-push gate.
3. Keep the existing path-gated GitHub Actions fan-out. Harden its filters and
   its fail-closed aggregate instead of rebuilding CI.
4. Run affected jobs in parallel on fresh hosted runners. Run a separate
   no-skip shadow run and scheduled full checks to audit selection.
5. Keep one fail-closed `CI / ci` aggregate check as the required source
   verdict.
6. Let pull request jobs restore protected-`main` setup caches. Never let a
   pull request job save a cache. Execute every required command on every run.
7. Keep unusually expensive, time-dependent, and live-provider checks in
   existing conditional, deployment, or scheduled lanes.
8. Preserve the current automated review, feedback ledger, readiness checks,
   and explicit merge approval. Record the accepted one-maintainer risk.
9. Use GitHub directly for merges. Do not add a custom merge wrapper or queue
   in the initial design.
10. Delete the gate coordinator, routing engine, journals, locks, and their
    regression suite after the cutover evidence passes.

The default design reuses the repository's current CI. It adds contract tests
for path selection and the aggregate. A separate no-skip lane tests the
selection policy. This gives high coverage without a new planner or a large
increase in routine runner minutes.

## Goals

- Detect regressions before merge with at least the current effective source
  coverage.
- Return the first useful CI failure quickly.
- Keep required PR validation within a short and measured wall-clock budget.
- Remove all cross-worktree waiting from normal local development.
- Preserve automated review, explicit merge approval, deployment proof, and
  scheduled assurance.
- Make the safeguard small enough for a reviewer to understand in one sitting.

No verification system can prove that a change has no regression. This design
uses independent controls for source behavior, human review, live behavior,
and changing external risks.

## Non-Goals

- Defend against a malicious repository administrator who can change rules,
  approve their own control-plane change, and bypass branch protection.
- Defend against a compromise of GitHub or GitHub-hosted runners.
- Build a general remote-execution or build system.
- Reuse signed test verdicts across commits.
- Create a custom policy service, cache service, queue, daemon, or database.
- Move deployment, Terraform apply, secret mutation, or provider mutation into
  generic PR validation.
- Make local results authoritative for merge.

If the threat model changes, record that change in a new architecture decision.
Do not add infrastructure for a hypothetical threat without evidence and an
explicit decision.

## Current Baseline

The current gate combines regression checks, routing, result caching, process
cleanup, cross-worktree scheduling, and crash recovery.

- An earlier estimate at
  `8bcb675b6b241e57435ce0e864e8511c03d9fce2` counted 9,289 physical lines in
  `scripts/agent-quality-gate.sh`, 21,655 in its Bash regression suite, and
  39,084 under `scripts/gate/**`.
- Those three earlier surfaces totalled 70,028 lines.
- Seven recent completed local requests had a median duration of 1,482 seconds.
- The longest completed request took 2,816 seconds.
- A later caller waited 1,800 seconds and timed out before a command ran.
- A later [source-bound serialized route](metrics/verification-redesign-local-gate-source-bound-sample.json)
  passed in 168 seconds, with 70 seconds of command execution and no scheduler
  wait. The gate exported `CI=true`, so mapped commands used their
  non-interactive CI path. Compare this result only with gate requests that used
  the same command environment. Its measured commit is no longer an ancestor
  after rebase. The committed
  [source patch](metrics/verification-redesign-local-gate-source.patch) permits
  a fresh clone to reproduce the measured tree from a reachable commit. This
  one narrow route does not replace the seven-request distribution.
- The gate self-test has needed a 55-minute CI timeout.
- Remote Turbo result caching is disabled.

The generated Phase 0 manifest widens this count to the complete control-plane
surface. Its terminal pre-M1 source is
`a5692c4570d7fe33255c2ce863d7f79264a9ddb0`. The raw manifest records 101,595
counted lines across 223 files: 95,815 whole-file implementation and test lines,
4,952 whole-file lines from the four dedicated canonical gate documents, and
828 other shared-reference and hook lines. It counts every `scripts/gate/**`
file and each dedicated gate document as a whole file. This preserves the full
gate-rooted surface and avoids a token-by-token document matcher.

The raw whole-file total includes a ten-file, 12,543-line shared closure for
Darwin process identity, coherent lineage, autoreview provenance, Sentry
process identity, and their tests. Those files remain retained. The 159-line
package-script pin checker also remains retained. Subtracting both leaves
83,113 lines as an upper-bound deletion candidate. This is not the final
gate-specific denominator because mixed files contain retained behavior. Issues
#2127 and #2128 must allocate or migrate those components before they publish
the reviewed final denominator. The raw 101,595-line manifest is the
before-surface record. It is not the deletion denominator.

PR #2134 advanced the boundary from the #2042 terminal commit
`e0346ec4756f9577bcbb1e13e06566ccc507e9e4`. It adds 46 whole-file lines to the
gate-specific surface. It changes none of the ten retained shared files and
does not change the dedicated-document, shared-reference, or hook surfaces.

Comparable retained runs produce a 41.18-runner-minute cold planning estimate
for the current deterministic job set. The estimate starts with a run where all
14 pnpm installs missed cache, then adds retained durations for current jobs and
specialized-cache deltas. It is not an observed current all-cache-miss run or an
upper bound. Foundry cold cost remains unknown. The
[Phase 0 evidence note](notes/verification-redesign-phase-0-evidence.md) records
the method and inputs.

The [Phase 0 evidence note](notes/verification-redesign-phase-0-evidence.md)
defines the measurement sources, retention, formulas, denominators, owners,
ceilings, and stop conditions. The raw values are in the
[measurement baseline](metrics/verification-redesign-baseline.json), and the
reviewed dispositions are in the
[safeguard inventory](metrics/verification-redesign-safeguards.jsonl).

The existing `.github/workflows/ci.yml` already has a fixed job fan-out, a
pinned `dorny/paths-filter` action, unconditional guard jobs, and the required
`CI / ci` aggregate. The replacement strengthens this existing design. It does
not create a second required CI system. The current workflow has 20 jobs. The
aggregate lists 19 dependencies and permits 15 path-gated skips.

The coordinator improves fairness between callers. It does not reduce the
validation workload. The local gate also owns shared ports, generated files,
coverage output, mutation output, Terraform data directories, browser state,
and process cleanup. See [ADR 0007](adr/0007-agent-quality-gate-and-merge-oracle.md)
and [ADR 0076](adr/0076-fair-quality-gate-coordinator.md).

The root problem is local orchestration. A developer can wait while one host
limits or serializes many checks. Moving independent checks to fresh CI runners
removes that constraint without building another scheduler.

## Threat Model and Trust Boundary

The primary threats are accidental:

- A code change breaks behavior in the same package.
- A shared contract breaks a downstream package.
- Generated output becomes stale.
- A workflow, package script, ignore rule, or test configuration weakens a
  safeguard by mistake.
- A path filter omits an expensive check.
- A flaky or cancelled job appears successful.
- A merge uses a different head from the reviewed and tested head.
- A deployment is healthy in source CI but broken in its live environment.

Pull request code can still be hostile to the CI runner. Required validation
jobs must use read-only repository permissions and no secrets. A job that needs
a credential must not execute pull request code before it uses that credential.
Keep validation and external publication separate where the benefit justifies
the handoff. Preserve the current safe Sentry ordering. M2 keeps the advisory
Codecov upload in each package job and records the exact
token-after-candidate-commands exposure. It removes PR
comment writers from schema diff, Terraform plans, and Lighthouse instead of
adding publisher jobs. It also removes Claude's OIDC permission and gives the
reviewer only the workflow-scoped GitHub token. The retained Codecov,
read-only Terraform plan, Lighthouse preview, and Claude review exposures are
accepted exactly in ADR 0078. Automatic Claude review excludes forks,
Dependabot, and Sentry-autofix. An `OWNER` or `MEMBER` can still invoke
on-demand Claude review on otherwise excluded content. Lighthouse raw reports
stay on the ephemeral runner because they contain resolved request headers.
Only header-free diagnostics enter the workflow artifact. The operator also
accepted publication before rotation of the disclosed Vercel bypass token.
Rotation remains an IaC-owned follow-up and requires separate apply approval.

The repository currently has one active human maintainer. Required code-owner
approval or a last-pusher restriction would make routine control-plane changes
unmergeable. [ADR 0029](adr/0029-ci-apply-production-infra-gate.md) records this
constraint.

Accept the one-maintainer risk for this migration. Protect control-plane changes
with the mechanisms that already operate:

- The current automated review and feedback ledger.
- `pr:feedback-state` and exact-head `pr:ready-state` checks.
- Contract tests that pin required jobs, filters, command aliases, workflow
  trust boundaries, and aggregate behavior.
- GitHub merge with explicit operator authority.
- A full no-skip shadow run for control-plane changes.

The protected surface includes workflows, repository-owned actions, required
job sets, command aliases, lifecycle and toolchain configuration, path filters,
ruleset helpers, and readiness code. The inventory must name the
contract test or review step that protects each surface.

If a second active human maintainer becomes available, adopt protected
`CODEOWNERS` approval through a separate decision. Protect the `CODEOWNERS` file
itself. Do not make that future control a prerequisite for this migration.

This is a review boundary, not a cryptographic boundary. A malicious authorized
maintainer remains outside this plan's threat model. A dedicated external
verifier would be justified only if that threat enters scope.

## Assurance Stages

| Stage            | Purpose                             | Work                                                                                              | Authority                                       |
| ---------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Local            | Fast feedback                       | Staged formatting and explicit package-native checks                                              | Required author checkpoint; not merge authority |
| Pull request     | Source regression protection        | Existing affected fan-out, unconditional guards, and fail-closed aggregate                        | Required                                        |
| Review and merge | Intent and control-plane protection | Automated review, feedback ledger, operator approval, exact-head readiness, and current-base rule | Required                                        |
| Deployment       | Live behavior proof                 | Existing service-specific rollout and smoke checks                                                | Required by current closeout policy             |
| Scheduled        | Selection audit and changing risks  | No-skip CI, mutation, drift, security, browser, and cold checks                                   | Operational                                     |

These stages stay separate. The PR workflow does not become a deployment
orchestrator. A scheduled result does not replace a required PR result.

## Local Development Contract

Normal local development must have no global gate slot and no cross-worktree
lock. The required local check set must not depend on agent discretion. Named
change triggers select existing package commands. The author can choose when to
run focused tests during an edit, but must complete the required checkpoint
before requesting review or declaring the pull request ready.

Use three execution points:

| Moment                     | Required action                                                           | Boundary                                                                                |
| -------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Every commit               | Keep the current Trunk staged-file formatter.                             | Formatting only. Target p95 below 10 seconds after at least 20 comparable observations. |
| Coherent author checkpoint | Run the existing package commands selected by the trigger table below.    | Complete before review handoff. Draft pushes can occur earlier.                         |
| Every push                 | Start no repository check in the hook. Push immediately and let CI start. | No fetch, gate, lock, receipt, or shared wait.                                          |

The pre-commit hook must not run ESLint, typecheck, tests, code generation,
React Doctor, a browser, or a package manager command. The package ESLint
commands inspect package state and enforce the repository baseline. A staged
hook can see a different tree when a file also has unstaged changes.

The pre-push hook must run no repository verification. A path-aware pre-push
command would need base resolution, cross-package routing, generated-file
rules, timeouts, and cloud fallbacks. That design would recreate the current
gate. A draft push must remain a fast way to start CI.

Use this fixed trigger table. Invoke the commands directly. Do not add a
repository-wide selector or quick wrapper.

| Change trigger                         | Required local checkpoint                                                                                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lintable source in a package           | Run that package's `lint` command after a coherent increment and before review handoff.                                                                                    |
| Typed source in a package              | Run that package's `typecheck` command at the same checkpoint.                                                                                                             |
| Behavior change in a package           | Run focused tests while editing as useful. Run that package's normal `test` command once before review handoff.                                                            |
| Generated input or consumer            | Run the owning code generator as soon as the schema, configuration, ABI, query, entry point, or handler reachability is coherent. Check the generated diff.                |
| Dashboard React or client source       | Run `pnpm dashboard:react-doctor:diff` after the changed UI is coherent and before review handoff.                                                                         |
| New or changed UI interaction or route | Run the documented build when the route, server, or build boundary changes. Verify the changed route in a browser. Check the console and exercise the changed interaction. |

Use the package's CI-aligned local test command. Do not assume that every
package's generic `test` alias is unattended. For Governance Watchdog behavior
changes, run `pnpm --filter @mento-protocol/governance-watchdog test:unit`.
Run its service-backed integration command only when the documented local
service is available. Phase 0 measured the generic alias failing after its unit
tests because no service listened on `localhost:8080`.

For example, a new dashboard page with related indexer work uses this local
sequence:

1. After an indexer schema, configuration, entry point, ABI, or handler
   reachability change, run `pnpm indexer:codegen`. Run
   `pnpm indexer:testnet:codegen` when the testnet configuration is affected.
   Run another registered variant only when its inputs change. Ordinary handler
   logic with unchanged generation inputs does not require code generation.
2. After a dashboard GraphQL query or schema consumer changes, run
   `pnpm dashboard:codegen` and inspect the generated diff.
3. When the indexer change is coherent, run:
   `pnpm --filter @mento-protocol/indexer-envio lint`,
   `pnpm --filter @mento-protocol/indexer-envio typecheck`, and
   `pnpm --filter @mento-protocol/indexer-envio test`.
4. When the page is coherent, run:
   `pnpm --filter @mento-protocol/ui-dashboard lint`,
   `pnpm --filter @mento-protocol/ui-dashboard typecheck`, and
   `pnpm --filter @mento-protocol/ui-dashboard test`.
5. When the page is feature-complete, run
   `pnpm dashboard:react-doctor:diff` against the resolved current pull request
   base. Run `pnpm dashboard:build` for the new route with the documented
   non-secret build environment. Follow the dashboard browser runbook for the
   changed route, console, interaction, and applicable auth states.
6. Push at any point when shared CI feedback is useful. Complete all applicable
   author checkpoints before review handoff. CI then runs the full affected
   suites, including coverage, Knip, dependency checks, full React Doctor score,
   Playwright, size and build checks, all required indexer code generation
   variants, and the fail-closed aggregate.

A local result must be `passed`, `failed`, or `not run: <reason>`. A missing
tool, unavailable browser, stale base, blocked dependency, or timeout must not
appear as a pass. CI supplies required merge evidence when a cloud environment
cannot run a local checkpoint.

Keep these anti-accretion limits:

- No automatic hook may fetch, install dependencies, run a package manager,
  generate files, start a service or long-lived process, use a fixed port, or
  scan a full package or repository.
- No mandatory author checkpoint may invoke a repository-wide gate or selector.
- Do not add a local router, stamp, journal, cache verdict, lock, daemon, or
  scheduler.
- Target p95 below two minutes for package lint, typecheck, and focused tests
  after at least 20 comparable observations per command. Measure and optimize a
  command that exceeds this target. Do not coordinate it through a shared gate.
- A new mandatory local command needs a named trigger and measured latency. It
  must replace an existing command or receive a separate workflow decision.
- Browser work must fail fast when another worktree owns a required port. It
  must not wait for, kill, or lock another worktree's process.
- A missing dependency or timeout must not report success.

Keep the current process drains and shared-resource controls while the old gate
is still active. Delete them with the old gate. Do not build replacements for
local work that no longer runs automatically.

## Required Pull Request CI

Use the existing GitHub Actions CI surface. Do not add a second execution
platform.

### Preserve the existing fan-out

The target CI layout mostly exists. Keep its fixed jobs, pinned
`dorny/paths-filter` action, unconditional guard jobs, and `CI / ci` sentinel.
Use the safeguard inventory to find gate-only gaps. Add only confirmed missing
checks to existing jobs.

The retained jobs follow current package and risk boundaries:

- Repository policy, formatting, documentation, and workflow trust checks.
- Root JavaScript and shell tests that remain after gate retirement.
- `shared-config` checks and downstream contract checks.
- Envio indexer lint, typecheck, tests, code generation, and build checks.
- Dashboard lint, typecheck, tests, production build, and browser smoke checks.
- Metrics Bridge lint, typecheck, tests, and build checks.
- Integration probe lint, typecheck, and tests.
- Aegis, alerting, governance, and other standalone package checks.
- Terraform formatting, registry validation, and stack validation that are safe
  for pull requests.
- Generated-file, schema, ABI, submodule, and tracked-mirror drift checks.
- Dependency, Knip, and supply-chain checks that depend on the proposed source.

Preserve the separate required Code Quality workflow and the required Sentry
suites job inside `CI` unless a later ruleset decision changes them. Preserve
Vercel and Vercel Preview Comments while they remain required. This plan does
not collapse independent reporters into `CI / ci`.

Run independent jobs in parallel. Use a fixed matrix only when every cell has
the same contract. Do not generate a task DAG or let candidate data create job
commands.

Every job must have a timeout. Use one GitHub concurrency group per pull request
and cancel stale runs after a new push. Do not cancel jobs from another pull
request.

### Required aggregate

Keep one stable `CI / ci` required result.

- Run the aggregate with `if: always()`.
- Enumerate every required fixed job.
- Fail for a failed, cancelled, missing, or unexpected result.
- Accept `skipped` only for a named conditional job whose skip contract has a
  test.
- Report the exact failed or missing jobs.
- Bind readiness to the current pull request head SHA.

A green workflow container is not enough. The aggregate must prove that every
expected job reached an allowed conclusion.

Add one small static contract test for the aggregate. It must assert exact
equality between:

- The reviewed required-job set.
- The `ci.needs` set.
- The permitted conditional-job set.
- The aggregate's `allowed-skips` set.

The same contract must show that each workspace package, registered Terraform
stack, Sentry suite, and standalone service has a retained job or a reviewed
exception. Runtime inspection of `needs` cannot detect a job that the workflow
omitted from `needs`.

### Harden affected selection

Keep the current conditional fan-out. Add tests for the selection rules instead
of creating a general planner or running every expensive job on every PR.

Apply these rules:

- Unknown paths run all conditional checks.
- Workflow, package-manager, toolchain, root-script, filter, and shared-config
  changes run all conditional checks.
- Deletions and renames receive the same coverage as additions and edits.
- Each filter has positive, negative, rename, deletion, and fallback fixtures.
- A scheduled run executes each conditional check without path skips.
- The existing review and feedback process must inspect a narrower filter.

Do not create a general routing language. Use the existing pinned
`dorny/paths-filter` action and plain workflow outputs unless measurement proves
that this is insufficient.

Run these jobs unconditionally because they protect the control plane or broad
repository contracts:

- Guardrail prose witnesses.
- Production infrastructure contract checks.
- Sentry suite trust and wiring checks.
- Terraform registry tests that currently run for every non-empty change.
- The aggregate and its closed-world contract.

Keep mutation tests, full browser matrices, accessibility and performance
audits, live-provider probes, and large Terraform plans conditional or
scheduled where current evidence supports that placement.

### Preserve main-push validation

Run the retained CI contract on every `main` push. Keep SHA-unique concurrency
for `main` so a later merge cannot cancel validation of an earlier merge. Test
two close `main` commits during the canary. Deployment workflows can continue to
use the current trust-main model.

### Bind no-skip runs to a trusted workflow and immutable source

The no-skip lane uses the existing GitHub Actions control plane. Its workflow
definition comes from the protected default branch. A human-approved caller
dispatches it with three required inputs:

- Pull request number.
- Full candidate source SHA.
- Full protected-base SHA.

At dispatch, require the source SHA to equal that pull request's current head,
require the head repository to be this repository, and require the base SHA to
equal the current protected branch head. Record all three values before jobs
start. Check out the candidate by full SHA in detached state. Fetch and compare
against the recorded base object. Do not resolve either branch name again
during execution.

Give the protected workflow a distinct run and display name. Record its run ID
with the three immutable inputs as operational shadow evidence. Do not publish a
candidate-head pull request context. GitHub binds a default-branch dispatch run
to the default-branch `GITHUB_SHA`, not the candidate input SHA. Publishing a
candidate-head context would need the separate status-writer authority that
this design excludes. The run cannot satisfy pull request readiness.

Give validation jobs read-only permissions and no secrets. The initial cold
proof disables persistent cache reads and writes. Never let the candidate
change the workflow definition, command set, cache authority, run name, or
display name. A moved pull request head makes the recorded result historical.

M4 adds the manual protected-`main` dispatcher and reuses `ci.yml` through a
same-commit workflow call. The caller passes the admitted source and base SHAs.
The called workflow resolves its local actions from the running protected
commit. It bypasses change selection, forces every conditional job, checks out
the candidate by full SHA in each executing job, and rejects every job skip in
the audit aggregate. It normalizes ESLint baselines, React Doctor, Peg policy
lineage, the ADR reminder, and Terraform selection to the admitted base.

M4 does not add a schedule and does not run the shadow. The approved later
execution ceiling is 45 runner-minutes per run and 450 runner-minutes total.
The eligible cold proof counts as one sampled pull request. Stop after any run
exceeds 45 runner-minutes or before cumulative use would exceed 450 minutes.

## Cache Policy

Use caches only to reduce setup time. Treat every byte restored into a pull
request job as untrusted input.

Protected `main` jobs may populate shared setup caches for:

- pnpm package downloads keyed by the lockfile.
- Browser and toolchain downloads keyed by exact versions.
- Provider or compiler downloads when their existing integrity controls apply.
- Framework build caches only when the build command still executes and treats
  the cache as disposable input.

Pull request jobs may restore setup caches populated by protected `main`. Pull
request jobs must not save caches. M2 disables setup-node's implicit cache and
uses nonfatal `actions/cache/restore` with a new `trusted-main-v1-*` namespace.
Only a protected-main push can call `actions/cache/save`. This simple rule
covers dependencies, executables, generated code, browser binaries, provider
binaries, and build output without a second cache-policy language.

Each retained setup cache has a fixed target and a fixed required command. An
empty `cache-hit` output removes only that target before the command runs. This
clears a missing or failed partial restore. A prefix-key hit returns `false`;
the workflow keeps that complete restore and still runs the command.

The pnpm executable stays in `~/pnpm-home`. The dependency cache stays in
`~/pnpm-store`. Every root and package-local CI install selects that store
explicitly. Cache cleanup cannot remove the pnpm executable.

Do not use:

- A cached pass instead of running a required test, lint, typecheck, build, or
  validation command.
- GitHub Actions cache as a verdict store.
- Remote Turbo result reuse in the initial system.
- Cross-commit signed receipts, custom cache keys, artifact attestations, or a
  cache database.
- An Envio cache hit that skips code generation or generated-output comparison.

If a setup cache is missing or corrupt, the job must clear the fixed cache
target and run cold. Cache failure must not change the required command set or
produce success by itself.

This policy removes the cache-isolation, key-completeness, signer, revocation,
and artifact-restoration problems found in the first review.

## Independent Safeguard Inventory

Create one reviewed migration inventory before implementation. This inventory
is evidence for deletion. It is not a runtime registry.

Inventory every current safeguard from:

- `scripts/agent-quality-gate.sh` and its routing modules.
- `.github/workflows/ci.yml` and every other required or scheduled workflow.
- Root and package scripts.
- Trunk configuration and hooks.
- Package and root `AGENTS.md` files.
- PR, review, merge, deployment, and Terraform checklists.

Assign each safeguard one disposition:

- `retained-required-ci`: retained in required CI.
- `retained-author-procedure`: retained as an author procedure.
- `retained-after-merge`: retained after merge.
- `scheduled`: scheduled, with a stated detection interval.
- `duplicate`: duplicate of a named retained safeguard.
- `obsolete-with-evidence`: obsolete, with evidence.
- `deferred-with-owner`: deferred, with an owner and follow-up.

Conditional pull request checks, reviewer procedures, and advisory reminders
remain inventory categories and reviewed meaning. They are not additional
disposition values. Map each safeguard to one of the seven dispositions based
on its retained enforcement or follow-up. A conditional required job remains
retained in required CI. A reviewer procedure retained by the publication or
readiness workflow remains a retained author procedure under this inventory
taxonomy. An advisory maps to a retained procedure, a deferred owner and
follow-up, a named duplicate, or an evidence-backed obsolete disposition as its
reviewed outcome requires.

The inventory must cover at least these risk classes:

1. Formatting, lint, type, unit, integration, coverage, and build checks.
2. Generated files, ABIs, schemas, configuration mirrors, and submodules.
3. Cross-package and producer-consumer contracts.
4. Browser behavior, accessibility, bundle size, and production builds.
5. Terraform stack registry, validation, plans, and provider boundaries.
6. Workflow trust, action pins, permissions, triggers, and secret ordering.
7. Package aliases, lifecycle scripts, lockfiles, and toolchain versions.
8. Documentation metadata, links, context budgets, and runbook drift.
9. Dependency, supply-chain, Knip, mutation, and baseline-growth checks.
10. PR feedback, required checks, current-head readiness, authorized merge, and
    mandatory hazard-checklist routing.
11. Deployment revision, service health, data, metrics, alerts, and rollback.
12. Gate and coordinator self-tests that become obsolete with their subject.
13. ADR reminders and other advisory process prompts that the gate surfaces.

Require set equality between the reviewed inventory and the migration
dispositions. A safeguard cannot disappear because it was absent from a new
list. This resolves the circular completeness problem in the first draft.

## Review and Merge Authority

Keep exact-head readiness checks. A human operator normally merges through
the GitHub UI. An agent can merge only with explicit, direct approval for that
specific merge. Do not add a custom merge wrapper or merge queue during the
initial migration.

At cutover:

- Keep the existing stable `CI / ci` result required for the current head.
- Keep Code Quality, Sentry suites, Vercel, and Vercel Preview Comments required
  while the live ruleset requires them.
- Require the current automated review and feedback-ledger conditions.
- Require the branch to be current with the protected base before merge, or
  rerun the required checks after the base changes.
- Check the exact head SHA, base, checks, reviews, and feedback on the PR page
  immediately before using the merge button.
- Keep agents at ALL_CLEAR unless the user directly approves that specific
  merge.

This flow records the accepted one-operator risk. The human who owns the change
also owns the final merge decision. Automated reviewers, feedback-state, CI
contracts, and exact-head readiness provide independent evidence. They do
not become a second human approval.

This design accepts extra CI reruns when `main` moves. That cost is simpler than
a custom queue or merge-candidate attestation system. Measure the rerun cost.
Consider GitHub's native merge queue only if base churn becomes a material
bottleneck. That later change requires its own ADR, canary, workflow-event
support, and rollback plan.

## Deployment and Scheduled Assurance

Keep existing service-specific deployment checks. Source CI cannot prove live
credentials, provider configuration, indexer sync, data correctness, external
APIs, user interactions, alert delivery, or rollback.

Production closeout must continue to prove the deployed revision and the
service-specific live contract. Terraform apply and secret changes still
require their current human and IaC controls.

Use existing scheduled workflows for slow and changing risks. Ensure the
schedule includes:

- A cold run of the complete deterministic PR baseline.
- Every conditional PR check without a path skip.
- Mutation and mutation-baseline checks.
- Dependency and vulnerability refresh checks.
- Full browser, accessibility, and performance checks.
- Terraform and platform drift checks.
- Flake reporting and recurring-failure ownership.

Register any new scheduled workflow in the existing notifier coverage. Do not
create a new scheduler or result service.

## Complexity Budget

The replacement fails if it creates another control platform.

The initial implementation must meet all of these limits:

- No new cloud project, service, GitHub App, database, queue, daemon, signer,
  or long-running process.
- No custom task declaration format, dynamic DAG, receipt schema, verdict
  cache, or artifact protocol.
- No new cross-worktree lock, socket, lease, journal, or global port owner.
- At most one new thin orchestration script. It must stay below 300 non-test
  lines and call existing package commands.
- New replacement-specific test code must stay below twice the size of new
  replacement implementation code.
- No new replacement file may exceed 500 lines.
- Count all added or materially changed control-plane code, even when it lives
  in an existing file. This includes workflow YAML, inline shell, local actions,
  package aliases, filters, hooks, and structural tests.
- Produce a machine-generated before-and-after manifest for that complete
  control-plane surface.
- The replacement-specific control-plane additions must have a net line count
  below the gate-specific code they replace at every cutover phase.
- The final state must remove at least 80% of the reviewed final gate-specific
  implementation and test deletion denominator.
- The final pull request must show the net line reduction and list every
  retained gate-rooted shared file with its reason.

If implementation exceeds a limit, stop. First simplify the design or improve
an existing package command. Do not raise the limit in the same change that
needs it.

The existing CI workflow can remain large while this migration removes the
local gate. The budget still counts every line that this migration adds or
materially rewrites inside it. Reduce unrelated duplicated CI YAML as separate,
measured work. Do not make a full CI rewrite a prerequisite for local relief.

## Migration

Each phase is independently reversible. The mandatory local gate remains
enforced until a separately approved cutover. Required CI remains the merge
authority throughout the migration.

### Phase 0: Inventory and measure

Create the safeguard inventory. Include commands, mandatory author and reviewer
procedures, checklist routing, ADR reminders, and scheduled checks. Give each
existing review, readiness, contract-test, and merge control a disposition.
Record the accepted one-maintainer risk in the ADR.

Record local queue time, local execution time, CI wall time, time to the first
terminal required-CI result, time to the first useful failure, runner minutes,
setup time, per-suite flake rate, and failure yield. Record the source SHA and
measurement window. The Phase 0 cost baseline selects one `CI` workflow run for
each sampled immutable head. It includes every non-skipped `CI` job, including
`Sentry suites` and the `ci` aggregate. It excludes `Code Quality` because that
job runs in the separate `Trunk` workflow. It excludes `Vercel` and `Vercel
Preview Comments` because they are external results, not Actions jobs in the
selected workflow. Included `CI` jobs use the Blacksmith labels
`blacksmith-2vcpu-ubuntu-2404-arm`, `blacksmith-2vcpu-ubuntu-2404`, and
`blacksmith-4vcpu-ubuntu-2404`, plus GitHub-hosted `ubuntu-latest`. This is a
selected-workflow metric, not total pull-request spend or provider-billed
minutes. The Phase 0 setup figure includes top-level `pnpm-install` composite
steps and explicit steps whose names start with `Install`. It excludes checkout,
standalone cache actions, setup-terraform, and other tool setup. For a retried
workflow, sum every non-skipped job execution and selected setup step across
all attempts. Exclude earlier successful jobs copied into a later-attempt
payload when their start time precedes that attempt's creation time. Measure
the staged formatter and each proposed package-native author checkpoint
separately. Do not hide their runtime inside the removed gate's total.

Use comparable retained runs to estimate the exact cold proposed commands on
representative historical SHAs. Before shadow execution, run the non-required
no-skip lane at immutable trusted SHAs with every cache read and write disabled.
Measure every current deterministic job. Stop if it breaches the human-approved
shadow spend ceiling or stop condition.

Confirm which current checks are duplicates and which checks protect distinct
risks. Do not change blocking behavior.

The Phase 0 snapshot found 25 registered worktrees. Two are confirmed active,
23 require owner confirmation, and none are proved stale. Refresh this count at
cutover because worktree registration is live state.

### Phase 1: Remove PR credential and cache-write authority (#2124)

Resolve each recorded pull request credential exception. Isolate credentialed
publication from candidate execution or record explicit human acceptance for
the exact retained exposure. Give candidate-code jobs read-only repository
permissions. Remove unused `checks: write` grants. Preserve the reviewed
Codecov, Sentry, and Sentry-autofix ordering boundaries.

Let pull request jobs restore only disposable setup caches populated by
protected `main`. Pull request jobs never save a cache. A cache hit never
replaces a required command. Remove the Envio cache path that can skip required
code generation. A missing or corrupt cache falls back to a cold run.

The first implementation pull request stops here. Issue #2124 changes no CI
coverage, path filters, required contexts, hooks, rulesets, or local gate
behavior.

M2 implements this phase inside the existing workflows and actions. It removes
unused `checks: write` grants. Schema diff, four Terraform plans, and Lighthouse
publish job summaries without PR write permission. Claude auto-review uses an
explicit workflow-scoped token without OIDC. Codecov remains advisory. The four
retained credential exposures are listed and accepted exactly in ADR 0078.
That ADR also records the separate approval to publish before rotation of the
disclosed Vercel bypass token. Rotation remains an IaC-owned follow-up.

PR jobs restore only `trusted-main-v1-*` setup caches. Protected-main pushes
own saves. Every required command still runs. The Envio generated-output cache
and its codegen skip are gone. A cold PR miss is pre-merge evidence. The first
protected-main save and a later PR hit are post-merge evidence because the new
namespace cannot exist on `main` before this PR merges.

The M2 structural checker follows local reusable workflows from every direct
pull request trigger. It inventories all pull request jobs with write
permission or credential access. Each entry pins its permission map, exact
credential bindings, environment, forwarded secrets, and reusable target. The
checker scans every workflow and local action for cache saves. It also pins
each retained restore, targeted empty-restore cleanup, and required setup
command. Mutation tests prove these boundaries fail closed.

M2 also chooses deletion over new publisher jobs. The four Terraform comment
writers, Lighthouse comment writer, schema-diff comment writer, and their
write permissions are removed. Job summaries retain the result near the run.
Lighthouse raw reports remain runner-local and outside public storage and the
uploaded diagnostics artifact.
The frozen additive complexity receipt starts at protected-main SHA
`ccef910fa6fc267751681176ffdeef01daf90b40`. It records M2 and its #2161
correction. Its derivation excludes the unrelated #2145 and #2159 review-eval
artifacts. It remains historical #2124 evidence. Each later phase records its
own scoped complexity evidence instead of extending the M2 receipt.

### Phase 2: Harden fixed CI coverage and aggregate (#2125)

Map retained safeguards to the CI jobs that already run them. Add only confirmed
gate-only gaps to existing jobs. The first known candidates are
`pnpm adr:check` and `pnpm adr:check:test`.

Add the closed-world aggregate contract and path-filter fixtures. Preserve
every-`main` validation and SHA-unique `main` concurrency.

Keep the current gate self-tests active while the mandatory gate remains
enforced. Exclude them only from the replacement benchmark and target command
set. Delete only gate-specific tests with the gate in Phase 5. Retain the
shared-consumer process-identity and lineage tests. Do not add 21,000 lines of
scheduler tests to the replacement for a scheduler that will be deleted.

The second implementation pull request stops here. Issue #2125 does not add or
run the no-skip audit. It changes no hook, ruleset, or local gate behavior.

### Phase 3: Add the no-skip audit and shadow (#2126)

Add an opt-in protected-default-branch no-skip workflow with a distinct run and
display name. Keep its run ID and immutable inputs as operational evidence. Do
not publish a candidate-head pull request context or create a second job named
`ci`. Keep the existing `CI / ci` implementation and required context
unchanged.

The M4 implementation pull request adds only the manual lane. Its protected
dispatcher admits an open same-repository pull request only when the supplied
source SHA is still its head and the supplied base SHA is still protected
`main`. The reusable CI call skips the mutable path selector, forces all fixed
jobs, uses a zero-skip aggregate, and runs candidate commands from exact source
checkouts. The audit caller forwards no repository or environment secrets.
Called jobs still receive GitHub's scoped read-only `GITHUB_TOKEN`. Codecov,
failure artifacts, and post-candidate timeline actions do not run. The workflow
disables every known pnpm, Playwright, Foundry, and Turbo persistent cache read,
save, and post hook.

GitHub gives `workflow_dispatch` jobs cache-service authority outside the
`permissions` map. M4 cannot sandbox hostile same-repository candidate code that
calls that service directly. Same-repository admission and the trusted-
contributor threat model bound this residual. The cold proof establishes no
cache use by the reviewed workflow and tool paths. It does not establish a
general cache-service sandbox.

The M4 pull request does not dispatch the lane, add a schedule, change required
contexts, change rulesets, or alter the mandatory local gate. The first eligible
cold proof runs only after M4 merges. It counts as one of the ten sampled pull
requests if it meets the sample rules.

The M4 phase-scoped complexity manifest records every changed control-plane
path relative to its protected-main base. It is an additive implementation
receipt. It is not a shadow-run evidence format and makes no cutover claim.

Add a scheduled no-skip run only after the cold cost measurement passes and a
human approves the spend ceiling. Register the schedule in the existing
notifier coverage.

The approved execution ceiling is 45 runner-minutes for one run and 450
runner-minutes for the initial sample. Stop after a run exceeds 45 minutes.
Do not start another run when it could exceed the cumulative ceiling.

Run the existing path-gated CI and the distinct no-skip shadow on selected pull
request heads. Compare at least one recorded head from each of at least 10
distinct pull requests over at least 7 calendar days, subject to the approved
spend ceiling. Multiple heads from one pull request do not increase the pull
request count. The sample must include every inventory risk class that can
appear in a pull request, including one dashboard and indexer cross-layer
change.

For every head, record:

- The path-gated CI result and selected jobs.
- The no-skip result and failed job.
- Any product failure found only by no-skip CI because path-gated CI omitted
  the failing job.
- Wall time, time to first failure, runner minutes, and retry reason for the
  path-gated `CI` run and no-skip run as separate observations.
- Any product failure, flake, cancellation, or infrastructure failure.

Record a local gate result when it is available for the same SHA. Do not make
cutover depend on collecting ignored per-worktree state from every PR.

Use the existing historical routing corpus to test every remaining conditional
filter. Add negative fixtures for workflow weakening, deleted files, renamed
files, unknown paths, skipped jobs, cancelled jobs, and missing aggregate
inputs.

Issue #2126 owns both the no-skip implementation and this evidence window. Its
implementation pull request uses `Refs`, and the issue stays open until the
10-PR, 7-day receipt passes.

### Phase 4: Human-approved cutover (#2127)

Use a separate change and explicit human approval because this phase removes a
control that blocks the acting agent.

Before changing the local contract:

1. Verify that the existing `CI / ci` and all other live required contexts stay
   required.
2. Prove the required results on the exact current head.
3. Record the current ruleset JSON and the exact cutover revert commit. Apply
   only the current-base requirement that this plan needs.
4. Verify a canary pull request for normal code, control-plane code, a renamed
   file, an unknown path, a failed job, a cancelled job, and a stale head.
5. Verify two close `main` commits without cross-cancellation.
6. Before producing the after manifest, extend the Phase 0 manifest generator
   to count replacement-owned checker and test files, verification aliases, and
   every changed control-plane block. Accept a Trunk configuration with both
   legacy gate markers absent after full action removal. Continue to reject a
   partial or malformed legacy block. Add fixtures for the present, fully
   removed, and partial or malformed states.

Then remove the mandatory full gate from the local push path. Keep the staged
formatter on pre-commit. Add no pre-push verification command. Add the fixed
trigger table and required author checkpoints to the operating card and
publication workflow. Invoke existing package commands directly. Update the
quick commands, setup, Worktrunk hooks, Trunk hook, ship and babysit skills,
package scripts, and all stale gate instructions in the same change. Keep the
old command available as a diagnostic during the observation period.

The retained diagnostic keeps its coordinator, process drains, and legacy lock.
Inventory active worktrees before deletion. Update setup and worktree entry
points so current worktrees receive the new hook. Make the diagnostic print the
planned retirement condition. Do not use `--no-lock`, clear coordinator state,
or remove mixed-version compatibility while an active supported worktree still
uses the old gate.

### Phase 5: Soak and delete the legacy system (#2128)

Observe at least 10 merged pull requests over at least 7 calendar days after
cutover. Require zero observed migration-attributable safeguard omissions found
by no-skip, scheduled, `main`, or deployment checks. Multiple heads or reruns
from one pull request count as one pull request.

The deletion scope starts from the 83,113-line upper-bound candidate. Retain the
ten-file, 12,543-line shared closure and the 159-line package-script checker.
Issues #2127 and #2128 must allocate or migrate retained behavior in mixed
files, then publish the final denominator. They must also
re-audit the shared consumers at the #2042 terminal commit
`e0346ec4756f9577bcbb1e13e06566ccc507e9e4` and every gate-specific candidate
through the current pre-M1 source
`a5692c4570d7fe33255c2ce863d7f79264a9ddb0`. The coordinator, routing, prewarm,
and gate-only Trunk wrapper or check code remain deferred candidates until that
audit passes.

With separate human approval, delete:

- The quality-gate Bash entry point.
- The gate-only coordinator, mapper, router, prewarm, Trunk wrapper or check,
  locks, leases, sockets, journals, and stale recovery code.
- Gate-only fixtures and tests.
- Compatibility code that exists only for old worktrees after the documented
  transition ends.

Update or supersede ADRs 0007, 0069, 0076, and 0072 as their decisions change.
Update or supersede ADRs 0008 and 0033 when checklist or reminder entry points
change. Keep ADR 0084 active for the direct GitHub merge path. Record the
final line reduction and retained safeguards.

### Phase 6: Optimize only measured bottlenecks

If required CI misses its target, optimize the measured critical path. First
remove duplicate work, split independent work, reduce setup, and fix slow tests.
Do not add a new affected-task planner, verdict cache, or infrastructure without
a separate plan and evidence that the current filters cannot meet the target.

## Acceptance Evidence

Do not cut over until every unlabelled pre-cutover requirement passes. Evaluate
requirements marked **Post-cutover soak** during the #2127 and #2128 soak.
Evaluate requirements marked **Deletion gate** immediately before the separate
Issue #2128 deletion approval.

### Coverage

- Every current safeguard has one reviewed inventory disposition.
- Every required safeguard either runs unconditionally or has a tested
  conditional filter and a scheduled no-skip audit.
- Every conditional filter passes its positive, negative, rename, deletion,
  unknown-path, and control-plane fixtures.
- The aggregate's static contract proves exact equality between required jobs,
  `needs`, conditional jobs, and allowed skips.
- The aggregate fails for failed, cancelled, missing, and disallowed skipped
  jobs.
- No shadow head has a product failure found only by no-skip CI because
  path-gated CI omitted the failing job.
- The shadow sample covers all pull-request risk classes.

### Trust and merge behavior

- Validation jobs have read-only permissions and no secrets.
- Sentry preserves its safe credential ordering. Other credential-bearing jobs
  execute no prior pull request code or have explicit human acceptance of the
  boundary. ADR 0078 lists the exact M2 exceptions and their approval status.
- Pull request jobs restore only protected-`main` setup caches and never save a
  cache. Every required command still executes on a cache hit.
- The ADR records the accepted one-maintainer risk. The inventory gives each
  existing review, readiness, contract-test, and merge control a disposition.
- A changed head invalidates prior readiness and feedback evidence.
- The operator uses the current PR page. Branch rules re-evaluate required
  checks before GitHub enables the merge.
- The ruleset rollback record restores the prior required checks.
- Every `main` SHA receives its own non-cancelled CI result.

### Speed and reliability

Use the same shadow sample of at least 10 distinct pull requests over at least 7
calendar days for head-level measures unless a larger denominator is stated.

- **Post-cutover soak:** shared local gate queue time is zero seconds. The staged
  formatter and selected author commands still have their own measured runtime.
- For the 10-head sample, report median and maximum time to the first terminal
  required-CI result. Its p95 target is below two minutes only after at least 20
  comparable heads.
- Time to the first useful CI failure has p95 below two minutes across at least
  20 failing or fault-injected runs that cover every pull-request risk class.
- Required path-gated PR CI does not regress from the Phase 0 median and maximum
  distribution. Ten minutes remains the optimization target, not an unmeasured
  cutover promise. Report p95 only after at least 20 comparable observations.
- Each required deterministic suite has a measured flake budget. The initial
  target is below 0.5% over at least 200 executions. Browser suites use a
  separate explicit budget, owner, tracking issue, and expiry until their
  existing flake is fixed.
- Infrastructure retry rate stays below 1% over at least 200 workflow attempt
  executions.
- Runner minutes for one path-gated `CI` workflow run do not exceed the
  comparable Phase 0 selected-workflow baseline by more than 25% without an
  explicit cost decision. This condition does not claim total pull-request
  spend. Each no-skip run also stays within the separately approved 45-minute
  per-run ceiling and 450-minute cumulative ceiling.

### Simplicity

- Every complexity-budget limit passes.
- A reviewer can trace each required check from workflow job to package command
  and aggregate result without running a custom planner.
- The before-and-after manifest counts changed YAML, inline shell, actions,
  aliases, filters, hooks, and structural tests.
- **Deletion gate:** the final deletion removes at least 80% of the reviewed
  final gate-specific implementation and test lines.
- **Post-cutover soak:** no local or cloud development session waits for a
  repository gate slot.
- **Post-cutover soak:** pre-commit runs staged formatting only and has p95
  below 10 seconds across at least 20 comparable observations.
- **Post-cutover soak:** pre-push runs no repository verification.
- **Post-cutover soak:** required author checkpoints use direct package commands
  and named triggers.

## Rollback

The rollback uses repository history and the existing ruleset. It needs no
service recovery.

If the static CI aggregate is wrong before cutover, keep the current gate and
fix the CI workflow.

If a false success appears after cutover but before legacy deletion:

1. Stop merges through the normal ruleset administration path.
2. Verify or restore the prior required-check configuration from the recorded
   ruleset JSON. The record must include `CI / ci`, Code Quality, all Sentry
   suite requirements, Vercel, and Vercel Preview Comments.
3. Revert the recorded cutover commit to restore the mandatory gate hook and
   its legacy implementation.
4. Add a regression fixture for the missed safeguard.
5. Correct the inventory or static job.
6. Repeat the shadow acceptance period for the affected risk class.

If the legacy implementation was already deleted:

1. Stop merges through the normal ruleset administration path.
2. Revert the recorded retirement commit. Restore the gate runtime,
   coordinator, aliases, tests, process safeguards, and mixed-version
   `run.lock` behavior.
3. Verify the restored runtime without enabling its hook.
4. Restore the prior ruleset configuration.
5. Revert the cutover commit to re-enable the mandatory hook only after the
   runtime is available.
6. Add the regression fixture and repeat the affected shadow period.

Never restore a hook before its runtime. Never clear live coordinator state
during rollback.

Do not bypass a failing required check to restore throughput.

## Documentation and Decision Scope

Phase 0 records the repository-wide verification architecture decision in ADR 0078. A later implementation pull request updates or supersedes that ADR only
when it changes an architecture decision. Keep the trusted-contributor and
one-maintainer threat model, hardened existing-CI decision, cache limits,
complexity budget, migration evidence, and rollback current in the decision
record.

Audit all live gate instructions when the canonical workflow changes. The
search includes root and scoped `AGENTS.md` files, README files, `docs/**`,
`.agents/skills/**`, `.claude/skills/**`, `.claude/commands/**`, workflows,
Trunk configuration, Worktrunk configuration, setup scripts, package scripts,
PR helpers, deployment closeout instructions, `.claude/settings.json`, settings
contract tests, `turbo.json` inputs, and gate-only CI filter comments.

Retiring the current gate remains a separate human-approved action. This plan
does not grant that approval.

## Disposition of First-Round Review Findings

| Finding                                                         | Revised decision                                                                                                                                                                                                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate workflows can spoof a protected aggregate             | Scope malicious authorized maintainers out of the threat model. Use current automated review, feedback-state, contract tests, current-head readiness, and operator-authorized GitHub merge. Record the one-maintainer risk.                        |
| Candidate code can reach an attestation boundary                | Remove the attestor and verdict store. Give validation jobs no secrets or write permission. Keep credential effects separate.                                                                                                                      |
| Merge queue conflicts with the merge path                       | Do not use a merge queue in the initial system. Keep operator-authorized GitHub merge and require current-base validation.                                                                                                                         |
| Cache identity and artifact binding are incomplete              | Do not cache verdicts or restore cross-job proof artifacts. Let PR jobs restore protected-`main` setup caches, but never save a cache.                                                                                                             |
| Candidate task declarations can weaken task semantics           | Do not add candidate task declarations or a task registry. Use fixed workflow jobs and control-plane review.                                                                                                                                       |
| Completeness proof is circular                                  | Build an independent, reviewed migration inventory before deleting any safeguard.                                                                                                                                                                  |
| A dynamic matrix cannot express the task DAG                    | Do not create a dynamic DAG. Use fixed jobs and simple fixed matrices.                                                                                                                                                                             |
| Isolation removal can leave local processes behind              | Keep existing cleanup while the gate exists. Delete both the local workload and its cleanup at retirement. Use fresh CI runners.                                                                                                                   |
| Cache promotion and revocation are unspecified                  | Remove trusted result reuse from scope.                                                                                                                                                                                                            |
| Submodule, floating toolchain, and base-tip keys are incomplete | Run checks fresh. Preserve submodule and toolchain checks in the static inventory. No cross-commit key exists.                                                                                                                                     |
| Lifecycle, Sentry, or Codecov ordering can regress              | Preserve current lifecycle and Sentry safeguards. Treat Codecov token-after-candidate-commands as an exception that #2124 must isolate or receive explicit human acceptance. Include each boundary in control-plane review and inventory evidence. |
| Migration omitted ADR, ruleset, docs, and hand-off work         | Add explicit measured, shadow, cutover, deletion, documentation, and rollback phases.                                                                                                                                                              |

The reviewers' findings remain valid for the first draft. The revised plan
removes the mechanisms that required most of their proposed infrastructure.

## Disposition of Second-Round Review Findings

Fresh GPT-5.6-Sol Ultra and Fable 5 Max reviews evaluated plan digest
`4f0a11d22546087f387131cfd2c57636776b879f73778c749fd7e23d1b5a8cf8`.
Both returned `ACCEPT WITH CHANGES`. This revision integrates the accepted
changes, so their digest-bound verdicts describe the prior revision.

| Finding                                                            | Integrated decision                                                                                                                                                           |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required code-owner approval deadlocks a one-maintainer repository | Remove it as a cutover prerequisite. Record the one-operator risk and retain current automated review, feedback, readiness, and explicit merge approval.                      |
| Full CI on every PR exceeds cost and latency limits                | Keep the existing affected fan-out. Test filters and run a separate scheduled or opt-in no-skip lane.                                                                         |
| The target CI mostly exists                                        | Keep Phase 2 limited to inventory-driven gap filling. Do not rebuild the workflow.                                                                                            |
| A job omitted from `ci.needs` is invisible                         | Add one closed-world static contract for jobs, `needs`, conditional jobs, and allowed skips.                                                                                  |
| Local gate results are not available for every PR SHA              | Compare path-gated CI with no-skip CI. Use local gate results only when available.                                                                                            |
| One global flake limit is already unrealistic                      | Use per-suite budgets and a separate temporary browser budget.                                                                                                                |
| PR cache writes can poison later same-PR runs                      | Let PR jobs restore protected-`main` setup caches, but never save a cache. Remove cache-based command skips.                                                                  |
| Shadow and required checks can collide                             | Keep protected-branch run-ID evidence outside PR contexts and readiness. Never publish a second `ci` job.                                                                     |
| Inventory omits procedures and reminders                           | Keep conditional checks, reviewer procedures, and reminders as category detail. Map each to exactly one of the seven final dispositions by retained enforcement or follow-up. |
| Main validation can be cancelled by later merges                   | Preserve every-`main` execution and SHA-unique concurrency.                                                                                                                   |
| Complexity can hide in existing workflow files                     | Count all changed control-plane surfaces and generate a before-and-after manifest.                                                                                            |
| Cutover sweep omits live configuration                             | Include Claude settings, settings contract tests, Turbo inputs, and CI filter comments.                                                                                       |
