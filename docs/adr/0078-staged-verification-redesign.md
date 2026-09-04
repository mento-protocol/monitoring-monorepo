---
title: Staged replacement of the mandatory local gate with existing CI
status: active
owner: eng
canonical: true
last_verified: 2026-09-02
scope: ci/process
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0078 — staged replacement of the mandatory local gate with existing CI

**Status:** Accepted (Aug 2026), amended 2026-09-02. The migration is in force.
The operator approved an early local cutover before the original pre-cutover
sample. The current gate stays mandatory until the approved cutover change
lands.
[ADR 0007](0007-agent-quality-gate-and-merge-oracle.md) remains active for the
hosted two-projection all-clear and Codex approval gate. This ADR supersedes
only its mandatory-local-gate target state. [ADR
0084](0084-github-ui-operator-merge.md) supersedes this ADR's original
operator merge-path assumption.

**Scope:** ci/process

## Context

The local quality gate combines path routing, validation, process cleanup,
cross-worktree scheduling, result reuse, and crash recovery. The raw Phase 0
manifest records 101,595 counted control-plane lines at the terminal pre-M1
source. Recent local runs spent more time waiting for shared capacity than
running mapped commands. The system protects real shared resources, but its
mandatory push path now slows local and hosted development.

The repository already has fixed GitHub Actions jobs, path filters, a
fail-closed `CI / ci` aggregate, automated review, two readiness projections,
and explicit merge approval after current-head all-clear. Replacing those
controls with a new remote execution platform would add another policy and
operations surface.

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

The Phase 0 audit found `checks: write`, Codecov tokens, implicit setup-node
cache saves, and direct `actions/cache` saves in pull request jobs. M2 removes
the unused write grants and PR cache saves. The positive Sentry contract
remains: its built-in gate runs before install, with `contents: read`, no
secret, and no earlier candidate code.

### Apply the M2 pull request trust boundary

Candidate CI jobs use read-only repository permissions. The package jobs no
longer have `checks: write`. Schema diff, Terraform plan, and Lighthouse stop
mutating pull request comments. They publish bounded job summaries instead.
Claude auto-review receives the workflow-scoped GitHub token explicitly and no
longer receives `id-token: write`. Candidate checkouts do not persist Git
credentials.

Four credential exposures remain because isolating them would add an artifact
handoff, publisher workflow, broker, or external service:

- A same-repository PR can run candidate commands before Codecov receives
  `CODECOV_TOKEN`. The token can forge advisory Codecov uploads. It cannot
  write repository content or satisfy a required ruleset context. The upload
  step skips `sentry-autofix/*`. GitHub withholds the repository secret from
  forks and Dependabot.
- Terraform PR plans execute candidate HCL with a read-only GCP plan identity.
  That identity can read cleartext Terraform state. It cannot apply changes.
- Lighthouse passes the Vercel preview bypass value to candidate configuration
  and scripts in its trusted-preview lane. Lighthouse records resolved request
  headers in raw reports. Those reports stay on the ephemeral runner and are
  excluded from artifacts and public storage.
- Claude sends candidate text to the external reviewer. Its workflow-scoped
  token can write PR feedback.

The Codecov token is absent on forks and Dependabot, and its step skips
`sentry-autofix/*`. Terraform, Lighthouse, and automatic Claude review exclude
all three contexts. An `OWNER` or `MEMBER` can explicitly invoke on-demand
Claude review on otherwise excluded content. On 2026-08-30, the human operator
accepted that invocation boundary and the four automatic exposures exactly as
listed above. The repository accepts them under the trusted-contributor model
to retain useful PR checks without adding another control platform. Any wider
permission, credential, context, or invocation path requires a new decision.

M2 also found that the prior Lighthouse temporary-public-storage path could
publish raw reports that contained the Vercel bypass request header. Treat the
current project token as disclosed. M2 keeps raw reports on the runner and
uploads only header-free diagnostics. The operator approved M2 publication
before rotation on 2026-08-30. This accepts that an unknown token holder can
bypass Vercel deployment authentication and selected edge protections for all
project deployments until revocation. The token does not grant Vercel or
GitHub mutation authority. Rotate it through the documented Terraform toggle
path; this approval does not authorize either apply. See Vercel's
[Protection Bypass for Automation contract](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation).

Pull request jobs disable setup-node's implicit package-manager cache. They use
nonfatal `actions/cache/restore` steps in the `trusted-main-v1-*` namespace.
Only protected-main push jobs use `actions/cache/save`. Install, lint,
typecheck, test, build, browser setup, and code generation commands still run
after every restore. M2 removes the Envio generated-output cache because its
hit path skipped required code generation.

Each setup restore has a fixed target and a fixed required command. An empty
`cache-hit` output causes the workflow to remove only that target before the
required command runs. This handles a miss and a failed partial extraction.
A prefix-key hit returns `false`; the workflow keeps that complete restore and
still runs the required command.

The pnpm action separates its executable home from its dependency store. It
keeps the executable in `~/pnpm-home` and caches `~/pnpm-store`. Root and
package-local CI installs select the cache target explicitly. Miss cleanup
cannot remove pnpm's own files.

The M2 structural checker follows local reusable workflows from every direct
pull request trigger. It inventories every pull request job with write
permission or credential access. Each entry pins its permission map, exact
credential bindings, environment, forwarded secrets, and reusable target. The
checker also scans every workflow and local action for cache saves. It pins the
exact cleanup and required-command sequence for each retained setup cache. A
workflow change fails until a reviewer updates this closed inventory and its
mutation tests.

The M2 pull request can prove a cold miss in the new namespace. A protected-
main save and a later PR hit cannot exist before this change reaches `main`.
Record both as post-merge evidence for #2124. A missing or corrupt cache must
remain a cold-run condition, not a validation failure or a skipped command.

### Apply the M3 fixed CI contract

M3 keeps the fixed jobs and the stable `CI / ci` context. A closed-world
fallback selects every conditional job for an unknown path, a control-plane
path, or an incomplete pull request file list. It does not add a planner,
dynamic matrix, or second routing format.

The pinned `dorny/paths-filter` action emits a documented count for each
filter. The `routed` filter reuses the functional filters through YAML aliases.
The fallback compares the `all` count with the `routed` and `ordinary` counts.
The workflow does not export changed-file lists.

The `pnpm ci:contract:test` command checks fixed job membership, conditional
filters, pull request and `main` concurrency, aggregate failure states, and the
M2 permission and cache boundary. The unconditional `Production infrastructure
contract` job runs it on every pull request and `main` push.

M3 adds the two confirmed gate-only gaps to existing required jobs. The
`scripts` job runs the ADR reminder and its tests. The `ui` job runs the normal
production build and bundle-size limit. The separate Infra validation and
bundle-size workflows duplicate required coverage. Lighthouse, PR Description,
duplication, and schema diff remain reviewed advisory exceptions with their
current triggers.

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
checks protected candidate execution and evidence-instrument paths with inline
code, normalizes pull-request-only semantics, and runs every retained
deterministic CI job. Before the reusable audit starts, the dispatcher compares
the admitted base and source trees for package manifests, pnpm workspace and
lock files, package patches, the Node and pnpm selections, pnpm configuration,
tracked `node_modules`, `ci.yml`, the dispatcher, the no-skip checker and its
runtime parser, both focused retained-contract definitions, and both protected
local action trees. A candidate that changes these paths does not enter the
no-skip audit. Package-execution drift can use an ordinary full-job CI
observation. Evidence-instrument drift cannot count through either evidence
form. The comparison uses the admitted Git objects and needs no content hash
registry.
The audit excludes legacy local-gate self-tests from the replacement target.

The repair extracts retained SessionEnd, setup-marker, package-policy,
autoreview owner, and autoreview schema assertions into two focused suites.
Both moves are done. `ci.yml` runs the two suites — `node --test
scripts/indexer-handler-invariant-contract.test.mjs` in the `indexer` job and
`bash scripts/bootstrap/agent-setup-contract.test.sh` in the `scripts` job — and
`RETAINED_EXTRACTED_STEPS` in `scripts/workflows/check-no-skip-audit.mjs` pins
both steps so neither can leave CI unnoticed. Changing a registration is a
`ci.yml` edit that the constant must follow.
[ADR 0086](0086-autoreview-removal-thin-two-model-review.md) has since deleted the
autoreview source the owner and schema assertions compared against, so the
second suite checks one copy of the family data instead of two; the suite and
its audit step stay.
The no-skip audit runs both. It excludes only the four legacy Bash,
routing-table, and routing parity steps. The routing-table suites test the
legacy selector. The retained generated-output and workflow safeguards execute
in their fixed CI jobs and remain inside the pinned audit graph.

The audit contract pins the semantic `ci.yml` graph during the evidence window.
It also allows only the protected dispatcher and `ci.yml` to contain audit
inputs. A semantic target change needs an explicit protected-main graph-pin
update. Package-environment changes fail the base-to-source admission
comparison without creating a recurring pin update.
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
reporter, app, personal access token, task service, or result database. The M4
dispatcher calls the existing `ci.yml` from the protected running commit. The
called workflow also resolves its local setup actions from that commit. The
audit skips the change selector, forces every conditional job, and rejects all
job skips. Each candidate-executing job checks out the admitted source SHA.
ESLint baselines, React Doctor, Peg policy lineage, the ADR reminder, and
Terraform selection use the admitted base SHA.

The audit caller has read-only permissions and forwards no repository or
environment secrets. GitHub still gives each called job its scoped read-only
`GITHUB_TOKEN`. Codecov, failure artifacts, and post-candidate timeline actions
do not run. The initial cold mode disables every reviewed pnpm, Playwright,
Foundry, and Turbo persistent cache read, save, and post hook. Ordinary pull
requests keep affected selection and the fixed command set. M4 limits the
Foundry action cache to protected-main pushes because that action has no
restore-only mode. A later measured change may enable restore-only audit caches.

GitHub gives `workflow_dispatch` jobs cache-service authority outside the
workflow `permissions` map. M4 does not sandbox malicious same-repository
candidate code that calls that service directly. Same-repository admission and
the accepted trusted-contributor threat model bound this residual. The cold
proof verifies the reviewed workflow and tool paths, not an unavailable
platform cache sandbox.

Phase 0 records a 41.18-runner-minute cold planning estimate from comparable
retained runs. It is not an upper bound or an observed current all-cache-miss
run. The approved later execution ceiling is 45 runner-minutes per run and 450
runner-minutes total. The first eligible cold proof counts as one of the ten
sampled pull requests only when its target and measurement instrument are
valid. Stop after any run exceeds 45 runner-minutes. Do not start another run
when it could exceed 450 cumulative runner-minutes. M4 adds no schedule and
spends no shadow minutes. A scheduled run uses the same deterministic no-skip
coverage only after the cold proof passes.

The Phase 0 cost baseline selects one `CI` workflow run for each of ten
immutable pull request heads. It counts every non-skipped job execution and
selected setup step across all 13 attempts. This includes `Sentry suites` and
the `ci` aggregate inside the `CI` workflow. It excludes the separate `Code
Quality` workflow and the external `Vercel` and `Vercel Preview Comments`
results. The included jobs use the recorded Blacksmith runner labels and
GitHub-hosted `ubuntu-latest`. The metric is elapsed Actions job time for the
selected workflow, not total pull-request spend or provider-billed minutes. It
also excludes successful jobs copied into a rerun payload when their start time
precedes that attempt's creation time.

### Use staged evidence and separate approvals

On 2026-09-02, the operator approved one change to the original rollout order.
The pre-cutover evidence window closed with zero accepted samples after
retained-target and graph-pin incidents. Waiting for a repaired pre-cutover
cohort would prolong a local bottleneck that the operator already had to skip.
It would also measure an intermediate local workflow that the approved cutover
removes.

Issue #2127 may therefore remove repository verification from pre-push after
the graph-pin repair reaches protected `main`, protected-main CI passes, and
strict current-base checking is active. The cutover must keep staged formatting
on pre-commit. It must add the fixed `/ship` author-check trigger table. It must
also keep the full legacy gate available in required CI and as a diagnostic.
Required CI remains merge authority.

Issue #2128 owns the deferred acceptance window. It must observe at least 10
distinct merged pull requests over at least 7 calendar days after cutover. A
confirmed required pull-request CI, no-skip CI, or protected-main CI result
that finds a safeguard omission caused by the new author-check mapping requires
rollback. Use the procedure below. This amendment does not authorize legacy
deletion or weaken a required check.

The amended migration has these gates:

1. Inventory every current safeguard and record the Phase 0 baseline.
2. Remove pull request credential and cache-write authority.
3. Add fixed CI selection and aggregate contracts.
4. Repair the retained graph pin and require green protected-main CI.
5. Apply strict current-base checking in a separate human-approved
   administration step.
6. Require explicit human approval before removing repository verification
   from pre-push. The operator granted this approval on 2026-09-02 under the
   conditions above.
7. Observe at least 10 distinct merged pull requests over at least 7 calendar
   days after cutover. Use same-head ordinary CI plus no-skip evidence for
   audit-eligible changes. Use full-graph ordinary CI evidence for
   package-execution changes that the protected audit must reject. Do not count
   evidence-instrument changes.
8. Require separate human approval before deleting the legacy implementation.

Shadow execution also needs a human-approved spend ceiling and stop condition.
A selection omission, false success, or accepted cost breach stops the rollout.

### Preserve mixed-worktree and process-safety obligations

The legacy coordinator keeps `run.lock` while old and new worktrees coexist.
Do not use `--no-lock`, clear live coordinator state, repurpose its state root,
or let new work run beside an older gate that owns the legacy lock.

Issue #2042 closed as completed on 2026-08-29 through PR #2131 at terminal
commit `e0346ec4756f9577bcbb1e13e06566ccc507e9e4`. The earlier provisional
snapshot at `8e2965a6ffbd92bcc0c2793a6892754e4c674a6b` remains historical evidence
only. The #2042 terminal commit has a ten-file, 12,543-line shared closure for
Darwin process identity, coherent lineage, autoreview provenance, and Sentry
process identity. Retain that closure and its tests. PR #2134 advances the
terminal pre-M1 source to `a5692c4570d7fe33255c2ce863d7f79264a9ddb0`. It
changes gate-specific drain recovery and adds 46 gate-specific whole-file
lines. It changes none of the retained shared files. The #2127 cutover keeps
the shared closure and gate runtime unchanged. Before any relocation or
deletion, #2128 must re-audit the shared consumers at the #2042 terminal commit
and the gate-specific candidates through the current pre-M1 source. Gate-only
coordinator, routing, prewarm, and Trunk wrapper or check components remain
deferred retirement candidates.

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

The raw manifest counts every `scripts/gate/**` file and each dedicated
canonical gate document as a whole file. This keeps the full gate-rooted before
surface even when another consumer must retain a file. It also counts other
gate references and the full pre-push hook. At terminal pre-M1 source
`a5692c4570d7fe33255c2ce863d7f79264a9ddb0`, the manifest records 223 files and
101,595 counted lines. This includes 95,815 whole-file implementation and test
lines, 4,952 whole-file dedicated-document lines, and 828 other
shared-reference and hook lines. The retained shared closure contributes 12,543
whole-file lines. The wholly retained package-script pin checker contributes
another 159 lines. Subtracting both leaves 83,113 lines as an upper-bound
deletion candidate.

This upper bound is not the final gate-specific deletion denominator. M4 moves
the known retained setup and package-policy assertions out of the gate test
suite. It also moves the retained autoreview owner and schema assertions out of
the routing parity suite. The remaining routing-table family still mixes some
retained workflow-pin and generated-drift behavior with deferred local routing.
Issue #2127 records only its cutover delta and keeps this mixed family
unchanged. Before deletion, #2128 must allocate or migrate those components and
publish the reviewed final denominator. This source-allocation work does not
put the legacy selector's self-tests in the replacement target. Fixed CI
already runs the retained safeguards during the no-skip audit.
Replacement additions must be smaller than the gate-specific code they replace
at each cutover stage. Final retirement must remove at least 80% of the final
denominator.

M2 records its full changed control-plane surface from protected-main baseline
`ccef910fa6fc267751681176ffdeef01daf90b40` in a frozen additive complexity
receipt. The receipt contains M2 and its #2161 correction. It excludes the
unrelated #2145 and #2159 review-eval artifacts and records that derivation.
This historical #2124 evidence does not change after M2 closes. Later phases
record phase-scoped evidence instead of extending it. The permanent checker
continues to enforce the structural trust boundary.

M4 records its changed and new control-plane files relative to protected-main
baseline `b4bf201c3b87580771c55ec615fcc9a4e51ae267` in a separate phase-scoped
complexity manifest. It is an additive implementation receipt. Operational
shadow evidence stays in GitHub runs and the later Markdown evidence record.

## Rollback

Before legacy deletion, restore the recorded ruleset first and revert the
cutover commit. The retained gate runtime then resumes the mandatory hook.

After legacy deletion, first revert the retirement commit. Restore the gate
runtime, coordinator, aliases, tests, and mixed-version lock behavior before
re-enabling the hook by reverting the cutover commit. Never restore the hook
while its runtime is absent. Never clear coordinator state during rollback.

A false success stops merges through the normal human ruleset administration
path. A confirmed safeguard omission caused by the new author-check mapping
also requires reverting the cutover commit while the legacy implementation is
available. Add a regression fixture, correct the author-check mapping,
inventory, or CI contract, and repeat evidence for the affected risk class. Do
not bypass a required check to regain throughput.

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

- M1 inventory and M2 authority hardening do not change required contexts,
  path filters, hooks, rulesets, or local gate behavior.
- Required CI, review, readiness, operator merge, deployment proof, Terraform
  approval, and secret ownership remain separate controls.
- Local author feedback becomes faster after cutover, but a developer can first
  discover an omitted local check in CI.
- Filter and aggregate correctness become explicit tested contracts.
- A trusted administrator can still weaken candidate-controlled workflow code
  and use the existing bypass. This is an accepted threat-model limit.
- Legacy deletion waits for the post-cutover canary and its own approval.

## Evidence

- [Simple Verification System Plan](../PLAN-progressive-verification-graph.md)
- [Phase 0 evidence](../notes/verification-redesign-phase-0-evidence.md)
- [Safeguard inventory](../metrics/verification-redesign-safeguards.jsonl)
- [Control-plane before manifest](../metrics/verification-redesign-control-plane-before.json)
- [M2 additive complexity manifest](../metrics/verification-redesign-m2-complexity.json)
- [M3 additive complexity manifest](../metrics/verification-redesign-m3-complexity.json)
- [M4 additive complexity manifest](../metrics/verification-redesign-m4-complexity.json)
- Issues #2006, #2032, #2042, #2094, #2122, #2123, #2124, #2125, and #2126
- ADRs [0007](0007-agent-quality-gate-and-merge-oracle.md),
  [0069](0069-gate-routing-table-as-data.md),
  [0072](0072-md-only-docs-checks-job.md),
  [0084](0084-github-ui-operator-merge.md), and
  [0076](0076-fair-quality-gate-coordinator.md)
