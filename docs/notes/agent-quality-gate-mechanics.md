---
title: Agent Quality Gate — Mechanics
status: active
owner: eng
canonical: true
last_verified: 2026-08-29
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Agent Quality Gate — Mechanics

This runbook owns gate invocation, path mapping, parallelism, caching, and the
package-script refusal guard. Root `AGENTS.md` routes here.

## Invocation contract

Before opening or updating an agent-authored PR:

```bash
pnpm agent:quality-gate          # inspect mapped commands and checklists
pnpm agent:quality-gate --run    # execute the safe local mapped commands
pnpm agent:autoreview            # required for a non-trivial completed batch
pnpm agent:autoreview:test -- --jobs 1  # sequential full regression closeout for autoreview runtime changes
```

The local-only gate never deploys or applies Terraform. Run it explicitly;
do not assume the pre-push hook exists.

The package command and Trunk hook execute `./scripts/agent-quality-gate.sh`
directly. This preserves the script's Bash `-p` startup boundary; it does not
grant operating-system privileges. The prologue clears the remaining inherited
Bash controls before it resolves a path or parses an argument. Do not invoke the
gate as `bash scripts/agent-quality-gate.sh`; that bypasses the shebang boundary.

The checked-in Claude permission grants approval-free execution only for
`./scripts/agent-quality-gate.sh`. It does not grant the `pnpm` package alias
because the active branch controls that alias before the gate can validate it.

`pnpm agent:autoreview` reviews source only. `pnpm agent:autoreview:test` runs
all families with at most three workers and bounded progress/timings, which the
mapped gate preserves. `-- --jobs 1` changes only scheduling. CI uses that mode
on `ubuntu-latest` for runtime or fixture changes; required `ci` demands success
when selected.

Background `--run` gates and `git push`: a 600s foreground kill writes no
freshness stamp, so the next run cannot use `--skip-if-fresh`. Each run appends
per-command JSON plus one `__run_total__` line to gitignored
`.tmp/agent-quality-gate/durations.jsonl`. Coordinator-backed entries separate
worktree admission wait, combined command-scheduler wait, execution time, and
coalesced wait. Targets: 3 minutes for common mapped sets and 8 minutes for the
full workspace (Refs #1415).

If a sandboxed mapped run fails only because a command needs host capabilities,
rerun the full mapped gate with host access on the same head. The gate reuses
stamp-eligible fresh successes and runs the blocked commands. A resumed run does
not write a whole-run stamp. Within each leader execution, Trunk and the gate
self-test are stamp-exempt and always run. This includes a later pre-push
execution that becomes a leader. Trunk's one exception is an environment that
blocks its downloads: the CLI, its plugin sources, or the linters that a check
needs. The gate skips that arm. Other
eligible successes keep per-command stamps, so the later gate can avoid
repeating them. Running a command directly proves it but records no per-command
stamp.

For a manual full-repository reproduction of the server-side pre-push baseline,
including when hooks are absent or uncertain, use:

```bash
git fetch origin main:refs/remotes/origin/main
./tools/trunk fmt --all
./tools/trunk check --ci --all
pnpm dashboard:react-doctor:diff
pnpm dashboard:codegen
pnpm --filter @mento-protocol/ui-dashboard typecheck
pnpm --filter @mento-protocol/indexer-envio typecheck
pnpm --filter @mento-protocol/indexer-envio test:coverage
pnpm indexer:codegen
pnpm --filter @mento-protocol/ui-dashboard test:coverage
```

Cross-layer/stateful UI work also applies
[`docs/pr-checklists/stateful-data-ui.md`](../pr-checklists/stateful-data-ui.md).
The handler-invariant classifier in `scripts/agent-autoreview-core.mjs` routes
selected indexer runtime, invariant-test, and test-support changes to the protected
[`docs/pr-checklists/indexer-handler-invariants.md`](../pr-checklists/indexer-handler-invariants.md)
policy in the local gate and prepared autoreview bundles. It returns one
ordered `{path, route, owner}` decision per input path. Autoreview loads the
classifier from its selected attested runtime and validates the complete batch
before it selects routed paths. A wrapper-attested runtime is checked against
its sealed identity and content manifest before and after classifier import and
execution. A difference at either boundary fails before the wrapper uses the
decisions. Prepared runtimes retain their existing trust boundary.

That protected-main boundary creates deliberate version skew when a candidate
changes `scripts/agent-autoreview-core.mjs`. The protected classifier cannot
see a new exact owner or a false-to-true reclassification in the candidate.
Therefore, a change to the core source itself selects the handler-invariant
checklist in both autoreview and the local gate. This trigger intentionally
routes unrelated core edits. Running the candidate classifier would weaken the
trust boundary that the protected runtime provides.

`getIndexerHandlerInvariantRoutingFamilies()` returns a detached, deeply
frozen view of the same family data the classifier uses. Import-time validation
rejects malformed families, overlapping exact owners, and paths that cannot
stay literal in a Bash `case`. The routing
table derives an excluded-first, routed-second checklist dispatch from this
view. The focused indexer parity test compares the table decisions with the
core classifier and pins every current owner. The checklist arms contain exact
current paths only. Eighteen broad inventory patterns cover `.ts`, `.tsx`, `.mts`, `.cts`,
`.js`, `.jsx`, `.mjs`, `.cjs`, and `.json` below `indexer-envio/src/` and
`indexer-envio/test/`. The four JavaScript extensions match the package's
`allowJs` TypeScript input set. JSON matches `resolveJsonModule`. Five more
broad patterns cover `indexer-envio/abis/`, `indexer-envio/config/`, root
`indexer-envio/config*.yaml` files, root `indexer-envio/vitest*` inputs, and
`indexer-envio/scripts/test-*.mjs` wrappers. None of these broad patterns routes
the checklist. The exact `indexer-envio/schema.graphql` and
`indexer-envio/stryker.config.mjs` patterns complete the 25-pattern inventory.
Exact owners also cover every current root config YAML, root Vitest input, and
indexer test wrapper. The current exact arms contain 253 routed paths and 12
excluded paths.

The routed source boundary follows executable dependencies from the production
handler entrypoint, registered handlers, RPC facades and effects, and self-heal
stages. It includes modules that can change entity identities or fields,
rollups, effect keys or targets, freshness, or phase behavior. The routed test
boundary includes direct invariant tests and the fixtures, harness, and HTTP
mock support that enforce hermetic multi-event and RPC behavior. It also
includes test-runner inputs that set the timeout, fail-closed fixture, and
hermetic RPC contract, or select the mutation-test and coverage scope. Explicit
exclusions include type-only context modules, warning-only helpers, the
console-only RPC logger adapter, the two vendored ABIs that no current runtime
consumes, and tests that enforce a separate config-copy, script, or
warning-format contract.

The focused indexer parity test compares every current module with one of the
nine supported JS, JSON, or TypeScript extensions below `src/` and `test/`. It
also compares every current file below `abis/` and `config/`, every current root
`config*.yaml` file, Vitest input, indexer test wrapper, Stryker configuration,
and `schema.graphql` against the table. The focused external inventory contains
45 inputs. The local gate runs it for all 25 inventory patterns. The indexer CI
job runs it for every indexer change. A new module below `src/` or `test/` is
classified as `future-module` with `route: false`. The inventory assertion
requires the adding PR to give it an explicit owner. A new file below `abis/`
or `config/`, a new root `config*.yaml` file, a new root `vitest*` input, or a
new `scripts/test-*.mjs` wrapper also runs the inventory assertion without
inheriting a checklist route. Other unlisted paths outside `src/` and `test/`
stay outside this classifier.
Core-only edits route the autoreview suite, the routing-table suite, and the
gate self-test. The core is also an explicit freshness-signature input and a
Turbo input beside the routing-table directory.

The dry-run gate maps changed paths to package checks and PR checklists. That
mapping is a Node engine reading a data table — see
[Where the plan comes from](#where-the-plan-comes-from-adr-0069) below. For a
routing-sensitive source, the shared classifier adds the offline
`pnpm docs:navigation-eval -- --check-fixtures` check. It invokes no model or
scheduled evaluation. Every tracked Markdown change runs `pnpm docs:index
--check` and `pnpm docs:navigation-eval:test`. The second command enforces the
navigation source budgets that the Markdown-only CI job checks. Review the
output, then run:

```bash
pnpm agent:quality-gate --run
```

Every non-empty candidate change set also runs the Terraform-stack suite. The
gate spells it `pnpm tf:test`, unless a root-tooling `package.json` edit already
scheduled the identical `node scripts/tf-stacks.test.mjs`; the two share one
dedupe key, so the suite runs once however many arms ask for it. The required
`Production infrastructure contract` CI job runs the same command without a
path condition, so production-infrastructure and deployment contracts cannot
skip on an unrelated path.

Execution stays local: lint, typecheck, tests, codegen,
Trunk, and formatting/validation commands. Terraform formatting receives an explicit Git-visible source
list, so tracked and non-ignored untracked Terraform files are checked without
letting gitignored operator-held `*.tfvars` affect a branch-source gate. If any
package manifest, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, `.npmrc`, pnpmfile, or `patches/**` file changed,
`--run` refuses to execute until you review package scripts/lifecycle hooks and pass
`--allow-package-script-changes`. The narrow exception is a root `package.json`
edit limited to root tooling scripts such as `scripts.agent:quality-gate`,
`scripts.agent:quality-gate:test`, `scripts.agent:prewarm`,
`scripts.agent:prewarm:test`, `scripts.agent:review-materiality`,
`scripts.agent:review-materiality:test`, `scripts.agent:context-check`,
`scripts.agent:context-budget`, `scripts.agent:context-budget:test`,
`scripts.agent:autoreview`, `scripts.agent:autoreview:test`, `scripts.issue:board`,
`scripts.issue:board:test`, `scripts.issue:claim`, `scripts.issue:review`,
`scripts.issue:release`, every `scripts.sentry:*` entry (the runners and their
`:test` suites), `scripts.docs:index`, `scripts.docs:index:test`,
`scripts.docs:audit`, `scripts.docs:audit:test`, `scripts.docs:garden`,
`scripts.docs:garden:test`, `scripts.docs:navigation-eval`,
`scripts.docs:navigation-eval:test`, `scripts.pr:feedback-state`,
`scripts.pr:feedback-state:test`, `scripts.pr:ready-state`,
`scripts.pr:ready-state:test`,
`scripts.tf`, `scripts.tf:test`, `scripts.alerts:rules:lint`,
`scripts.alerts:rules:lint:test`, `scripts.lockfile:lint`,
`scripts.lockfile:lint:test`, `scripts.skew:check`,
`scripts.skew:check:test`, `scripts.sanitize:test`,
`scripts.override:prune-report`, `scripts.override:prune-report:test`,
`scripts.adr:check`, or `scripts.adr:check:test`; the gate treats that
as tooling-only and runs an
entrypoint validator plus the gate/prewarm/PR-feedback/PR-ready/Terraform-stack
regression tests instead of the package-script refusal path. That exemption
holds only because every allowlisted alias is pinned to an exact command, so the
entrypoint validator
(`scripts/check-agent-quality-gate-package-scripts.mjs`) runs as a fail-fast
quality-setup prerequisite: an unpinned or drifted alias aborts the run before
any `pnpm <alias>` executes, and `--skip-if-fresh` cannot skip it. Existing changed paths run
targeted Trunk checks for faster local iteration. Deleted paths,
Trunk/tooling changes, package-manager changes, pnpm patches, and
package-manifest changes still run full-repo Trunk locally. CI also runs a
required full-repo Trunk check on every
PR. Where the environment blocks Trunk's downloads — a Claude cloud container
proxies egress and refuses any host outside its allowlist, and its credential
proxy gates `github.com` per session on top of that — the gate reports the
arm as `skipped` with a warning naming a remedy instead of failing the
run, matching the posture `.trunk/hooks` already takes. Trunk downloads at two
stages and the gate classifies both. If the launcher cannot fetch the pinned CLI
from `trunk.io`, a probe run after the command fails
(`TRUNK_LAUNCHER_QUIET=true ./tools/trunk --version`) answers that directly. If
the launcher succeeds but the CLI cannot fetch its plugin sources or the
hermetic runtimes and linter binaries a check needs, the gate classifies the
check transcript instead. That classification never infers "nothing was found".
For a blocked runtime or linter install it accepts the transcript only when
Trunk itself reported no issues, every failure Trunk counted is a download step,
and the reason each step recorded in its `.trunk/out/*.yaml` detail file is one
of Trunk's download-failure phrasings. For a blocked plugin source Trunk aborts
before linting anything and states the cause inline, so the gate accepts those
same phrasings plus the measured
`Unable to download plugin <url>: HTTP 403 '<url>'` — what a session-gated
`github.com` returns — and ignores the launcher's own progress lines, which lead
the transcript on a cold cache. That 403 is pinned to the plugin source
`.trunk/trunk.yaml` names, because a 403 from anywhere else is more likely
revoked credentials than a session gate. A 404 keeps failing the gate too: a
removed or renamed artifact is a broken pin the operator has to fix, not an
allowlist to widen. Each shape gets its own warning, and both replay Trunk's
recorded reasons so they name the host. The plugin warning says Trunk never
reached a linter, and that a credential proxy gating the host per session is not
something an allowed-domains entry can lift — there the remedy is a prewarmed
Trunk cache (`$TRUNK_CACHE`, else `$XDG_CACHE_HOME/trunk`, else
`~/.cache/trunk`) or CI.
On Darwin, the failed Trunk status becomes durable before the parent stops the
command watchdog. The parent then requests the provisioning probe through the
mapped root's private control FIFO. The probe runs below the still-live mapped
root. It publishes an append-only `ready` then `ok` or `blocked` receipt and
has an independent 15-second deadline. The existing exact-lineage watcher
settles the probe, any downloader, and the mapped root before lease release.
Portable hosts keep the parent-owned probe and their existing tree settlement.
Everything else fails the gate, including a partly-explained failure set and a
download step that failed for a local reason. Only a provisioning failure
degrades: a provisioned Trunk that finds real problems still fails the gate, and
so does a run that mixes real findings with a blocked download. A run whose
Trunk arm was
skipped writes no whole-run success stamp, so the next `--skip-if-fresh` run
retries Trunk instead of inheriting a pass it never earned. Normal `--run` mode
executes independent
quality-phase commands with
bounded local parallelism (`--parallel <n>`, default `auto` capped at 4 workers,
or `AGENT_QUALITY_PARALLELISM`). The machine-wide coordinator applies a second
weighted bound. `AGENT_QUALITY_GATE_CAPACITY` accepts 1 through 64 and defaults
to 3. Local parallelism cannot increase that capacity. The gate self-test uses
weight 2 when capacity is at least 2 and weight 1 at capacity 1. Preflight,
codegen, post-codegen install,
Terraform init/validate chains, shared-config build setup for mapped config
consumers, and the package script pin validator remain ordered prerequisites
on every execution path — including
`--parallel 1` and keep-going runs, where they previously degraded to ordinary
keep-going commands and let their dependents run after a
failure. Playwright installation uses one named resource. Dashboard browser,
coverage, build, and size-limit work use fair all-capacity barriers. Browser
work also uses the fixed-port named resource. Every mapped Trunk check uses the
`trunk-daemon` resource. A daemon that was already live is a named trusted
external service. A check that starts a daemon runs as the direct guardian's
child. The guardian retains the mapped lineage through normal exit or hard
wrapper death. It makes at most three named shutdown cycles. Each status or
shutdown call has a 10-second limit. If it cannot confirm `stopped`, it exits 2
and a standalone wrapper leaves the daemon as the same named trusted service.
A mapped Darwin wrapper hands remaining gate-owned descendants to exact lineage
settlement. A surviving wrapper therefore fails the gate. It also fails if its
final status check finds a late live daemon after bounded cleanup. Future mapped
Trunk clients still serialize on `trunk-daemon`.
On Darwin, the parent creates a private `pending` receipt and an unlinked
completion pipe before START. The parent retains the read end. The trusted
wrapper chain and guardian retain the write end. The parent closes its write
end after START. The wrapper closes its read end before target code runs.
Mapped Trunk children cannot publish completion. Guardian-spawned children
receive `/dev/null` at the write descriptor. Status and direct Trunk launches
close it. A live wrapper creates the `done` receipt and writes `done` after its
final status check. After hard wrapper death, the guardian publishes after the
check and named cleanup finish. The parent keeps the lease and named resource
while it waits. It verifies both receipts after the pipe signal. It gives the
mapped root five seconds to publish wrapper status, then starts generic lineage
settlement. One bounded Node reader accepts only the exact `done\n` signal. It
does not wait for EOF because the lineage watcher can retain a write descriptor
until settlement. Silence from a live writer keeps the wait active. Zero-byte
EOF fails the wait immediately. The reader validates its gate parent and runs
behind interruptible Bash `wait`, so gate termination stays prompt. The
completion deadline is the command timeout plus 120 seconds. This covers
10 seconds for initial status, 92 seconds for named cleanup, 10 seconds for
final status, and eight seconds of scheduling margin. EOF or a missing or
invalid signal or receipt is an infrastructure failure. Exact lineage
settlement owns a post-baseline daemon through an exact guardian tombstone. An
incomplete chain stays ambiguous and keeps the scheduler barrier. No fallback
signals by a reusable PID or process group.
The quality-gate self-test stays ordered inside its worktree
because it temporarily mutates tracked fixture files; this keeps
source-fingerprinting tests such as autoreview from observing synthetic drift.
A browser setup failure still lets independent lint/typecheck/unit/knip
feedback run. `--fail-fast` stays sequential so it still stops before starting
the next mapped command. Parallel workers use Bash job-control groups on macOS
Bash 3.2 and Linux. The parent opens the request marker before it forks each
worker. In coordinator mode, it also opens the shared generation marker for the
worker. This keeps the sentinel visible to a legacy recovery handoff after its
mapped wrapper exits. The parent opens a launch pipe before the fork. The worker
waits on that pipe while the parent records its PID/start identity, confirms
that its PGID is the same PID, and fills every cleanup registry. Only then can
the worker request a lease or run mapped work. While the lease is queued, the
worker checks the exact parent identity and cancels its private coordinator wait
if that parent exits. It accepts recovery ownership only after it validates the
persisted granted-lease record against the active lease ID, drain identity, and
lifecycle contract. A coordinator journal persists the command identity.
A pure legacy parent persists the same identity as a drain obligation before it
releases the launch pipe. The worker creates and retains its command marker only
after that recovery mapping exists and, in coordinator mode, after its lease
exists. The worker closes its own command-marker descriptor when the mapped
call returns. The mapped root and surviving descendants retain their own
descriptors. This prevents the sentinel from keeping recovery open on itself.
The worker then publishes its command result atomically. On Linux, it stays
alive as the exact process-group anchor until the parent or a successor drains
the command identity. The drain folds the anchored group into its durable
PID/start capture before its first signal. On Darwin, the sentinel exits when
its exact parent exits because it is outside the mapped root's lineage. The
lease carries the `darwin-coherent-lineage-v2` contract. The gate resolves
`process.execPath` once and requires an absolute, executable, non-symlink Node
runtime. It uses that runtime for the Darwin lineage helpers. This prevents a
version-manager shim from adding a process between identities that require an
exact parent relation.

The parent records a complete kernel identity baseline before the lease
request. A legacy run records the same baseline before it links its owner
record. The owner and its Darwin state therefore become recovery-visible in
that order. The parent refreshes the baseline after the grant or legacy claim
and binds the wrapper before `START`. The canonical lineage state lives in the current user's mode-0700
coordinator lineage root, or the equivalent legacy lineage root. This root is
shared by the user's worktrees so a successor can recover the obligation. The
watcher's private controls and native-helper cache stay in repo-local scratch.
The watcher receives the canonical state directory separately and validates
both directories before it reads their files.

If an admitted command fails before the wrapper binds, the worker first
abandons the command-not-started lease. It then reads the exact v4 lineage
state. The state-only settlement requires a null root, a null launcher, no
tombstones, and no prior settlement evidence. A revision-checked transition
publishes `verified-unbound-abandonment`. It does not load the native helper,
take a census, establish signal authority, or send a signal. A legacy owner
retains this settlement. Other modes discard it after their scheduler or
private-run authority ends. A bound root or any tombstone fails closed and
leaves the state for the full settlement path. A crash before lease abandonment
retains the scheduler obligation. A later crash leaves an inert unbound record,
durable settlement evidence, or the recoverable discard tombstone.

After the bind, the parent starts one settlement watcher for the command. It
captures the watcher's exact identity and waits for its durable armed marker
before it sends `START` to the mapped root. The watcher samples coherent lineage
censuses while the command runs. Normal finalization first changes the lease to
`settling`. The mapped root then stays live behind its settlement FIFO while
the watcher takes the final census. The watcher signals owned descendants from
deepest to shallowest and signals the root last. It is the only normal
settlement writer. If the controller or launcher dies, the watcher performs the
same settlement without waiting for the parent. A fallback drainer can write
only after the exact watcher is gone. Revision compare-and-swap preserves any
census that the watcher published first.

Settlement follows exact process unique IDs and stable captured parent unique
IDs. XNU can update a parent unique ID during `exec`, so the helper compares two
complete row reads and retries a mixed row. Each identity row also includes the
non-zero resource and jetsam coalition IDs. The bound root and launcher must
inherit the same coalition pair. Settlement signals only an
audit-token-matched process. INT/TERM waits for worker registration and uses the
same lifecycle contract. The active parent reaps the watcher and sentinel. It
releases the lease only after one coherent census proves that the exact set is
empty. A no-lock sentinel exits only after its exact
parent identity changes, becomes a zombie, or disappears. It retries an empty
process-identity read while the parent PID still exists. Before an explicit
no-lock run or a nested gate starts mapped work, it creates its own request
token and marker in the private repo-local
`.tmp/agent-quality-gate/no-lock-handles` directory. A nested gate already runs
under its ancestor's exclusion. It never reuses the ancestor's token. This
private handle does not reserve coordinator capacity or acquire a lock. It lets
the same uncoordinated parent find a detached descendant after its tagged
wrapper exits.
On Darwin, the unique-lineage record remains the destructive authority in this
mode. It never falls back to a numeric PID or process group. A failed no-lock
drain returns non-zero and retains the lineage state for inspection. No-lock
mode owns no coordinator lease or request. In coordinator mode, a failed drain
or lease release keeps the lease unresolved. The coordinator stops new dispatch
and cancels the request through normal drain recovery.

New coordinator leases accept `portable-marker-v1` on Linux and
`darwin-coherent-lineage-v2` on macOS. A persisted
`darwin-unique-lineage-v1` lease is recovery-only. Restart converts it to a
global `drain-required` barrier. The normal begin-settlement and release paths
reject it. The drainer upgrades and settles its exact v3 lineage state, then
acknowledges the obligation with the legacy contract. No new command can select
that contract.

In sequential mode, the gate waits for the wrapper and watchdog, refreshes the
request-handle scan, persists every discovered descendant identity, and drains
that set before it releases the command lease. Parallel commands keep the same
request identity and marker in addition to their command-specific handles. A
client crash therefore leaves a request-wide recovery handle for the
coordinator or its successor. A legacy run publishes its token-scoped
obligation before the first signal. A failed drain keeps the marker,
obligation, and coordinator reservation. Its verdict states that the mapped
command ran.

A legacy sequential run keeps the settled lineage state under its owner token.
Before the next command, it validates that settlement and replaces it with a
fresh unbound baseline. Final release removes the validated owner and empty
`run.lock` first. It then retires only exact unbound state or durable settlement
state. A crash between these steps leaves an inert state with no lock authority.
Coordinator adoption replaces the legacy owner with a generation owner and
exact generation marker. It retires the original unbound owner state only after
that handoff becomes durable.

Darwin settlement changes the granted lease to `settling` before the census.
This state blocks every new grant. A restart converts it to a typed drain
obligation and keeps the global barrier. The drainer retains the verified-empty
lineage state until the coordinator or legacy obligation is durably released.
It then discards that state. A missing contract or lineage record fails closed.
The drainer enumerates every stale request in one status snapshot. It settles
each request's Darwin command lineages as a separate cohort. Each census epoch
uses one coherent process snapshot.
The helper can signal an exact identity when any cohort lineage proves that it
owns the identity. An ambiguous classification in another lineage does not
remove this authority. An identity that is ambiguous in every lineage receives
no signal and keeps the request blocked. The helper persists every lineage's
census before it signals. The shell acknowledges obligations only after every
lineage reaches an empty exact set. It never combines obligations from two
requests into one cohort.
Each v4 lineage update increments a revision. Publication compares the current
state through an exclusive same-directory hard link before its atomic rename.
The transition plan records the full expected state, full target, operation,
and adjacent revisions. The helper fsyncs that plan, links the canonical
expected-state inode as `.current`, fsyncs the payload, and publishes a ready
hard link before rename. A recovery helper can complete only that exact plan.
A late writer links the newer canonical inode and fails the expected-state
comparison before publication. A foreground drainer and recovery watcher
cannot replace a newer tombstone set or settlement proof. One helper can remove
or replace a shared `.current` link while another helper has it open.
That overlap is bounded transition contention. An adjacent transition yields
until the older writer advances. A stale writer removes its old revision slot
only after a fresh stable canonical read proves that the slot is obsolete. A
three-link proof enumerates and validates every current-state link for the same
lineage and allowed revision range. A wrong type, owner, mode, unknown link, or
persistent extra link remains unsafe and fails closed. Only settlement can
upgrade an exact v3/v1 obligation. The upgrade clears its old settlement claim
and signal timestamps before it publishes v4/v2 and performs a coherent census.
Initial discard accepts only v4/v2 evidence. It publishes and validates a
terminal discard tombstone before it removes the canonical state.

The native helper brackets each census with two private fence children. It
accepts the census only when the fence unique IDs are adjacent and do not wrap.
Before it fills the PID vector, it reads the XNU process-count estimate. The
estimate must be at least the raw listed count, minus exactly one PID 0 slot,
plus 20. Extra slack permits processes that exit between the estimate and
vector reads. XNU excludes PID 0 from `nprocs`; the libproc vector includes it.
The raw count must fit in the recorded vector capacity. Adjacent fence IDs and
the post-fence row check still reject births during the census. Every emitted
process unique ID must predate the lower fence. The native helper tries at most
eight epochs per call.
The JavaScript authority path makes at most six calls inside one 15-second
monotonic budget. Its bounded exponential, PID-derived jitter breaks retry
symmetry between concurrent gates. Each native call gets at most five seconds
or the remaining budget, whichever is less. Exhausted fence or allocator
contention has a typed retry status. An ABI, I/O, parse, partial-output, or
subprocess-timeout failure remains an infrastructure error. The helper emits no
partial snapshot. One accepted empty epoch is the durable settlement proof. The
helper also probes global unique-ID allocation through a fork from a different
parent. These semantic checks fail closed on an incompatible XNU
implementation. They do not use an OS-version allowlist.

Static cache validation checks the source digest, helper digest, provenance,
file identities, directory identity, modes, and link counts. It does not run a
semantic probe or a throwaway census. `prepare-exact` and lineage preparation
run the semantic probe and one coherent census. They revalidate the cache and
then publish a private capability receipt. The receipt binds the source digest,
helper digest, cache identity, helper identity, and boot identity. Exact
capture, status, signal, refresh, bind, and watch require that same-boot
receipt. A missing, stale, changed, linked, or unsafe receipt fails closed.
Settlement also requires a receipt. A successor that resumes a durable lineage
from a different worktree can establish its own receipt through the full probe,
coherent census, and cache revalidation path. It can do this only inside the
bounded settlement deadline. The parent starts one persistent marker observer while the watcher
bootstraps. It validates the exact watcher identity only after the armed marker
appears. It does not fork a status command or sleep process every 25 ms. This
prevents the readiness path from creating process births during each census
attempt.

The lineage owns a process when its complete captured parent chain reaches the
bound root. The process unique ID survives `exec`, `setsid`, reparenting,
environment removal, and descriptor closure. The captured parent unique ID can
change during `exec`; stable row reads detect that transition. When a new
process has an incomplete chain, a different resource
and jetsam coalition pair proves that it did not inherit the bound root's pair.
The census excludes that process. An incomplete same-coalition chain remains
ambiguous and keeps the settlement barrier. The census never uses a process
name or executable path for this decision. It cannot infer process causality
through a broker that existed before the baseline. A Darwin preflight scans
tracked, untracked, and bounded ignored repository source. It rejects
unapproved XPC, launch-service, Apple-event, and Unix-domain-socket client
paths. It parses decoded `scripts` values from every `package.json` as shell
commands. It rejects direct broker calls in those values. It also fails closed
when a script contains a literal `bash`, `csh`, `dash`, `fish`, `ksh`, `sh`,
`tcsh`, or `zsh` token followed later in the script by a command-string option.
It matches across redirection, control, and newline syntax. This conservative
whole-script rule can reject quoted data. A bounded shell-word projection also
rejects all active parameter expansions, command substitutions, arithmetic
expansions, and backtick command substitutions. One narrow case is allowed. A
plain, non-nested parameter expansion can occur in a word made only from
double-quoted text after the script path. The word must be an ordinary
argument. Unquoted redirection and glob metacharacters (`<`, `>`, `*`, `?`,
`[`, and `]`) fail closed. A direct literal supported shell must be the first
command word. A fixed non-option script path must be the second word. This rule
rejects unquoted expansions, command prefixes, dynamic script paths, and all
command, arithmetic, and backtick substitutions. It rejects `env -S` and
`env --split-string` because these options parse an argument as a command. More
than 4,096 words, more than 8,192 active expansions, an unclosed quote, and an
unclosed or nested parameter expansion fail closed. Any ANSI-C quote fails
closed because it can decode an escaped shell name or option. The check removes
normal quote, backslash, and locale-quote markers before matching. It can
therefore reject a shell name and option used only as quoted data. This
conservative refusal avoids parsing or trusting the nested command string. Bash
`-C` stays distinct from `-c`; fish `-C` is a command-string option. A malformed
scripts object, a non-string script, or a package-manifest symlink also fails
closed. It also rejects
native executable magic and a source
symlink that does not resolve to an enumerated regular file inside the
repository. Fixed path, Git-output, file-size, and total-source limits fail
closed. The ignored-file
walk excludes only named dependency, tool-cache, generated-build, coverage,
documentation, and local-evidence directories:
`.git`, `.cache`, `.investigations`, `.next`, `.pnpm-store`, `.rankings`,
`.reviews`, `.tmp`, `.trunk`, `.turbo`, `coverage`, `dist`, `docs`,
`node_modules`, and `vendor`. Its exact allowlist contains only reviewed local
protocols that cannot request an external process. Static inspection cannot
detect arbitrary runtime-built broker calls or calls hidden in excluded
dependencies and system executables. The coalition mismatch exclusion
classifies external-service processes only within this preflight contract.
Mapped commands must not use unsupported broker forms to launch persistent
broker-owned processes. Add a persistent service only through a named
coordinator resource and a bounded lifecycle wrapper.

The gate binds this preflight module to stable startup bytes in an unlinked,
read-only descriptor before repo-owned helpers or mapped commands run. It
records the descriptor identity and SHA-256 digest. The gate parent or parallel
worker revalidates both before each dispatch and imports those exact bytes.
Every mapped target wrapper closes its inherited descriptor before START, so
mapped code cannot retain or change the parent's preflight source handle.

One generated dependency has a narrower native exception. A provider under an
exact `.terraform-agent-gate/providers/registry.terraform.io/<namespace>/<type>/<version>/darwin_<current-architecture>`
directory passes only when its nearest `.terraform.lock.hcl` is tracked. The
preflight resolves `refs/remotes/origin/main` to one commit and pins the unique
merge-base with `HEAD`. It reads the stack registry and owning lock from that
exact Git object. The stable worktree files must match those blobs byte for
byte. The trusted registry must contain the stack. The trusted lock must select
the same source and version and contain the provider directory's exact `h1:`
hash. There is no fallback to the current branch, index, or worktree policy.
The hash covers every package file name and byte. The package and every
ancestor must retain stable regular-directory identities. Package files must
be single-link regular files. The package must contain one structurally valid
thin or fat Mach-O executable for the current CPU with Terraform's exact
provider name. It rejects any other native or executable file. A changed byte,
entry, link, mode, platform, path, lock selection, ancestry, or snapshot fails
closed. Other content under `.terraform-agent-gate` remains inside the normal
scan.

While work runs, the recovery watcher samples one coherent lineage census every
200 ms. It durably keeps owned and ambiguous candidates. It excludes fresh
unrelated rows. A parent can start and exit entirely between two samples. In
that case, a same-coalition descendant stays ambiguous and blocks release. This
sampling limit can delay cleanup. It cannot cause a bare signal or a false
settlement.

Two manifest-class changes are narrowed away from the full workspace suite
instead of escalating unconditionally (Refs #1414). Every ambiguity fails toward
the full suite:

| Change                                               | Escalation                                                                                                                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm-lock.yaml`, importer sections only             | `pnpm install --frozen-lockfile` + `pnpm skew:check` + `pnpm lockfile:lint` + each changed importer's package quality bundle (`.` root importer → full suite).    |
| Root `package.json`, `devDependencies`/metadata only | `pnpm install --frozen-lockfile` + `pnpm skew:check` + `pnpm lockfile:lint` + the `@mento-protocol/config` bundle as canary (it typechecks downstream consumers). |

Lockfile scoping applies only when `pnpm-lock.yaml` is the sole
workspace-manifest-class change and `scripts/gate/lockfile-scope.mjs` (js-yaml
structural diff) reports that only importer sections changed; a parse/`git show`
failure, a co-changed manifest, any non-importer top-level section
(`settings`, `catalogs`, `overrides`, `patchedDependencies`,
`packageExtensionsChecksum`, `packages`, `snapshots`, …), or an importer that
maps to no known package bundle falls back to the full suite. A classifier the
gate cannot find is the one exception: it exits 2 and names the path, because
widening on a stale path reads as a slow-but-green run that nobody investigates.
The dev-metadata class covers a root `package.json` whose changed JSON pointers
are all under `/devDependencies` or `/name`, `/description`, `/license`,
`/keywords`, `/author`, `/repository`, `/bugs`, `/homepage`; any
`/dependencies`, `/pnpm`, `/packageManager`, `/engines`, `/scripts`, or
unknown-key change keeps today's full-suite and package-script refusal
behavior. Both classes still set the package-script risk flag, so `--run`
continues to refuse until `--allow-package-script-changes`, and `package.json`
still gets a full-repo Trunk scan.

The classifier is `classifyRootPackageJsonChanges` in
`scripts/gate/mapping/facts.mjs`, and its trusted-alias allowlist is
`TOOLING_SCRIPT_POINTERS` beside it.
`scripts/sentry/ci-wiring/check-sentry-suites-in-ci-gate-probe.mjs` imports it
and proves each `sentry:*` alias still classifies as `root-tooling-scripts`, one
pointer per call, over a closed verdict set: a class the classifier answers that
is not one of the four fails the check rather than being stored as a
plausible-looking string. Adding a class means re-reading every caller that
compares a verdict to a literal.

Until D5c the classifier was the bash function `classify_root_package_json_changes`,
and the probe lifted it out of `agent-quality-gate.sh` and re-ran it under an
empty `$PATH` in restricted mode with stubbed helpers. The lifting machinery
survives in `check-sentry-suites-in-ci-gate-extract.mjs`, because ADR 0069's
routing-table suite uses it to read `implementation_signature()` and to drive
`/bin/bash` as the pattern oracle.

### Script path pins

These four path-pin classes complement the full inventory in
[ADR 0064](../adr/0064-scripts-module-directories.md). Move each pin with its
file in the same PR. The autoreview feedback-runtime pins use the staged move
procedure below.

- **Autoreview runtime pins.** `agent-autoreview.sh` pins its sibling runtime,
  `gate/darwin-process-identity.c`,
  `gate/darwin-process-identity-runtime.inc.c`,
  `gate/darwin-process-identity-helper.mjs`,
  `gate/darwin-process-lineage-model.mjs`,
  `gate/darwin-process-lineage-state.mjs`,
  `gate/darwin-process-lineage.mjs`,
  `gate/mapped-command-process-identity.mjs`, and optional
  `pr-feedback-state-claude.mjs` and
  `pr-ready-state-review-signals.mjs`. Changes to the six Darwin runtime files
  route both `pnpm agent:autoreview:test` and
  `pnpm agent:quality-gate:test`. Feedback blobs use `origin/main`. Move
  feedback paths in three merges: add copies and fallback; repoint; remove old
  paths after no pre-move wrapper remains.
- **Gate routing pins.** The gate excludes stub-repo tests with
  `$script_source_dir == $repo_root/scripts`, and pairs
  `bootstrap/codex-cloud-setup.{sh,test.sh}` for offline tests. It routes
  `sentry/autofix/sentry-autofix-refused-inventory.mjs` alone to
  `pnpm sentry:autofix:run-record:test` and
  `pnpm sentry:autofix:finalize:test`. Exact
  `sentry/triage/sentry-triage-project-route.mjs` runs
  `pnpm sentry:project:test` in the projection arm.
  `deploy/deploy-indexer-verify{,-analysis}{,.test}.mjs` and
  `deploy/deploy-indexer-verify-status-identity.mjs` use one any-depth arm;
  both verifier tests run. The exact `pr/agent-issue-board{,.test}.mjs`,
  `pr/issue-board-{backfill,cli,commands,projects,state,sync,transport}.mjs`,
  and `pr/issue-board-{lock,ownership,release,sync-lock,transactions}.mjs` set
  routes to `pnpm issue:board:test`. Required CI runs it after failures. ADR
  0082 owns confinement. Exact
  `repo-health/check-guardrail-prose{,.test}.mjs` and
  `repo-health/guardrail-prose.json` route to the guardrail suite. `ci.yml` pins
  both paths in two jobs, quick-commands names the checker, and the manifest's
  keys pin `AGENTS.md`, `CLAUDE.md`, and the operating card.
  [ADR 0073](../adr/0073-guardrail-prose-pinned-in-ci.md) owns that contract.
  `pr/merge-pr*`, both PR-state helpers, and `agent-autoreview.sh` (Codex
  markers) route `pnpm pr:merge:test`. The exact
  `sentry/broker/mapped-command-process-identity.mjs` bridge routes
  `pnpm sentry:broker:test`. It keeps the probe's local import on the same
  canonical helper that the workflow stages.
- **Gate runtime pins.** Before `cd`, `agent-quality-gate.sh` resolves
  `gate/run-handles.sh`, coordinator files,
  `gate/darwin-broker-launch-preflight.mjs`,
  `gate/darwin-process-identity.c`,
  `gate/darwin-process-identity-runtime.inc.c`,
  `gate/darwin-process-identity-helper.mjs`,
  `gate/darwin-process-lineage.mjs`,
  `gate/darwin-process-lineage-model.mjs`,
  `gate/darwin-process-lineage-state.mjs`,
  `gate/darwin-process-lineage.sh`, `gate/trunk-check-once.sh`,
  `docs/docs-navigation-eval-helpers.mjs`, and `gate/lockfile-scope.mjs` from
  `$script_source_dir`; tests hash them from `$repo_root`. The implementation
  signature also hashes `gate/mapped-command-process-identity.mjs` from
  `$repo_root` because mapped commands in the repository under test consume it;
  the gate does not load that helper itself. Move each path with its routes,
  signatures, fixtures, and literals. ADRs
  [0064](../adr/0064-scripts-module-directories.md) and
  [0076](../adr/0076-fair-quality-gate-coordinator.md) own those constraints.
- **Gate mapping pins.** The signature and three Turbo inputs pin
  `gate/routing-table/**`, `gate/mapping*`, and
  `agent-autoreview-core.mjs` plus its sealed exact-patch suppression JSON.
  Runtime hashes use `$script_source_dir`; suites use `$repo_root`. Core and
  suppression-policy edits route the autoreview suite. Missing pins freeze the
  stamp.
  [ADR 0069](../adr/0069-gate-routing-table-as-data.md) owns this contract.

### Where the plan comes from ([ADR 0069](../adr/0069-gate-routing-table-as-data.md))

Routing is Node. The gate calls the mapping engine once and uses its plan:

```bash
node "$script_source_dir/gate/mapping.mjs" \
  --repo-root "$repo_root" --changed-paths-file "$changed_paths_file" \
  --base "$base_ref" --head "$head_ref" \
  --script-source-dir "$script_source_dir" [--real-tree] [--full-local-tests]
```

`$script_source_dir`, not `$repo_root`: the mapper is resolved the way every
other gate helper is, so a fixture run finds the real one. `--real-tree` is the
gate's own `[[ "$script_source_dir" == "$repo_root/scripts" ]]` test, which
fences the four repository-specific effects away from fixture repositories.
The freshness signature follows the same root: mapper and routing-table runtime
modules hash from `$script_source_dir`. Their suites hash from `$repo_root`
because the gate runs them as mapped target-tree commands.

The engine answers on stdout in the TSV shape `write_command_plan` already
emits, in this order and no other — the gate prints and the freshness stamp
hashes in the same sequence:

```text
flag<TAB>package_script_risk_changed<TAB>true|false
flag<TAB>saw_workspace_escalation<TAB>true|false
surface<TAB><name>
checklist<TAB><path><TAB><reason>
preflight|codegen|post-codegen|quality<TAB><command><TAB><reason>
```

**Every failure around the seam is a refusal**, and each message is greppable:

| Message on stderr                                                                   | What happened                                                |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `gate mapping engine could not be loaded from …`                                    | The mapper is not at that path. A `scripts/` move missed it. |
| `gate mapping engine failed (exit N); refusing to run on a plan it did not produce` | The mapper threw. Its own reason is on the line above.       |
| `gate mapping engine produced an empty plan; refusing to run`                       | The mapper wrote nothing — most often a stubbed `node`.      |
| `gate mapping engine emitted an unparsable record: …`                               | A record the gate cannot read. Never partially applied.      |
| `gate mapping engine emitted an unknown flag record: …`                             | A `flag` record the gate does not know.                      |

There is no fallback path. Before D5c the gate also ran the bash `case` arms,
rendered their plan in the same shape and refused on a one-byte difference — the
soak guard. That guard, the arms and the parity harness went together at D5c
(issue 2020): without the arms there is nothing to compare, and the harness's own
comparison would be the engine against itself. What routing correctness rests on
now is `pnpm gate:routing-table:test` (the pairing lint, the staleness check, the
`/bin/bash` pattern oracle, the closed verb set) and
`node --test scripts/gate/mapping/engine.test.mjs` (dedupe and first-reason-wins,
bucket order, the five post-passes, the root-manifest classifier). Both are
routed by a change to the engine or the table, and the routing-table suite also
runs in the required `ci` job.

### Scheduling contract (Refs #1802, #2006; [ADR 0076](../adr/0076-fair-quality-gate-coordinator.md))

`--run` requests share a transient machine-wide coordinator. The coordinator
admits independent work from different worktrees under a weighted capacity. It
does not serialize complete gate runs. Contention, not flakiness, caused the
failures in issue #1802. The scheduler therefore bounds machine load and keeps
known exclusive resources separate.

Before invoking a full gate, wait for all direct validation, dashboard servers,
and browser suites that run outside the coordinator on the same machine to
finish. From invocation until the gate exits, do not start uncoordinated work
there. The gate owns dependency setup and local validation parallelism for its
worktree. Concurrent package-manager processes in the same worktree can
recreate or invalidate `node_modules`. Uncoordinated validation from another
worktree can still starve the gate of CPU and memory. Use spare workers for
read-only work. Run concurrent validation outside the coordinator only from a
fully hydrated checkout on another machine.

The coordinator uses a Unix domain socket and private state root. Startup binds
the socket first with a not-ready handler. Calls during legacy-lock adoption
receive `COORDINATOR_STARTING`; no request starts. Successful adoption writes
ready metadata and enables the request handler. Failed adoption removes the
socket and leaves or restores the previous legacy owner. The coordinator
normally exits when the queue, workers, recovery drains, and client handoffs
are empty.

Before lock acquisition, the adapter asks the coordinator runtime to validate
the exact socket path. A path longer than the portable 100-byte bound produces
a warning and selects the serialized legacy lock for that run. The fallback
keeps machine exclusion and never starts unrestricted mapped commands.

Protocol, journal, and policy versions are explicit. An unsupported version,
malformed state, or invalid resource name fails closed. The Bash adapter also
rejects names outside its `browser-fixture-3211`, `playwright-install`,
`terraform-plugin-cache`, and `trunk-daemon` policy allowlist. It never falls
back to unrestricted execution.

The effective policy binds the hosting Node runtime identity and the production
coordinator source signature. The runtime identity covers the resolved
executable path, version, platform, architecture, and `NODE_OPTIONS`. Only a
SHA-256 digest of that identity enters the policy. This server identity is
distinct from the request-specific inputs in the execution fingerprint. Those
inputs bind the request's Node and pnpm toolchain and material command
environment.

Before it materializes the adapter, the gate selects its effective `TMPDIR`.
It keeps a caller path only when that path is a writable directory. Otherwise,
it uses the repo-owned `.tmp/agent-quality-gate` scratch directory. This
fallback also applies to dry runs. The gate then materializes the two Bash
adapter files in one private directory. It checks their hashes against stable
source snapshots before and after the copy, then sources only those copies. The
prepared policy binds the loaded hashes.
The adapter rechecks that policy after it acquires the legacy lock. The parent
and detached child each derive and verify the current Node and source identity
again. The child repeats that check before root setup, stale-socket removal and
binding, durable state initialization, legacy adoption, startup maintenance,
and ready publication. A mismatch stops the next transition. A later startup
failure closes the bound socket and restores the previous legacy owner.
After ready publication, the production source attestor rechecks the loaded
runtime before each non-detach RPC mutation, wait registration, connection
binding, and response. Delayed wait success and timeout responses repeat both
the source and legacy-authority checks immediately before they write. Runtime
drift stops the coordinator, abandons its legacy authority for recovery, and
prevents another persistent-state change.

Ready-file existence alone does not complete startup. The parent validates the
published protocol, policy, capacity, namespace, child identity, generation,
and authority against a live coordinator `inspect` response. If publication
fails after an atomic rename, the child removes only canonical metadata that
names its exact policy, generation, and process identity. It fsyncs each parent
directory before it restores legacy ownership and closes the socket.

The adapter owns the internal identity probes:
`adapter-hashes`, `node-policy-hash`, `runtime-hash`, `source-signature`, and
`policy-hash`. Run the public `pnpm agent:quality-gate` command. Do not assemble
or persist these probe values as an operator workflow.

The adapter creates one random request capability after the socket-path
preflight. `AGENT_QUALITY_GATE_REQUEST_CAPABILITY` is an internal transport
value. Do not set or reuse it. The adapter gives it only to request client
processes. Detached startup strips it before the coordinator child starts, and
the server refuses to retain it. The request record and journal contain only
its SHA-256 digest. Scheduler status omits the digest. Every request-scoped
status, wait, lease, result, acknowledgement, cancellation, and registration
retry requires the capability and the exact owner PID/start identity. Only the
coordinator can mark an owner stale after a bound disconnect or process probe.
Every bound registration includes retained-result reuse. A separate lifecycle
process keeps the connection open. The parent atomically writes `clean` or
`unclean` to a private control file and waits for the lifecycle completion
record. It then waits for the cached child status. Cleanup never signals the
stored PID because the operating system can reuse that PID after the child
exits. `TERM`, `HUP`, `INT`, parent death, and transport loss close the
connection as an unclean disconnect.

This check prevents accidental cross-session mutation between cooperative gates
that run as one user. It does not isolate hostile code under the same operating-
system user. Drain recovery remains cross-client by design because a successor
must remove tagged workers after the original gate dies.

A journal commit failure or terminal-result persistence failure stops the
coordinator before it can process another message. It closes current and new
connections and abandons the legacy owner. It does not use mutated in-memory
state to release the lock. The next coordinator recovers the last durable
journal and any exact immutable result. A waiter receives a result only after
the journal marks its request result-ready.

Detached startup waits at most 10 seconds for ready metadata. An ordinary RPC
has a 5-second transport timeout. Admission, lease, and result wait RPCs use the
requested wait bound plus a 1-second transport margin. The detached process
appends to `coordinator.log`. Startup rotates it to `coordinator.log.1` when it
exceeds 1 MiB and retains only that one rotated log.

**Capacity and fairness.** `AGENT_QUALITY_GATE_CAPACITY` sets global capacity
from 1 through 64. The default is 3. An ordinary command uses one unit. The gate
self-test reserves weight 2 when capacity is at least 2. At capacity 1, it uses
weight 1. A request's `--parallel` value is a local upper bound; it does not
increase the global capacity. The coordinator schedules one ordinary command
per runnable request per turn. One parallel pool can queue several leases, but
it cannot consume every fair dispatch turn while another request is runnable.

The oldest weighted lease at the head of its request reserves the capacity it
needs. The reservation also holds while that lease waits for a named resource.
Younger weight-1 work cannot consume it. This rule keeps a weight-2 self-test
from starving while ordinary commands continue to arrive.
An older weight-1 lease blocked by a named resource does not stall a grantable
weighted reservation. The scheduler first selects the oldest eligible
weight-1 lease. If none is eligible, it evaluates the reservation.

An all-capacity command is a fair barrier. When that command reaches its turn,
the coordinator stops new ordinary admission, waits for active work to drain,
then grants all capacity to the command. New short requests cannot starve an
older barrier. These evidence-backed command classes use all capacity:

- dashboard full or scoped coverage;
- dashboard browser tests and their fixture build;
- dashboard production build and size-limit work;

The three mutation baselines remain ordinary weight-1 commands. Their recorded
serial runtimes do not prove cross-run contention. The global capacity still
bounds their aggregate concurrency.

Browser work also claims `browser-fixture-3211`. Playwright installation claims
`playwright-install` because every worktree mutates the shared
`~/.cache/ms-playwright` browser store. A mapped `terraform init` claims
`terraform-plugin-cache` unconditionally. Terraform CLI configuration can
enable a shared cache after request registration or while a request waits.
Terraform does not guarantee that this cache is safe for concurrent writes.
The unconditional resource claim closes that configuration race. The launcher
removes inherited `TF_PLUGIN_CACHE_DIR` and selects `/dev/null` as its empty
Terraform CLI configuration. It also removes provider reattachment,
development-override inputs, checksum-breaking cache policy, and inherited
`TF_CLI_ARGS*`. The cache resource remains because a mapped command can add an
explicit assignment after scheduling. The Darwin preflight rejects Terraform's
symlinked cache layout. Each named resource has capacity 1. Add a new resource
or all-capacity class only with contention measurements and scheduler
regression coverage.

**One request per worktree.** The coordinator serializes complete requests that
use the same resolved `git rev-parse --show-toplevel` path. It does not use the
shared Git common directory as this key. The worktree lease protects `.tmp`,
`node_modules`, generated files, Terraform data, coverage and mutation output,
and dashboard build output. Different worktrees can progress together. A
terminal result leaves each attached request holding its worktree admission
until that client reads, validates, hands off, and explicitly acknowledges the
result. Only `ack-result` removes that request and admits the next request for
the same worktree. Owner cleanup acknowledges a result-ready request whose
client died. If a bound leader disconnects before drain completion, the journal
records automatic acknowledgement. That flag survives restart. When the drain
publishes the terminal result, the coordinator removes the dead request and
admits the next request for that worktree.

**Exact-result coalescing.** Requests with the same complete execution key join
one leader execution. The key binds repository identity, the base and HEAD
OIDs, changed paths, validated file bytes and modes, normalized command plan,
gate/coordinator/policy signatures, OS and architecture, resolved Node and pnpm
executable paths and versions, the effective per-command timeout, resolved
local parallelism, fail-fast policy, the effective `--lock-wait` scheduler
budget, and safe digests of material environment inputs. The implementation
signature includes `.trunk/trunk.yaml`; it does not probe the installed Trunk
version. The leader revalidates the key before its first command and before it
publishes the result. Each waiter revalidates its local key before it accepts
that result. A plan that runs the Aegis Forge tests also binds the expected and
actual checkout state of the tracked Aegis submodules. It distinguishes missing
and uninitialized checkouts. It rejects dirty submodule worktrees and hidden
index states such as `assume-unchanged` and `skip-worktree`.

The environment digest preserves PATH order and duplicates. It normalizes each
absolute PATH entry that resolves exactly to a material package root's
`node_modules/.bin` and a `PNPM_SCRIPT_SRC_DIR` or `INIT_CWD` that resolves
exactly to the current worktree root. It also binds the effective `TMPDIR` and
each visible `TMP` or `TEMP` value. The gate-owned
`.tmp/agent-quality-gate` fallback uses a worktree token so equivalent fallback
paths can coalesce across worktrees. Other temp paths remain exact. The
digest preserves relative PATH entries and selected relative path settings. It
also binds their physical working directory. This rule covers selected repo,
loader, tool configuration, structured, lifecycle-root, and temp values. The
selected values include standard proxy settings, GitHub base-event inputs,
parent-consumed quality-gate self-test controls, and nonsecret tool controls.
Different selected values cannot share a mapped verdict. The mapped-command
launcher removes child-only test and validator injections. This includes
`ESLINT_BASELINE_INPUT`, inherited `ESLINT_BASELINE_MAIN`, alert-rule fixture
paths, validator root overrides, focused child-test controls, and ambient
cloud-provider credentials that the autoreview tests can forward. These values
stay outside the shared key because mapped descendants cannot read them. An
assignment inside a mapped command still applies. CI package lint jobs run
outside this launcher, so their `ESLINT_BASELINE_MAIN` assignment remains
active. Legacy lock-test controls that the parent gate consumes stay in the
outer key, but the launcher removes them from mapped descendants. The nested
gate marker `AGENT_QUALITY_GATE_LOCK_HELD` remains available to the self-test.
The launcher also removes inherited Trunk launcher identity and quiet
controls, plus credential-bearing `CURL_FLAGS` and `WGET_FLAGS`. The mapped
Trunk wrapper supplies its own identity. The provisioning probe sets quiet mode
inside its sanitized child. Normal mapped commands inherit the gate-owned
`CI=true`, which makes the Trunk wrapper quiet. The gate removes inherited
`GIT_*` controls before its first Git probe and from mapped descendants. The
launcher also removes `TERRAFORM_CONFIG`, `TF_CLI_CONFIG_FILE`,
`TF_PLUGIN_CACHE_DIR`, `TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE`,
`TF_REATTACH_PROVIDERS`, and the `TF_CLI_ARGS*` family. It then sets
`TF_CLI_CONFIG_FILE=/dev/null`. The cache variable stays material to the outer
execution key, but mapped commands cannot use it because Terraform can install
cached providers through symlinks. Ordinary `TF_VAR_*` inputs remain available.
The digest also binds stable content snapshots of ignored `.env` and `.env.*`
files in workspace roots. It excludes tracked `.env.*.example` files.
It also binds a bounded installed-dependency manifest. The gate snapshots
`node_modules/.modules.yaml`, `.package-map.json`,
`.pnpm-workspace-state-v1.json`, and `.pnpm/lock.yaml`. It removes only pnpm's
volatile prune and validation timestamps. It normalizes exact worktree-root
paths in JSON keys and values. For every material package root, it enumerates
direct unscoped and scoped package links. It binds each link's bytes,
normalized real target, modes, and linked `package.json` bytes. A link back into
a workspace package is source-bound. Generated and ignored workspace output
stays outside this digest because setup can rewrite it during the run. Every
mapped command that can load `@mento-protocol/config` schedules its build as a
non-reusable quality-setup prerequisite. That build removes `dist/` before it
emits current output, so missing, stale, and orphaned files converge to one
state. For each unique external direct package, the manifest hashes the names,
types, modes, and sizes of top-level entries. It resolves exact paths declared
by `main`, `module`,
`types`, `typings`, `bin`, `browser`, `exports`, and `imports`. It hashes the
complete resolved file through 512 KiB. It also binds implicit package-root
index fallbacks and any nested `package.json` used during directory resolution.
For a larger file, it hashes the size and the first and last 64 KiB. Symlink
entrypoints also bind their link and resolved target. The manifest fails closed
on an unsupported entry, dangling link, concurrent change, more than 16,384
entries, a metadata file larger than 8 MiB, or more than 32 MiB of read content.
Each file, link, and directory revalidates its identity before the manifest
returns. This bounded identity detects a
missing direct link or a changed bound payload without walking the complete
package trees. Missing pnpm metadata or a missing linked `package.json` stops
registration. Unrelated deep package files, wildcard export targets, and the
unsampled middle of a large entrypoint stay outside this identity.
The Turbo lint, build, and fixture-build keys declare the matching environment
and dotenv inputs that the gate can reach. A new outer coordinator key cannot
reuse an inner Turbo result that validated different inputs. The digest binds
selected external tool and configuration locations by their literal values. It
does not recursively hash system tool, certificate, HOME, or XDG path contents.
Do not use retained reuse after content at one of those external paths changes
without its path changing.
The
gate removes `BASH_ENV`, `ENV`, `SHELLOPTS`, `BASHOPTS`, `BASH_COMPAT`,
`CDPATH`, `GLOBIGNORE`, `POSIXLY_CORRECT`, `POSIX_PEDANTIC`, and exported Bash
function records
before it starts any internal Bash control shell or mapped command. It starts
those shells in privileged mode. The filtered environment reaches mapped
descendants. This boundary prevents caller startup controls from changing a
shared result through an internal control shell or mapped-command tree. The
normalized local-bin entry binds bounded, stable manifests for the repository
root and each known mapped package root. Each manifest binds its root label,
missing or present state, names, modes, types, and wrapper bytes. A symlink
entry also binds its link and the resolved regular file's mode and bytes. The
roots share one entry and byte budget. A symlinked local-bin root, unsupported
entry, unstable snapshot, or exceeded size limit stops the gate. A link path
replaces the physical worktree
root only when the complete target equals that root or starts with that root
plus `/`. The complete path must equal its lexical canonical form and contain no
`.` or `..` traversal. Wrapper and dereferenced target bytes remain exact unless
they are valid UTF-8 pnpm shell shims that start with `#!/bin/sh` and contain
exactly one `# cmd-shim-target=` sentinel. In a recognized shim, only canonical
complete root or root-descendant paths in the sentinel and in colon-delimited
segments of exact assignments that start with two spaces followed by
`export NODE_PATH="..."` are replaced. All other bytes and line endings remain
exact. Every other link path and selected environment value also remains exact.
A frozen install does not exempt the current local-bin manifests. pnpm can
retain an unexpected `.bin` executable, and package scripts can still resolve
that executable from `PATH`. Registration, first dispatch, and result
publication bind the actual root and package manifests. If dependency setup
changes one of them, terminal reattestation cancels shared publication. A later
run binds the resulting post-install state.

The manifest reads at most one entry beyond its entry limit and stops before it
sorts names. Before it reads each regular wrapper or symlink target, it checks
the declared file size plus the name and link bytes against the per-file limit
and the remaining aggregate byte budget. The stable double snapshot still
detects directory or file changes.

Coalescing shares the exact terminal result, including its status and payload.
It does not share per-command statuses, generated output, or other
worktree-local output. The leader gate owns its worker. A leader failure,
cancellation, interrupt, disconnect, or drift gives every attached follower the
same non-success terminal result and payload after required drain work. A
follower disconnect only detaches that follower. It does not cancel the leader.
Only a verified success can satisfy later freshness reuse. A run that neither
executes nor reuses verified work never reports success, including through a
pipe.

A run can pass after it skips Trunk only when one of the post-failure checks
classifies the environment as blocked. The launcher probe can report that it
cannot fetch the CLI as `provisioning-unavailable`. The failed Trunk transcript
can pass the fail-closed downstream-download classifier described above as
`downloads-unavailable`. The leader publishes that outcome as a qualified
success with `reusable: false` and the exact skip reason. An active follower
receives the same qualified result and a matching blocked-download warning. The
coordinator does not create a retained-success index for it and removes any
older index for the same fingerprint. A later `--skip-if-fresh` request
therefore leads a new execution and retries Trunk. The command lease stays
reserved until the classification, any launcher probe, and all identified
descendants drain.

Each blocking RPC helper carries the request and coordinator process tags and
marker descriptors. It closes the caller's inherited output descriptors. A
hard-killed gate therefore cannot leave an orphaned wait process holding its
caller's output pipe. A result wait also includes the exact follower request and
owner identity. Owner cleanup removes that request and ends the wait. Normal
cleanup atomically writes `cancel` to a private control file, waits for the
helper's completion record, and then waits for its cached child status. It does
not signal a stored wait-process PID.

An active exact-key singleflight takes precedence over an older reusable
success. A matching caller joins the active execution. The coordinator checks
its retained success index only when no matching execution is active. Plain
manual `--run` sets the reuse age to zero, so it never reuses a retained
coordinator success. It leads or joins an active exact execution.
`--skip-if-fresh` can reuse a verified success up to two hours old.

The coordinator refuses terminal-result publication while any lease for that
request exists. If a scheduler or resource wait fails before a command starts,
the gate sends `abandon-lease --command-not-started`. This removes the queued or
newly granted lease without a drain. After a command can have started, failure
keeps the lease and its capacity or named resources reserved until recovery
confirms the process tree is empty.

**Timing records.** The gate records worktree admission wait, combined command
scheduler wait, execution time, and coalesced wait separately in
`.tmp/agent-quality-gate/durations.jsonl`. It still records `__run_total__`.
The scheduler status and wait message identify the initial capacity, fairness,
and named-resource blockers. One wait can change blocker class, so the duration
record does not claim a separate resource-only clock. Use the separate fields
when you investigate delay. A whole-run total hid the machine-wide lock
bottleneck.

The adapter root is `qgc-v1-u<uid>`. Its version-, policy-, and
capacity-specific state namespace retains terminal result records and verified
success indexes for two hours. It removes inactive request records. Active
requests and their recovery evidence do not expire. Startup also checks
obsolete policy or capacity namespaces under that root. An idle obsolete
namespace keeps recent results for two hours. Startup prunes expired records
and removes the empty namespace. Before any prune or deletion recovery, it
parses the supported namespace protocol and fully validates the journal and
retained results. It leaves unsupported or malformed namespace evidence intact
and reports a warning. It retains and reports any namespace with
active requests, leases, singleflights, or drain obligations. It retains an
expired result while an active leader or follower still needs its local
handoff. Before it unlinks an expired success result, it commits removal of the
matching success index. A failed commit keeps both records. A crash after the
commit can leave an unindexed valid result, which the next prune removes. A
live coordinator with a different policy or capacity rejects the client, which
waits on the shared legacy lock before it starts the new namespace.
Empty-namespace removal publishes and fsyncs an exact `.deleting-v1` marker
through a fixed `.deleting-v1.staging` hard link. A stage-only restart cancels
marker creation and revalidates the journal. A marker-plus-stage restart repairs
marker durability before deletion. A restart resumes only a valid marked
deletion or an already empty namespace. The cleanup fsyncs the state parent
after it removes the namespace.

Maintenance also removes crash staging artifacts from these exact state-
namespace locations:

- `journal.json.tmp-<positivePid>-<lowercaseUuidV4>`;
- `requests/<requestId>.json.staged-<positivePid>-<lowercaseUuidV4>`;
- `results/<fingerprintHash>/<executionId>.json.staged-<positivePid>-<lowercaseUuidV4>`.

Maintenance runs only while the coordinator holds legacy authority. It commits
any expired success-index removal for that pass before it removes an artifact.
It removes an artifact only when it is a direct child with the exact writer-
generated name, a regular non-symlink file owned by the current UID, and more
than two hours old. It retains unknown names, recent files, files exactly two
hours old, future-dated files, symlinks, and non-file entries. A retained entry
keeps its namespace non-empty.

#### Legacy lock compatibility and recovery

After binding its not-ready socket, the coordinator adopts the existing mkdir
lock
(`$HOME/.cache/agent-quality-gate/run.lock`, falling back to
`$TMPDIR/agent-quality-gate-<uid>`; override with
`AGENT_QUALITY_GATE_LOCK_DIR`) while scheduled or recovery work exists. A new
gate joins a compatible coordinator. An older gate sees a live legacy owner and
waits. If an older gate owns the lock first, the starting new gate waits before
it starts a coordinator. This rule prevents old and scheduled gate versions
from running mapped commands together.

The coordinator checks its legacy owner and marker before each request,
response, and maintenance mutation. The owner check binds the path to its exact
inode and text. The marker check binds the path to the descriptor that the
coordinator opened with exclusive creation. It requires the exact inode,
current UID, and generation text. The coordinator checks authority again
immediately before each scheduler grant and terminal result. Authority loss
stops the coordinator. The durable journal and legacy record remain for
recovery, so the displaced coordinator cannot grant queued work, prune records,
clean up owners, or publish success. Rollback and release remove the marker only
through an exact-inode quarantine. Every coordinator marker cleanup, including
publication failure, adoption failure, rollback, and release, uses a top-level
`holder.reclaiming.quarantine.v1.<hostname-sha256>.<pid>.<nonce>` directory at
the lock root. Crash remnants from those quarantines are inert and never enter
Bash owner recovery. Cleanup retains a replacement marker.

Node opens every mutable legacy owner or unpublished owner-stage path with
`O_RDONLY | O_NOFOLLOW | O_NONBLOCK`. It then uses `fstat` to require a
current-UID regular file before it reads owner bytes or changes a stage's mode.
`O_NOFOLLOW` rejects a symlink. `O_NONBLOCK` makes a FIFO open return, and the
type check rejects the FIFO. Both cases fail closed without blocking the
coordinator.

A Bash run or command holder marker contains raw `<token>\n` bytes. It is not an
owner record. A normal drain removes it only after the process census is empty.
`EXIT` cleanup attempts removal only after worker teardown and while no command
drain is active. Cleanup binds the current pathname at cleanup time. It opens the
path without following symlinks, requires a current-UID regular file with the
exact raw body, and creates a hard-link witness for that inode. This check does
not claim creation-time inode identity. The private directory uses the disjoint
name
`holder.reclaiming.quarantine.v1.<hostname-sha256>.<pid>.<nonce>`. If the shared
path names a different inode after the witness, cleanup returns status 2 and
retains the quarantine. If the move placed that different inode in the
quarantine, cleanup can restore it to the shared path with an exclusive hard
link only when it is a current-UID, non-symlink regular file with the exact
`<token>\n` body. The quarantine retains both private inodes after that
restoration. A moved entry with an unsafe type, UID, or body stays private. A
replacement that appeared after the move stays at the shared path. That cleanup
attempt never deletes its post-witness replacement. After a refusal, that
process does not retry cleanup for the token during a later drain or `EXIT`
teardown. `EXIT` cleanup still attempts legacy-lock release. It changes an
otherwise successful status to 2 when marker or lock release fails and preserves
an earlier non-zero status. A `SIGKILL` can leave a top-level holder quarantine.
No recovery scan consumes it, and it grants no authority.

The `lsof` process scan binds the marker pathname at scan time. It creates a
mode-0700 private directory named
`.holder-lsof-witness.v1.<hostname-sha256>.<pid>.<nonce>`, hard-links the current
marker into it, and validates the private link as a current-UID, non-symlink
regular file with the exact raw `<token>\n` body. `lsof` reads only that
witnessed inode. Normal cleanup and invalid-snapshot cleanup remove only the
private link and directory. A `SIGKILL` can leave the private hard link behind.
No recovery scanner consumes it, and it grants no authority.

On Linux, procfs is the primary marker-descriptor scanner. It opens the shared
marker with `O_NOFOLLOW`, requires the current UID, exact inode, regular-file
type, and exact `<token>\n` body, and holds that descriptor through the scan.
It probes signal permission and reads the real, effective, saved-set, and
filesystem UIDs from `/proc/<pid>/status`. A sender real/effective match with a
target real/saved-set UID keeps a policy-confined or set-ID descendant in
scope. A successful signal probe also covers `CAP_KILL`. A full discovery scan
reads each proc-fd target. It skips only non-absolute targets such as pipes,
sockets, and anonymous inodes. The regular-file marker always has an absolute
target. The scan compares the exact device and inode for every absolute target.
It stops scanning a process after a match. Handle revalidation after a process
identity or process-group snapshot reads the observed PID's NUL-delimited
`/proc/<pid>/cmdline` records directly. It also limits the procfs environment
and descriptor checks to that PID. This exact-PID path does not repeat the
host-wide `pgrep` scan. Full refreshes enumerate all PIDs to discover new or
reparented descendants.

Linux-created marker tokens can start with
`lp1.<boot-sha256>.<start-tick>.<origin-sha256>.<label>`. Bash captures the
outer gate process start tick for request, legacy, and command markers. This
process exists before it can create or pass the marker to a descendant. The
Node coordinator uses its own start tick because it holds the generation
marker. The value bounds inherited marker holders and mapped processes. The
origin hash keeps the prefix fixed in size; it does not authenticate code that
runs as the same UID.

A gate client can predate a coordinator and open its generation marker before
it forks a parallel worker. That descriptor is the launch anchor for the gap
between the last recovery scan and the worker fork. A coordinator-marker scan
keeps this older gate parent in scope. It accepts the truncated Linux process
name `agent-quality-g` for a direct script launch. For an explicit Bash launch,
it requires one complete `scripts/agent-quality-gate.sh` argv record. An
unreadable ambiguous Bash argv record fails closed for a same-UID candidate.
The scan skips a foreign UID before it reads that process's argv. The normal
UID, signal, and descriptor checks still decide whether the process holds the
marker.

A full refresh uses the token boundary only when the versioned prefix is exact
and its boot hash matches the current Linux boot. Immediately before the first
mapped command, a Linux run also records the start tick of a new helper process.
An active-command refresh uses the later of this boundary and the token
boundary. Legacy tokens, malformed provenance, an unreadable boot identity, and
tokens from a different boot retain the unbounded scan. Exact-PID revalidation
is always unbounded. Full refreshes read each candidate's start identity first.
They skip a generation whose start tick is strictly older than the effective
boundary before they read its UID or fd state. The older coordinator gate
parent above stays in scope. Equal and newer ticks stay in scope. The scan
requires the process start identity to remain equal before and after identity
and fd enumeration. Process-exit races are empty observations. A
restricted `hidepid` mount, unreadable in-scope process, or other incomplete
scan is a scan failure. When `/proc/self/fd` exists, a failed procfs scan fails
closed and never falls back to `lsof`. macOS and hosts without
`/proc/self/fd` use the witnessed `lsof` path. A host with neither scanner fails
closed while a marker exists.

Adoption preserves the incoming owner record's group and other read bits so a
legacy waiter with shared-root access can observe the barrier. The replacement
record remains writable only by its owner. It stores the real coordinator
generation in the `coordinator_token` field. It stores `coordinator-owner-v1`
in the historical `token` field. That value is outside the historical run-token
grammar, so a historical gate waits and does not attempt a coordinator drain it
cannot understand. A current gate prefers the `coordinator_token` field. Before it
discards stale owner evidence, it requires the recorded `uid=`, when present,
and the file owner to match its current UID. A current gate can wait on another
user's live owner. It retains a stale foreign owner's record and generation
evidence, then exits with status 2. The owning user or an administrator must
recover that generation. A discard creates a hard-link witness in a fresh
mode-0700 quarantine beside the record. It reads the authority fields from one
open descriptor for that witness, requires the current UID, and rejects
duplicate authority fields. The Node coordinator also retains the exact text
for later equality checks. The discard establishes either a canonical hard
link or a published condemned-run obligation before it moves the shared
pathname beside the witness. It deletes only the private names after it
verifies that they still name the witnessed inode. A path replacement is
retained and stops the gate, even when it has the same text and authority token.

The legacy owner record stores the gate's cached `uname -n` value in `host=` and
its resolved machine identity in `machine=`. The owner-quarantine namespace
records the quarantine creator in names of the form
`owner.reclaiming.quarantine.v2.<machine-source>.<machine-sha256>.<hostname-sha256>.<created-epoch>.<pid>.<nonce>`.
The PID component is a positive decimal JavaScript safe integer from 1 through
9,007,199,254,740,991. Bash and Node reject larger values before a liveness
check.
This metadata identifies the process that created or claimed the quarantine.
It does not identify the owner record inside it. A waiter accepts historical
`owner.reclaiming.quarantine.v1.<hostname-sha256>.<pid>.<nonce>` names for
recovery, but the name alone does not decide which machine created the evidence.

The waiter applies the machine verdict and lock-root locality rules before it
uses a local PID. A same-machine creator is live while its PID is live and is
reclaimable as soon as its PID is gone or is a zombie. A creator from another
machine is never checked in the local process table and is never reclaimed. An
unverified creator on a root that may be shared is also never checked or
reclaimed. An unverified creator on a proved or declared per-machine root is
reclaimable only after the unverified-machine grace period and a dead or zombie
PID. A v1 quarantine has no creation epoch, so its directory modification time
supplies the conservative age check when that check is required.

Before a waiter recovers a reclaimable quarantine, it creates an empty
mode-0700 placeholder with its own v2 creator metadata. One descriptor-bound
Node operation validates both directories and atomically renames the whole
source directory over that placeholder. It fsyncs the claimed directory and
its parent. This claim orders recovery against a creator's orphaned `mv` child
and against other waiters. A waiter that loses the source-name race removes
only its empty placeholder, restarts the quarantine scan, and observes the
winner's new name before it examines ordinary remnants. A crash after the
directory claim leaves the same versioned evidence for the next waiter.

The Bash legacy path uses atomic pathname operations when it publishes initial
quarantine and condemned-run state. It does not fsync those initial files or
directories. The descriptor-bound Node helper that later claims a dead
quarantine fsyncs the claimed directory and its parent. That partial order does
not give the complete Bash protocol sudden-power-loss durability. Its recovery
guarantee covers process and signal crashes while the mounted filesystem remains
available. The coordinator journal and other Node state use the separate fsync
order documented below.

Adoption does not change permissions on an explicit shared legacy lock root.
The private state namespace includes the numeric UID, so a later user of that
root does not inherit another user's mode-0700 state directory.

A coordinator-disabled gate cannot read or acknowledge coordinator drain
records through the socket. On Linux, the coordinator closes its socket after
the idle period without releasing `run.lock` when every remaining request is
terminal-pending, every lease has a portable drain obligation, and no live
client, waiter, drain claim, or result handoff remains. A current
coordinator-disabled gate can then reclaim the same-UID dead coordinator owner.
It records the coordinator generation under `condemned.d/`. It drains workers
through the shared generation marker and an exact anchored process group.

Darwin keeps the coordinator socket live while a Darwin drain obligation
remains. A normal coordinator-enabled successor joins the socket and settles
each persisted per-command lineage. A coordinator-disabled or historical gate
waits behind the retained owner. If the Darwin coordinator process or socket is
lost, the typed owner record remains. Its aggregate marker cannot authorize a
Darwin signal, so recovery fails closed until a journal-aware recovery path is
available. A queued, granted, result-ready, claimed, or non-portable obligation
prevents the Linux handoff.

The coordinator publishes mutable request, lease, and drain state through
same-directory temporary files and atomic rename. It creates terminal results
as immutable files under
`results/<fingerprintHash>/<executionId>.json`. The journal records the request
drain identity, each lease's command drain identity, gate owner PID and start
identity, request capability digest, worktree, capacity weight, and named
resources before it releases any resource. Raw
capabilities do not enter status, command arguments, the journal, result files,
or coordinator logs. Workers and mapped wrappers carry command and request
tags. Workers retain open command, request, and coordinator generation marker
descriptors. A successor coordinator restores uncertain
leases as drain obligations and keeps their resources reserved. A joining Bash
gate enumerates every stale request and handles the requests in sequence. For
each request, it persists and drains every lease command identity, then drains
the request identity. It confirms all discovered worker
and descendant PID/start identities are gone before it acknowledges any lease
obligation. Only then can the coordinator reuse capacity, a named resource,
the worktree lease, or the legacy lock. Recovery cancels uncertain work. It
does not requeue it or promote it to success.

For a new result hash directory, the writer fsyncs the `results/` parent before
publication. It fsyncs the staging file, creates the final hard link, fsyncs the
hash directory, removes the staging link, and fsyncs the hash directory again.
It writes the result-ready journal transition only after this sequence.
Recovery validates retained results and fsyncs their hash directories and the
`results/` parent before it writes a recovery journal transition.

An existing immutable result is accepted only when its schema, protocol,
policy, fingerprint, execution, leader, unique ordered followers, status,
bounded payload, and canonical UTC completion time are valid. A matching record
keeps its persisted completion time. Retained-success reuse also requires the
journal index and immutable result to name the same execution and completion
time. Any semantic conflict stops startup or result publication and leaves the
last durable journal authoritative.
Publication checks legacy authority before the immutable result write,
immediately after the write, and before the journal commit. Authority loss
after the final link appears moves that link to its writer-generated staging
name and fsyncs the result directory. Startup ignores the staged link.

One recovery process claims all current drain obligations for the same request.
The claim and release operations cover every sibling lease obligation even
though each lease has a different command drain identity. A different process
identity cannot acknowledge one of those obligations while the request claim
is live. Each acknowledgement must use that obligation's command identity, the
same claimant, and `processTreeEmpty=true` evidence. Recovery drains the shared
request identity before it sends any acknowledgement.

Legacy release is token- and inode-scoped. It first snapshots the owner through
an open descriptor, then atomically moves the current owner pathname to a
recovery-visible `owner.reclaiming.release.*` record inside `run.lock`. It keeps
the original descriptor open across both owner moves: first to the
recovery-visible record, then to the private release directory. The release
parser duplicates that descriptor and reads the duplicate. It validates the
descriptor target as a current-UID regular file before and after that read.
Linux exposes `/dev/fd/<n>` as a symlink, so the parser does not send that
pseudo-path through the shared-path no-symlink guard. After the first move,
release validates the moved inode, current UID, and generation token against the
prior snapshot. Only then does it move that inode into a mode-0700 private
release directory.
A replacement that wins before the move is detected and restored or retained.
It cannot enter private release state. The Node coordinator also requires the
exact record text. A crash before validation leaves the record where legacy
hidden-record recovery can restore a live successor. Recovery applies the
machine verdict and lock-root locality rules before it reads a PID from the
local process table.
If it cannot link a live remnant back and no canonical owner exists, it retains
the remnant and stops the gate. After validation, release removes only
current-UID regular files with the unpublished
`owner.claiming.<positive-pid>`,
`owner.coordinator.<positive-pid>`, or `owner.rollback.<positive-pid>` name. An
interrupted claim or handoff can leave these files in the directory. Release
removes one only after the publishing PID is gone or is a zombie. A live stage,
a successor owner, or any other entry makes `rmdir` fail. The successor remains
in place. Without one, release restores the moved owner before shutdown reports
`release-failed` to every close waiter. Release never recursively removes the
lock directory. A failed `rmdir` restores only the witnessed private owner.
Normal cleanup and successor settlement also quarantine that exact private
inode before deletion. A same-text replacement remains in the private release
directory and makes release fail closed. The `EXIT` trap changes an otherwise
successful gate status to 2 when exact lock release fails. It preserves an
earlier non-zero gate status. A crash after `rmdir` can leave the private owner
and old holder marker outside the authority path. No recovery scan removes
those top-level paths. They remain inert and do not block the next gate.

The legacy lock uses `mkdir(2)`, `link(2)`, and `rename(2)` because macOS has no
`flock(1)` and the repo's floor is Bash 3.2. `mkdir` creates the lock and private
quarantines. `link` publishes a complete owner record, refuses an occupied
path, and creates the exact-inode witness. A file `rename` takes one owner
pathname away atomically. A quarantine-directory `rename` claims one dead
private recovery state by replacing a verified empty placeholder. The
implementation does not use `mv src dir` as a conditional directory claim;
that command moves `src` inside an existing directory.

The current-run handles live in `scripts/gate/run-handles.sh`. The gate sources
that module from its own `$script_source_dir` before it changes directory, and
fails closed if the path is missing, unreadable, a symlink, or not a regular
file. The module provides run-token validation and pattern helpers, owns the
marker-path state and test-ready barrier, and provides tagged-process
discovery. Its path is included in `implementation_signature()`
and changes to it route the gate self-test. The ready/release barrier uses the
paired `AGENT_QUALITY_GATE_LOCK_TEST_READY_FILE` and
`AGENT_QUALITY_GATE_LOCK_TEST_RELEASE_FILE` paths. It requires `NODE_ENV=test`,
and normal runs do not enter it.

The invariant the lock keeps is: **at every instant at most one process
believes it holds it, and no waiter ever removes or renames another run's
lock.** Three rules carry that. A holder is made in two atomic steps — win
`mkdir` on the lock path, then build the record in a private file and `link`
it into place — so a creator descheduled between them finds its publish
refused and queues instead of running beside whoever took over. Publishing
whole is what keeps that check honest: a reader never sees a half-written
record, and a record that _is_ half-written could only have come from a run
killed mid-write, which is why the `token` field is written last and a record
without one counts as no record at all — reclaimable after the grace, PID
field and all, because nothing in an unfinished record can be trusted. A
waiter that judges a lock stale takes
that record away by rename before it may write its own, and exactly one waiter
can win a given record because the source vanishes with the rename; it then
**re-reads what it took and proceeds only if it is still the identity it
judged**, because a verdict formed before winning is worthless. A record taken
by mistake goes back through `ln`, which refuses an occupied path, so a record
written in the meantime is never clobbered. Nothing renames or deletes a lock
directory except the run that owns it.

Liveness is an identity check, not a PID check. `kill -0` succeeds on whatever
inherited a dead holder's PID, and a recycled PID would make every later run
wait on an unrelated process until `--lock-wait` expired — the opposite of
unattended recovery. A legacy Bash holder record stores the kernel's own
start-time string (`ps -o lstart=`). Comparisons trim only leading and trailing
blank padding because older macOS gates persisted the padding that `ps` emits.
Internal spacing remains exact. The same PID and normalized start string mean
the holder. A different start string means the PID was reused and the lock is
stale. Where no start time is available on either side — a sandbox without
`ps` or a lock written by an older gate — this falls back to PID existence,
which errs toward waiting rather than evicting.

Owner and captured-process publishers retain the historical padded
`ps -o lstart=` wire value. Gates that predate normalization compare that value
byte-for-byte. Current gates normalize it only when they compare identities.
This keeps the record readable in both rollout directions. A historical reader
still uses calendar-resolution identity and retains its same-second PID-reuse
limit. Current readers require the exact runtime metadata described below.

Live drain checks use the host lifecycle contract. Linux reads the kernel start
tick from `/proc/<pid>/stat` for group anchors, parent-child relations,
candidates, and the final pre-signal check. The append-only portable capture
keeps each legacy `pid|lstart` line and follows it with
`runtime-v2|pid|start`. An old reader skips the metadata line because its first
field is not a PID. A current Linux reader requires the exact runtime generation
before it signals. A legacy-only Linux capture stays unverified unless a fresh
exact handle or pinned relation reauthorizes the process.

Darwin does not use the portable numeric signal path. Its helper records the
boot identity, `p_uniqueid`, `p_puniqueid`, PID version, and audit token. The
lineage record persists every classification and tombstone. Signals use
`proc_signal_with_audittoken`, so PID reuse cannot redirect them. A missing API,
identity, baseline, state file, or supported host classification stops the
command or retains the scheduler barrier.

A coordinator legacy record intentionally writes a blank `start_utc=` and the
real identity in `coordinator_start_utc=`. Older Bash readers fetch fields in
separate snapshots. The blank legacy field makes every mixed old/new snapshot
fall back to PID liveness instead of comparing unrelated values. New
coordinators read `coordinator_start_utc` from one file snapshot and can compare
the exact process identity.

An old-policy coordinator owner has no safe per-command Darwin lineage under
the new policy. Recovery recognizes it only when one stable record has the exact
coordinator token, exact coordinator start identity, and the literal
`coordinator-owner-v1` owner token. Darwin then rejects owner-record-only
recovery. An untagged descendant can close the aggregate generation marker
descriptor, so an empty marker cannot authorize the new coordinator. The gate
retains the owner evidence. This also blocks a dead same-policy coordinator
when its socket cannot be joined and recovery falls back to the legacy owner
record. Portable hosts retain `portable-marker-v1`. Their recovery stops
surviving marker holders before it releases the aggregate generation barrier.

The current Bash gate and coordinator read process start time and process status
from one `ps` snapshot. A different start time means PID reuse. A matching
status that starts with `Z` means the owner is a zombie and is stale. A matching
non-zombie status means the owner is live. If the snapshot is unavailable, the
gate keeps the existing fail-closed process-existence fallback.

**An identity that cannot be read is not an identity that matches**, and which
way "cannot read" should fall depends on what the answer authorises. Three
places ask whether a PID is still the process that recorded itself — the wait
loop's verdict, the re-read after a reclaim wins a record, and remnant
evaluation — and for all three the conservative answer is _live_, because it
means leave the lock alone. The drain asks the opposite question: not "may I
leave this alone" but "may I kill this". There an unreadable identity must mean
**never signal**, or an entry recorded without one would authorise killing
whatever inherited its PID. So the drain signals only when the recorded and
current identities are both present and equal; an entry it cannot verify is
skipped, named, and still counts as outstanding, so the drain keeps waiting on
it and fails closed at the bound rather than calling the run clear. That trade
is deliberate — an orphan whose identity read keeps failing is never killed and
holds the gate at exit 2 instead, because a run that refuses to start is
recoverable and a stranger's killed process is not. A capture drops entries
whose identity read came back empty, since the process was already gone. The
portable legacy and Linux compatibility path records `<no-identity-source>` on
a host with no identity source. That path can still signal on PID alone because
nothing better exists there. Darwin never enters that numeric fallback.

**Which machine wrote the record is decided by a machine identity, not by the
hostname** (GitHub issue #2055). Those liveness rules only mean anything about
a record written on _this_ machine: another machine's PIDs say nothing here, so
a record from one is waited out rather than judged. The gate used to answer
"which machine" with `uname -n`, and a rename broke it — the record still named
`Workbook.local`, the machine now answered to `Mac`, every run read its own
dead holder as a live foreign one, and the dead-PID reclaim below that branch
was never reached. Every session on the machine then burned its whole
`--lock-wait` and none of them could heal it; a human had to delete the owner
file. So the record now also carries `machine=<source>:<id>`, resolved once per
run from `/etc/machine-id`, `ioreg`'s `IOPlatformUUID`, or `sysctl kern.uuid` —
whichever answers first, in that order — and overridable with
`AGENT_QUALITY_GATE_LOCK_MACHINE_ID`. The source tag is load-bearing: two ids
from the same source are comparable machine identities, and two from
_different_ sources are not, because a run that reached `ioreg` and a run that
fell back to `kern.uuid` are almost certainly one machine and reading their
unequal values as two would reinvent the wedge.

**Where the lock root lives decides what a local reading is allowed to
conclude**, and the root is asked two questions from two kinds of evidence.

_Is the storage under it this machine's own?_ The filesystem answers that, for
every root — the one an operator named as much as the one the gate resolved for
itself — because the question is about the storage and not about who chose the
path. `df -l` lists local filesystems and omits network ones — NFS, SMB, AFS,
an autofs map — on both the BSD and GNU implementations, and the row it prints
for a path, not its exit status, is the answer. Every failure to answer means
"may be shared": no `df`, an unreadable path, an implementation without `-l`.
That direction is the one that keeps waiting.

_Is the root established as this machine's alone?_ That is strictly stronger,
and only the unverified-record rule below needs it. The default candidates —
`$HOME/.cache/agent-quality-gate`, then `$TMPDIR/agent-quality-gate-<uid>` —
are nobody's deliberate coordination point, so local storage settles it there.
`AGENT_QUALITY_GATE_LOCK_DIR` is the opposite case. `resolve_gate_lock_root`
treats it as a coordination contract precisely because it can name a directory
more than one machine reaches, and a local mount is no evidence against that —
a machine can export its own disk. So an override is possibly-shared until its
owner says otherwise, and the unverified-record reclaim is refused there.
`AGENT_QUALITY_GATE_LOCK_DIR_IS_PER_MACHINE` is that declaration, and it
answers both questions: `1` where a directory is this machine's alone, `0`
where even a default root is exported to other machines.

The verdict then has three values. **Same machine** — matching identities, or
no identity on one side and a matching hostname — runs the liveness rules
unchanged, so a dead holder is reclaimed at once whatever the record calls the
host. **Another machine** — two identities from one source that disagree, on a
root that may be shared — is definitive and nothing local may overturn it, so
that record is waited out however old it gets and the expiry names its holder.
**Unverified** covers everything else: no machine field (a record from a gate
that predates it), a source mismatch, or a disagreeing identity on local
storage.

That last case is deliberate. A machine identity is not immutable —
`/etc/machine-id` is regenerated by an OS reinstall or an image rebuild, and
the override can simply be changed — so on storage the machine mounts itself, a
disagreeing identity is far likelier to be this machine's identity having
moved, exactly as a rename moved its hostname, than a second machine writing
into the same directory. Reading it as another machine would leave the record
unreclaimable forever, which is the wedge this whole rule exists to remove.

**The converse does not hold**, and the asymmetry matters: a disagreeing id is
proof of two machines, but an agreeing one is not proof of one, because ids are
not guaranteed unique. Containers built from a single base image famously carry
the same baked-in `/etc/machine-id`, so two of them mounting one lock directory
agree on their identity while having separate PID namespaces — where a local
`kill -0` on the other's holder reads "gone". So off proven-local storage the
hostname has to agree as well; where it does not, the pair counts as unverified
and nothing is reclaimed. On storage the machine mounts itself no second
machine is writing records at all, and the hostname is the field the rename
moved, so requiring it there would refuse the case this exists to fix.

An unverified record is reclaimed only on local storage, and only with a dead
PID and an age past
`AGENT_QUALITY_GATE_LOCK_UNVERIFIED_MACHINE_GRACE_SECONDS` (600 by default).
The grace bounds the exposure in the one configuration the probe cannot see —
an exported lock root — because a holder there would have to be idle past it to
be touched, and the declaration turns the branch off outright. On a root that
may be shared it never reclaims at all. Either outcome is said on stderr: the
reclaim names what it concluded and from what, and the refusal names the
declaration that would change it.

**An identity is validated, never rewritten.** The id must already be 1-128
characters of `A-Za-z0-9._-`; anything else is refused, with no trimming,
stripping, or truncation ahead of the check. Every such normalisation is a
many-to-one map, and a many-to-one map on an identity is how two machines come
to compare equal: stripping the unrepresentable character in `machine/a`, or
deleting the line break in `machine<LF>a`, both yield `machinea`, which may be
another machine's legitimate id. A refused probe source costs an identity
nobody can compare, which is the conservative state; a refused
`AGENT_QUALITY_GATE_LOCK_MACHINE_ID` stops the run, because the operator set it
to name a machine and running under a different one is the failure being
avoided.

The field is additive in both directions: an older gate on the same machine
ignores it and reads the record exactly as it always did, and this gate reads
that older gate's record through the unverified path. Once both gates on a
shared root write identities, that path is unreachable there.

**Off storage the machine mounts itself, nothing is reclaimed at all** (GitHub
issue #2061). Every rule above answers "was this record written here?" from the
record's own machine identity and hostname, and both of those fields can be
cloned. Two containers built from one image carry the same `/etc/machine-id`
_and_ the same hostname; on a lock root they share, each reads the other's
record as its own, finds the holder's PID absent from its own PID namespace,
and authorises the overlap the lock exists to prevent. Every field the
comparison could use is self-reported, and a PID lookup only answers about this
kernel, so nothing available locally separates that case from a machine that
renamed itself.

So the locality of the root is the last word on every reclaim, not only on the
unverified one. Where `df -l` cannot show the root as local storage and no
declaration says otherwise, a record that looks reclaimable is left where it is
and the run waits out its `--lock-wait` budget. The refusal says so on stderr:
the root is not established as this machine's, self-healing is off there, and
each machine should be given its own `AGENT_QUALITY_GATE_LOCK_DIR` on its own
local storage.

It refuses the reclaim, not the lock. Taking the lock on a shared root is still
sound — a waiter queueing behind a live holder is what the lock is for — and
failing acquisition outright would turn a working configuration into a hard
error over a hazard that only bites when a holder dies. The one operation that
acts on local evidence about a process elsewhere is the one that stops.

That covers the record with no holder at all. "No complete record here" is as
local a reading as a PID lookup: a network client caches directory attributes,
so a freshly written owner file can stay invisible to another client for longer
than the `AGENT_QUALITY_GATE_LOCK_OWNER_GRACE_SECONDS` that would otherwise
authorise taking the lock away.

A remnant left by an interrupted reclaim is left alone there too, rather than
deleted. `gate_lock_recover_hidden_record` classifies remnants by the same local
PID lookup, so off local storage it cannot call one dead; deleting it would
destroy the only copy of a possibly-live holder's record and leave the lock
ownerless, which is precisely the state such a root can no longer reclaim. A
remnant naming a locally-live holder is still linked back to the canonical
path — that direction only restores evidence.

The refusal also owns the wait's ending. A run that timed out on a record it
refused is told that nothing was reclaimed, which state it refused, and that the
lock may need removing by hand — instead of the usual "holder is still alive;
let it finish", which would send an operator to wait on a process this run
already read as gone. That diagnosis is decided per pass, not once per
acquisition: a creator that stalls past the owner grace is refused and then
publishes a live record, and the timeout has to name that live holder rather
than advise removing a lock somebody is holding. It names the lock's state
rather than its holder, because the states it covers include a lock with no
holder recorded at all.

The cost is that a lock root on network storage no longer self-heals — a holder
killed there wedges the root until a human removes the record — and that is the
trade this repo already assumes. One lock root per machine is the documented
model: concurrent validation from another machine runs against its own checkout
and its own lock. An operator who really does share a root, and has satisfied
themselves that no second machine writes into it, restores self-healing with
`AGENT_QUALITY_GATE_LOCK_DIR_IS_PER_MACHINE=1`.

**`df -l` narrows the hazard; it does not prove exclusivity.** It answers
whether the storage is mounted _from_ elsewhere, not whether anything else
reaches it. A machine that exports its own disk sees that disk locally, and a
host bind mount or Docker volume reads local inside every container sharing it —
so cloned identities in two containers on one host still compare equal on a root
both read as local. Nothing readable from a single machine detects either case;
that is the premise issue #2061 starts from. What changed is the remedy: before
this, `AGENT_QUALITY_GATE_LOCK_DIR_IS_PER_MACHINE=0` only turned off the
unverified-record reclaim, and a cloned identity under a cloned hostname was
reclaimed anyway. It now refuses every reclaim on that root, so an operator who
deliberately shares one has a declaration that actually holds.

**An operator-supplied directory on local storage keeps self-healing.** The
refusal turns on the storage, never on who named the path. Refusing on every
`AGENT_QUALITY_GATE_LOCK_DIR` would take the dead-holder reclaim away from
ordinary single-machine use of the override — a worktree pointing runs at a
shared cache directory, a CI job placing the lock somewhere writable — and
that is the wedge class issue #2055 removed.

A killed holder cannot release its own lock, so recovery is explicit rather
than time-based. A successor that finds the recorded coordinator or legacy gate
gone takes the record away and claims it. `kill -9` therefore costs the next
request a recovery drain, never manual cleanup. The temp path a reclaim renames
into is registered with the exit trap **before** the rename creates it. Cleanup
restores rather than deletes, so an interrupted reclaim puts the record back
exactly as it found it.

**That guarantee is local-storage-only**, and so is every row of the table
below. It has to be: each of those recoveries is a reclaim, and a reclaim rests
on evidence read through this kernel and this client. Where the root is not
established as storage only this machine reaches, the gate refuses every one of
them, so a crash there does not self-heal: the record or remnant stays, and each
waiter burns its whole `--lock-wait` budget and exits. A shared root fails
closed by design; the supported self-healing model is one lock root per machine.
Read the rows below as "on a root this machine's own", and issue #2061 above for
the rest.

**Clearing such a lock by hand is the one operation that can break mutual
exclusion**, so it is not a delete. The gate refused the record precisely
because it could not tell a dead holder from a live one, and removing a live
holder's record lets the next waiter publish its own beside work that is still
running — the overlap this lock exists to prevent. Establish first, on the
machine that wrote the record, that its `pid` is gone and that its mapped
commands are gone with it: the holder is named by `pid` and `host`, and its
commands carry the tag `agentqg:<token>` from the record's `token` field. That
token is the reason this is not a plain delete — a gate shell's mapped commands
outlive it, and the record is the only thing naming them until some run condemns
it, so removing the record while they run discards the handle as well as the
exclusion.

The obligations already written for a run are a separate matter, and they are
not at risk from removing the record: `<root>/condemned.d` and
`<root>/captured.<token>` sit beside the lock rather than inside it, exactly so
they outlive the reclaim, and `drain_condemned_runs` finds them by scanning that
directory rather than by following any record. They are the durable evidence, so
the hazard runs the other way — clear one only after its processes are confirmed
gone, and never as part of tidying up the lock.

When the holder cannot be reached to be checked, the record stays: waiting costs
a wait, and guessing costs the guarantee.

#### Crash points

A signal can land between any two filesystem operations above, and a `kill -9`
skips the exit trap. This table covers the published-state boundaries that cross
coordinator startup, scheduling, drain, and legacy ownership. The detailed
rules below cover the legacy Bash recovery loops. Safe means: at most one
process believes it holds the lock, no record naming a live holder is invisible
to the next reader, and no stale command can make a later run exceed capacity or
cross a named-resource boundary. On local storage, safe also means that no state
requires manual cleanup. The three process-safety guarantees hold on any root.
Off local storage, the local-storage qualification above withdraws automatic
cleanup: mutual exclusion stays safe because the gate leaves uncertain evidence
for a human to inspect.

| Crash lands                                                                       | State left behind                                                                                                       | Next run                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| before `mkdir run.lock`                                                           | nothing                                                                                                                 | takes the lock normally                                                                                                                                                                                                              |
| after `mkdir`, before the record is staged                                        | lock directory, no record                                                                                               | no complete record, so after the grace it publishes its own                                                                                                                                                                          |
| after staging, before Darwin state preparation                                    | `owner.claiming.<pid>` only                                                                                             | same as above; the staged file is private and inert, and a validated release removes it before `rmdir`                                                                                                                               |
| after Darwin state preparation, before `link`                                     | `owner.claiming.<pid>` plus an exact unbound owner lineage                                                              | no owner was published and no mapped work can exist; normal cleanup publishes verified unbound abandonment, while a crash leaves inert token-scoped state                                                                            |
| after `link`, before the staged copy is unlinked                                  | complete record, exact owner lineage, and an inert `owner.claiming.<pid>`                                               | reads the record and uses its typed lineage if the holder is gone; validated release removes the unpublished stage                                                                                                                   |
| after the not-ready socket binds, before legacy adoption                          | bound socket rejects `COORDINATOR_STARTING`; the prior legacy owner is unchanged                                        | clients retry; a failed startup removes the socket and preserves or restores the prior owner                                                                                                                                         |
| after legacy adoption, before ready metadata and handler activation               | coordinator owns the versioned legacy record; the bound socket still rejects requests                                   | a handled error rolls back the owner; after a crash, a current same-UID gate reclaims the dead coordinator identity and requires the exact generation marker to become empty; a historical or foreign-UID gate waits or fails closed |
| after a request or lease record is published, before its acknowledgement          | durable queued request or reserved resource with no client acknowledgement                                              | a successor drops queued command leases because their wait connections ended; it converts each granted lease to a drain obligation                                                                                                   |
| after the initial Darwin baseline, before a lease grant                           | an unbound lineage record and no scheduler obligation                                                                   | no mapped work exists; the record is inert and a later same-token command must validate or replace it before `START`                                                                                                                 |
| after a Darwin lease grant, before the baseline refresh                           | a typed reserved lease plus the initial fail-closed lineage record                                                      | a successor converts the lease to a Darwin drain obligation; missing or stale evidence cannot release the reservation                                                                                                                |
| after the Darwin baseline refresh, before wrapper bind or `START`                 | a typed lease and a fresh unbound record; no mapped code has started                                                    | normal abandonment removes the unstarted lease, then publishes `verified-unbound-abandonment` without a census or signal; a legacy owner retains the proof, while other modes discard it after their authority ends                  |
| after a parallel worker forks, before its command lease exists                    | the request record and a worker that holds request and generation handles; before launch release, no mapped work exists | the worker exits if its exact parent dies behind the launch barrier; after launch release, it cancels a queued wait when that parent dies and accepts no recovery ownership without a matching persisted granted-lease record        |
| while a worker runs mapped commands                                               | durable lease, lifecycle contract, and mapped-command identity; the command can outlive its gate client or coordinator  | Linux recovery also uses the validated worker group; Darwin recovery uses the persisted unique lineage while the out-of-lineage sentinel exits after its exact parent dies                                                           |
| after a sequential wrapper exits while its descendant still holds a run handle    | the command lease and token-scoped marker still identify that descendant                                                | the same gate persists and drains the descendant before lease release; a crash leaves the lease or legacy obligation for the next gate                                                                                               |
| after a legacy sequential command settles, before the next command                | the legacy owner plus one durable settled lineage state under the owner token                                           | stale recovery consumes that proof; the same owner validates and rearms it with a fresh unbound baseline before another `START`                                                                                                      |
| after a parallel wrapper exits while a detached descendant holds its handles      | the lease, command-specific handles, and request-wide handles remain; the descendant can be outside the worker PGID     | the exact command drain finds the detached process while it captures the anchored group; a client crash leaves request-wide recovery for the coordinator or its successor                                                            |
| after a parallel result is published, before the parent captures the group        | the lease, atomic result, and descendant-held command and request handles; Linux also has a live worker group anchor    | the active parent drains and reaps the worker; a Linux successor derives the group only from the validated live identity, while a Darwin successor drains the exact lineage and the sentinel exits with its parent                   |
| while a worker runs, with its watchdog descheduled or suspended                   | same, and the watchdog might not clean up on its own                                                                    | recovery scans processes instead of waiting for the watchdog, so a watchdog that never runs changes nothing                                                                                                                          |
| after the last lease is released, before terminal-result publication              | active request with no lease and no terminal result                                                                     | the leader retries publication; if it dies, recovery publishes cancellation and never infers success                                                                                                                                 |
| after a terminal staging file is fsynced, before its final link                   | old journal plus one exact staging file                                                                                 | startup ignores the staging file; retention removes it only after the strict two-hour bound                                                                                                                                          |
| after the final result link, before its first directory fsync                     | old journal plus the final and staging links                                                                            | startup validates and fsyncs the result path before it reconstructs and commits result-ready state                                                                                                                                   |
| after the first result-directory fsync, before staging unlink                     | old journal plus one durable final result and its staging link                                                          | startup validates the final result; the staging link remains inert until strict retention removes it                                                                                                                                 |
| after immutable result creation, before journal cleanup                           | exact terminal result plus its active execution; the old journal can retain its last drain lease and obligation         | a successor removes only that execution's stale leases and obligations, reconstructs result-ready state, and returns the exact result                                                                                                |
| after result-ready state commits, before a client's acknowledgement               | that client's terminal request still holds its worktree admission                                                       | the client reconnects and acknowledges; a bound disconnect auto-acknowledges now or after any persisted drain reaches terminal state                                                                                                 |
| after expired success-index removal commits, before result unlink                 | unindexed, valid expired result                                                                                         | startup accepts the orphaned result and the next prune removes it                                                                                                                                                                    |
| after a state-namespace writer creates a staging file, before publication         | one exact staging path listed above                                                                                     | after legacy adoption and required index commits, maintenance removes it only when it is a current-UID regular non-symlink file more than two hours old                                                                              |
| while the empty-namespace deletion marker is published                            | `.deleting-v1.staging` alone, or the staging and marker links                                                           | stage-only recovery cancels marker creation; marker-plus-stage recovery fsyncs the marker before it removes protected entries                                                                                                        |
| after empty-namespace deletion starts                                             | a valid deletion marker and a subset of the three protected namespace entries                                           | startup validates the marker, removes only empty or owned protected entries, and completes the parent-directory fsync                                                                                                                |
| after a request-scoped drain claim, before acknowledgement                        | all sibling lease obligations for that request name one claimant; their leases remain reserved                          | only that identity can acknowledge them; a successor releases the claim only after it verifies the claimant is dead or reused                                                                                                        |
| after Darwin settlement records an empty coherent exact set, before lease release | a typed settling lease and a durable fence/count proof with its state revision                                          | the global grant barrier remains; the same client or a successor validates the proof and releases the exact obligation without another census                                                                                        |
| after a Darwin lease or legacy obligation is released, before state discard       | no scheduler or legacy obligation and one settled lineage record                                                        | the record is inert and grants no authority; a later cleanup validates its settlement evidence before deletion                                                                                                                       |
| after legacy `run.lock` removal, before owner-lineage retirement                  | no legacy owner and one exact unbound or settled owner lineage                                                          | the record is inert and grants no authority; retirement accepts only verified unbound state or durable settlement                                                                                                                    |
| after a Darwin transition plan links, before payload readiness                    | one fsynced plan and an exact hard link to the expected-state inode                                                     | a live writer or successor validates the full plan and claimed inode, then creates the one exact payload; a foreign or different plan fails closed                                                                                   |
| after a Darwin transition becomes ready, before state publication                 | the plan, claimed expected-state inode, fsynced payload, and ready hard link                                            | one writer consumes the payload through atomic rename; every helper accepts only the same operation, expected state, target, and adjacent revision                                                                                   |
| after a Darwin state publishes, before transition cleanup                         | the exact next revision plus redundant plan, current, and ready links                                                   | recovery validates the published target, then removes only the matching transition links; a late stale writer can link only the newer canonical inode and cannot republish the old revision                                          |
| after a Darwin discard tombstone publishes, before state removal                  | one validated terminal tombstone and any exact transition links                                                         | recovery reconstructs and completes the exact discard plan, validates the tombstone again, and removes only that canonical inode                                                                                                     |
| after a quarantine creates `anchor`, before it records a fallback                 | shared owner or remnant plus one private hard-link witness                                                              | a dead-creator recovery requires a second visible link, removes only the witness, and leaves the shared evidence intact                                                                                                              |
| after a quarantine records its fallback, before it moves the shared pathname      | shared owner or remnant plus a private witness and fallback marker                                                      | the fallback proves a canonical link or condemned-run obligation exists; recovery can remove only the witnessed private evidence                                                                                                     |
| after the shared pathname moves to the quarantine `record`                        | a replacement can occupy the shared path; the exact old inode remains as `anchor` and `record`                          | recovery verifies both private links name one current-UID inode; it retains any replacement and removes only the private links                                                                                                       |
| while a waiter claims a reclaimable quarantine                                    | either the old quarantine name or the same directory under the waiter's versioned name                                  | one whole-directory rename wins; source `ENOENT` during open, revalidation, or rename makes the loser remove its empty placeholder and rescan the winner                                                                             |
| after a waiter claims a quarantine, before it recovers a phase                    | one v2 quarantine whose machine source and hash, hostname hash, creation epoch, PID, and nonce name the claimant        | a concurrent waiter applies the machine and locality verdict to that claimant; if it becomes reclaimable, the next waiter claims and recovers the same directory                                                                     |
| after judging a taken record stale, before the new record is published            | no canonical owner and the prior same-UID token under `condemned.d/`; exact old owner evidence can remain private       | drains that token before mapped work, then publishes its own owner; a failed or changed discard retains evidence and stops instead                                                                                                   |
| after a taken record is judged live, before it is put back                        | no canonical owner, an exact hard-link witness, and the recovery-visible remnant                                        | publishes the witnessed inode with an exclusive hard link; an occupied canonical path wins, and the old evidence remains until it has a published fallback                                                                           |
| after `mv owner → owner.reclaiming.release.*`, before token validation            | ownerless lock, one recovery-visible release remnant, and the old marker                                                | restores a locally live successor; retains another-machine or unverified shared-root evidence; a spent reclaimable identity becomes a drain obligation before removal                                                                |
| after validation and `mv remnant → <private-release>/owner`, before `rmdir`       | ownerless lock, an exact private owner snapshot, the open old marker, and possible unpublished owner stages             | release removes only known dead-publisher stages; a successor owner makes `rmdir` fail; restore and cleanup operate through exact hard-link witnesses                                                                                |
| after `rmdir run.lock`, before private owner and marker cleanup                   | no lock; the exact private owner witness and old holder marker remain outside the authority path                        | the next gate takes the lock normally; no recovery scan removes these top-level paths, so they remain inert and grant no authority                                                                                                   |
| after exclusive coordinator marker creation, before snapshot publication          | one current-user, token-specific marker inode held by an open coordinator descriptor                                    | the crash closes the descriptor and runs no cleanup; the marker stays inert because the next coordinator uses a different generation token                                                                                           |
| after a coordinator marker cleanup witness, before its private take               | the exact marker has a private hard link; its shared path can receive a replacement                                     | the crash deletes nothing; the top-level holder quarantine is inert, the cleanup has not changed the shared path, and any replacement is retained                                                                                    |
| after a coordinator marker moves into its holder quarantine                       | the quarantine contains the exact witness and moved current pathname; the shared path can be absent or replaced         | the crash deletes nothing; the top-level holder quarantine is inert and unscanned, and any moved or later replacement is retained                                                                                                    |
| after a Bash marker cleanup witness, before its private take                      | the cleanup-time marker inode has a private hard link and still occupies the shared path                                | the crash deletes nothing; the top-level holder quarantine remains inert, and a later same-token drain can remove the canonical marker after an empty census                                                                         |
| after a Bash marker pathname moves into its holder quarantine                     | the quarantine retains the witnessed inode and moved current pathname; the shared path can be absent or replaced        | the crash runs no restoration; any safe or unsafe moved replacement remains private, any later shared replacement remains visible, and the holder quarantine never blocks the next gate                                              |
| after a validated `lsof` marker witness, before scan cleanup                      | a mode-0700 `.holder-lsof-witness.v1.*` directory contains one scan-time exact raw-marker hard link                     | the crash leaves an inert private link; no recovery scanner consumes it, it grants no authority, and it does not block a later gate                                                                                                  |
| after noting a condemned run, before publishing the replacement                   | the obligation names a run whose record is still in place                                                               | reclaims that record again and notes the same token twice; draining a token whose processes are gone is a no-op                                                                                                                      |
| after publishing a replacement, before draining what it condemned                 | the obligation names a run nobody is clearing                                                                           | inherits the whole directory, not just the holder it reclaimed, so a chain of crashes loses nothing                                                                                                                                  |
| after capturing a dead run's process tree, before the first signal                | the captured set is on disk, nothing has been signalled yet                                                             | re-reads it, unions it with its own tag scan, and confirms every entry — a set naming already-dead PIDs costs identity-checked no-op checks                                                                                          |
| mid-drain, after the TERM pass has killed the tag carrier                         | no tagged process remains, but an untagged descendant may still run                                                     | inherits the persisted captured set, so it looks for those PIDs rather than for a tag nobody carries any more                                                                                                                        |

#### Where evidence is destroyed

The crash-point table above asks what a crash leaves behind. This table covers
each class of operation in the legacy lock or durable coordinator namespace
that destroys or consumes ownership, admission, reservation, recovery,
singleflight, request, or result evidence. It states why the obligation derived
from that evidence is already durable, or why no obligation can exist. Rows
group call sites that use the same guard and durability order. Transient socket
and ready files and diagnostic log rotation are outside this scope because they
grant no execution authority and carry no recovery obligation.

| Destruction                                                             | What derived from it                               | Why it is safe before the delete                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| remnant deleted after a successful `ln` restore                         | the record itself                                  | a canonical hard link preserves the exact inode; a private witness binds that inode before the shared remnant moves, and only the private links are deleted                                                                                                                        |
| remnant deleted because its holder is verified dead                     | that run's commands, named only by its token       | a descriptor/path snapshot proves the exact current-UID inode and token; the token is published under `condemned.d/` before the witnessed inode enters private quarantine                                                                                                          |
| taken record dropped because `ln` could not put it back                 | same                                               | the same exact snapshot and quarantine witness apply; an occupied canonical path stays visible, and the old token becomes a durable obligation before private deletion                                                                                                             |
| taken record deleted after a confirmed-stale verdict                    | same                                               | the exact current-UID inode is witnessed first and its authority token is published first; a foreign, duplicate-field, same-text replacement, or changed record is retained and stops the gate                                                                                     |
| pre-fallback quarantine witness removed                                 | a second link to owner evidence                    | the witnessed inode still has another visible link; recovery requires a link count of at least two and refuses a moved record before fallback publication                                                                                                                          |
| fallback-ready quarantine records removed                               | private owner evidence                             | the marker matches the witnessed authority token and proves the canonical owner or condemned-run obligation was published before the move; cleanup verifies `anchor` and `record` are the same inode                                                                               |
| dead quarantine basename replaced by a waiter's claim name              | recovery ownership for that private state          | one atomic directory rename replaces a verified empty mode-0700 placeholder; the winner verifies the claimed device and inode and fsyncs the directory and parent                                                                                                                  |
| losing quarantine claim placeholder removed                             | an empty private directory                         | source `ENOENT` proves another waiter won the old basename; cleanup validates the placeholder and removes it before the waiter restarts the full quarantine scan                                                                                                                   |
| `condemned.d/<token>` removed                                           | that run's commands                                | removed only after its drain confirmed those processes gone; a drain that cannot confirm exits instead                                                                                                                                                                             |
| settled Darwin lineage state removed                                    | exact descendant identity and settlement evidence  | the typed coordinator lease, drain obligation, legacy condemned record, or validated legacy owner is durably removed first; `verified-unbound-abandonment` instead proves no root, launcher, or tombstone ever gained authority; the remaining settled file is inert after a crash |
| `captured.<token>` removed after a drain                                | that run's process tree                            | removed only once every captured PID is gone, is a confirmed zombie with the same identity, or is somebody else now                                                                                                                                                                |
| `captured.<token>` removed when nothing was captured                    | nothing                                            | reached only when the persisted file and the tag scan are both empty, so there is nothing to hand on                                                                                                                                                                               |
| unvalidated legacy owner moved during release                           | legacy ownership evidence                          | the first move stays under `owner.reclaiming.release.*`; hidden-record recovery restores a live identity after a crash, and validation precedes the move to private state                                                                                                          |
| matching legacy owner moved into private release state                  | legacy ownership evidence                          | release validates the moved device, inode, current UID, and token; Node also checks exact text; later restore and cleanup use a hard-link witness for the same private inode                                                                                                       |
| empty legacy `run.lock` removed                                         | machine-wide compatibility ownership               | only the process holding the validated private owner calls `rmdir`; a successor owner keeps the directory non-empty and remains untouched                                                                                                                                          |
| private legacy release owner removed                                    | rollback evidence for that release                 | exact-inode quarantine binds the private snapshot through restore, successor settlement, or successful cleanup; a same-text replacement is retained and makes release fail closed                                                                                                  |
| coordinator holder marker removed                                       | process-generation evidence                        | the path must match the current-user inode and text held by the coordinator descriptor; cleanup then witnesses and removes only that exact inode, so a replacement marker is retained                                                                                              |
| Bash run or command holder marker removed                               | process-generation evidence                        | cleanup follows an empty census or worker teardown and binds only a cleanup-time current-UID, non-symlink regular exact-token inode. A replacement returns 2; safe evidence can be restored, and unsafe evidence stays private                                                     |
| `lsof` marker witness removed                                           | one private alias used only for a process scan     | normal and invalid-snapshot cleanup remove only the validated private `marker` link and directory; the shared holder pathname is never the cleanup target                                                                                                                          |
| private legacy staged/claim files removed                               | nothing                                            | never published; no other process reads or expects them                                                                                                                                                                                                                            |
| coordinator journal replaces its prior revision                         | coordinator state omitted by the new revision      | the complete new journal is fsynced before atomic rename; commit failure stops the server, and recovery reads a complete old or new revision                                                                                                                                       |
| queued coordinator lease dropped on restart or cancellation             | a pending reservation                              | queued means no command received a grant; the replacement journal commits before the scheduler can reuse its sequence or capacity                                                                                                                                                  |
| granted lease converted after restart or stale-owner cancellation       | worker identity and reserved capacity or resources | the same journal revision marks the lease `drain-required` and adds its drain obligation; the scheduler keeps that lease reserved                                                                                                                                                  |
| queued or granted lease removed by release or abandon                   | its capacity and named-resource reservation        | release requires the authorized client to finish; abandon requires `commandStarted=false`; both reject `drain-required`, and a failed commit retains the lease                                                                                                                     |
| drain claim cleared                                                     | exclusive authority to drain one stale request     | only the same claimant can release it, or the owner sweep first verifies that identity dead or reused; the obligations and leases remain in the journal                                                                                                                            |
| lease and drain obligation removed by acknowledgement                   | stale worker identity and its reservation          | the matching command identity and request claimant must report `processTreeEmpty=true`; recovery also drains the request identity first; a failed journal commit retains both records                                                                                              |
| stale lease and drain records removed during result recovery            | a completed execution and its reservations         | recovery first validates the immutable result against the active singleflight, then marks every attached request result-ready in the same journal revision                                                                                                                         |
| singleflight and request-order entries consumed at terminal publication | execution identity and attached waiters            | the immutable exact result is linked, fsynced, and validated first; attached requests remain result-ready until acknowledgement                                                                                                                                                    |
| result-ready request removed by acknowledgement                         | worktree admission and pending client handoff      | acknowledgement first reads and validates the immutable result; a failed commit leaves the request holding admission, and the result remains retained                                                                                                                              |
| follower request removed by cancellation                                | its worktree admission and coalesced wait          | a follower cannot own leases or publish a result; one journal revision removes it from both the request map and active singleflight                                                                                                                                                |
| inactive immutable request record unlinked                              | registration identity and capability digest        | the committed journal no longer has that request; terminal evidence stays in its immutable result, while a cancelled follower executed no work                                                                                                                                     |
| expired success index removed, then terminal result unlinked            | reusable success and terminal handoff evidence     | index removal commits first; active requests and remaining indexes protect their results, and unlink requires age strictly greater than two hours                                                                                                                                  |
| immutable request or result staging link removed after publication      | candidate immutable record                         | the canonical hard link and its directory are durable first; removing the second link cannot remove the canonical inode                                                                                                                                                            |
| orphan coordinator writer staging artifact removed by retention         | candidate state or a redundant immutable link      | the canonical state stays authoritative; removal requires the exact generated name, a current-UID regular non-symlink file, and age over two hours                                                                                                                                 |
| expired empty result-hash directory removed                             | nothing                                            | every result inside is already unreferenced and expired; `rmdir` succeeds only when the directory is empty                                                                                                                                                                         |
| obsolete empty namespace and its deletion marker removed                | old policy- or capacity-specific state             | its committed journal is idle, success indexes are empty, and request/result directories are empty; a linked and fsynced marker precedes protected-entry removal, and each directory transition is fsynced                                                                         |

Three properties make the table checkable. Legacy drain obligations live under
the lock **root**, not the lock directory, so releasing a lock never removes
them. Coordinator state changes publish a complete journal revision through a
fsynced temporary file and atomic rename. Filesystem retention and namespace
deletion require the durable predecessor evidence named in the table. A crash
can therefore retain redundant evidence or work, but it cannot silently release
authority, capacity, a named resource, or a worktree admission.

#### The rules the table rests on

Crashes are only half of it. The other half is ordinary interleaving: two runs
can each hold a verdict formed before the world changed, and act on it after.
Eight rules cover both, and every fix on this path has been an instance of one
of them.

1. **Every file this path creates carries its creator's PID and is registered
   with the exit trap before it exists.** Cleanup can then never race its own
   creation, and never names another run's file.
2. **A lock with no record is not evidence of an absent holder until the
   remnants have been read.** A remnant naming a live process is the owner
   record, misfiled; it gets linked back. Only a remnant whose recorded
   identity is verified dead may be deleted. A claim settles private
   quarantines before ordinary remnants and repeats that scan after every
   recovered or lost claim. It settles ordinary remnants immediately before
   publishing, not once at the top of a poll.
3. **A verdict is evidence, never authority.** Ownerless, stale, spent-remnant:
   each is re-checked immediately before the act it authorises, because the
   gap between deciding and acting is exactly where another run publishes.
   Destructive cleanup first creates a hard-link witness for the shared
   pathname. It reads authority from one descriptor for that exact current-UID
   inode. Node also compares the exact text. Cleanup deletes only names inside
   the resulting mode-0700 quarantine. Quarantine recovery claims the whole
   directory with one atomic rename so an orphaned mover and a second waiter
   cannot act on the same phase.
4. **The coordinator re-reads its own record before it grants work.** Acquiring
   the legacy lock and reaching the first command grant are separated by real
   work. Anything that unseats the record in between is caught here. The request
   stops with exit 2 and executes nothing.
5. **A command does not outlive its durable lease, and recovery proves it
   rather than assuming it.** Mapped commands run in the background. A
   `kill -9` on a gate client or coordinator can leave them running. Every
   worker carries its run token and the coordinator marker through argv,
   environment, and an inherited file descriptor. A successor scans those
   handles, signals uncertain workers, then **waits until they are actually
   gone** before it reuses their capacity or resources. Stopping an uncertain
   orphan is deliberate. Its result cannot be reported as success, and leaving
   it running would break the scheduler's capacity and exclusion guarantees.

   Each command's watchdog also kills its command when it notices its gate has
   disappeared, which is the quicker path in the ordinary case. It is not the
   guarantee: a watchdog can be descheduled by the same host pressure that
   killed the gate, or suspended with the laptop, and a timer sized to it
   would be waiting on something that may not run.
   `AGENT_QUALITY_GATE_LOCK_ORPHAN_DRAIN_SECONDS` (120s) bounds the
   confirmation, not the mechanism: reaching it means commands from a dead run
   are still alive, and the gate refuses to run rather than start beside them.
   On Darwin, a value of `0` is a settled-proof-only check. It can validate and
   consume an already durable settlement record. It cannot establish native
   authority, take a census, or signal an unsettled lineage. An unsettled
   lineage therefore keeps the gate blocked without receiving a signal.

6. **An obligation one recovery process owes its successor lives on disk, not
   in a variable.** Taking a lock from a dead holder makes the successor responsible for that
   holder's leftovers, and a process that is itself killed cannot hand a shell
   variable to its successor. The condemned run's token is written to its own
   file under `condemned.d/` in the lock **root** — beside the lock, because
   the lock directory is the thing being reclaimed — before the replacement
   record is published, and removed only once its processes are confirmed gone.
   Every run drains the whole directory rather than only the holder it
   reclaimed, so a chain of crashed reclaimers accumulates obligations instead
   of dropping them. Written-then-crashed costs a redundant no-op drain; the
   opposite order costs the overlap, which is why the write comes first.

   One file per outstanding run, not one shared list. A shared list has to be
   deleted by whoever drains it, and nothing in this shell can establish that
   every process which opened it by name has finished writing — an appender
   descheduled between its open and its write would have its line deleted
   unread, and that line is the only thing naming those commands. With a file
   each, nobody writes to a published file: it is built under a private
   `.staging.<pid>` name and moved into place whole, so a reader sees the
   complete token or no file. The drainer then claims each file by renaming it
   to `<token>.draining.<pid>` before reading it, which frees the published
   name at once and means the copy in hand is one nothing can replace —
   otherwise a second condemnation of the same run could swap the entry between
   the read and the unlink, and the unlink would delete an obligation nobody
   had drained. A drainer killed while holding a claimed file leaves it in the
   directory. The next run reads a non-empty record's token from its contents.
   For an empty legacy record, it removes every completed claim suffix from the
   filename before it validates the token.

   The scan repeats until a pass finds nothing, because obligations are still
   being published while the drain runs: a waiter condemning some third run's
   remnant does not wait for the lock. The gap between that last empty pass and
   the first mapped command is closed by asking ownership again rather than by
   synchronising the publishers. Every publisher derives an obligation from a
   record on disk, and while a run holds an untouched lock there is no such
   record to derive from — a remnant under this lock exists only if this run's
   own record was renamed away, and a run condemning what it took has taken
   ours. So either nothing could have been published after the last empty scan,
   or the record no longer names us and the run stops with exit 2. What can
   still land is a duplicate of an obligation this drain already discharged,
   published by a waiter that was mid-flight over a remnant this run had
   already condemned itself; its processes are gone, and draining a token twice
   is a no-op.

   The same applies to the captured tree, one level down. A drain's first pass
   kills the tag carrier, so from that moment the only record of what it was
   about to kill is in its own memory — and a successor searching for the tag
   would find nothing and read that as nothing left to do. The captured set is
   therefore written to `captured.<token>` beside the lock **before the first
   signal**, refreshed after the re-capture pass, and removed only once every
   process in it is confirmed gone. A successor unions that file with its own
   tag scan.

   **A write that fails is not a write that crashed.** Crashing part way still
   leaves the record the obligation was derived from, because that record is
   deleted only once the write has returned, so the next run's recovery
   re-derives it; the write failing while the caller carries on leaves nothing
   anywhere. So it cannot be swallowed the way a best-effort write usually is.
   The reachable case is not a full disk but a shared lock root, where the
   directory belongs to another user. Both writes report failure and both
   callers stop: a reclaimer that cannot condemn puts the record back where it
   found it and exits rather than taking over, and a drain that cannot persist
   its capture refuses to signal — before the first signal, while the tag it
   would destroy is still the handle on those processes. The one exception is
   teardown, which is already unwinding: it leaves the record in place, names
   it, and carries on to release the lock.

   **Unreadable is not empty.** The same shared root that makes a write fail
   makes a read fail, and treating an unreadable obligation as an absent one is
   how a run comes to execute beside commands it never drained. An obligation
   file, or the directory holding them, that exists but cannot be read stops
   the run and is named in the output. Hidden-owner recovery has the same
   failure direction. An unreadable, symlinked, or non-regular remnant stays in
   place and stops the gate. Recovery applies the same machine verdict and
   lock-root locality rule to a remnant. It does not check a local PID for
   another-machine evidence or unverified evidence on a root that may be
   shared. It can reclaim unverified evidence on a per-machine root only after
   the grace period and a dead or zombie PID. If protected-hardlink policy or
   another access error prevents restoration while the canonical owner is
   absent, the gate retains the remnant and exits before mapped work.

   **Obligation evidence is never rewritten in place.** A `>` redirection
   truncates the file the moment it opens, so a rewrite has a window in which
   the copy on disk is empty — and these files exist precisely to be read by
   whoever comes after a process that died at a bad moment. Both lists are
   therefore append-only, one short line per write, which is a single write
   through an append descriptor and so cannot interleave a half line. The
   readers tolerate duplicates, because re-checking a process that is already
   gone costs nothing, and skip any line whose PID field is not a number — a
   torn line should be impossible, and killing a stranger is a worse outcome
   than missing a survivor the tag scan would find anyway. The census behind
   that claim: `captured.<token>` is appended to; each
   `condemned.d/<token>` is written privately and published by rename; the
   owner record is built in a private per-PID file and published with `ln`, so
   its one `>` is to something nobody else reads; recovery-visible remnants
   and private quarantine records are created by rename. Nothing under the lock
   root is rewritten in place.

   The audit that goes with this rule, over the current code: the things that
   gate a destructive or permissive act are the staleness verdict
   (re-validated under the election immediately before acting, and the act
   itself is a single atomic rename, so a crash before it destroys nothing),
   the taken record (the remnant or exact-inode quarantine is the evidence),
   the obligation files and captured set (both persisted, above), the
   coordinator's owner record
   (re-read immediately before a grant), and the per-run teardown list (its
   evidence is the tag on the processes themselves). Nothing left on this path
   decides to destroy or to proceed on the strength of something only one
   process can see.

7. **Enumerate before signalling, and confirm against what you enumerated.**
   Only the wrapper carries the tag; its descendants do not. Signalling the
   tagged process first therefore destroys the one handle to everything under
   it — a command that ignores `TERM` outlives its wrapper, the next search for
   the tag comes back empty, and "no tagged process" reads as "nothing
   running". So the drain walks each tagged wrapper's tree first, recording
   every PID with its pinned start string, and then judges itself finished
   only when every process in that captured set is gone or cannot execute. A
   confirmed `Z` state with the same PID and start time is already dead, so a
   non-reaping PID 1 cannot hold the drain to its bound. An unreadable state
   remains live and fails closed. A PID that still exists but no longer matches
   its recorded start time was reused by someone else; it is left alone and
   named in the output rather than signalled. The
   walk repeats on every pass of the drain and stops recording a PID once it
   has been seen, so the census converges instead of freezing: a command whose
   `TERM` handler forks a replacement produces a child that did not exist when
   the first walk ran, and a capture taken once would kill the parent it knew
   about and leave that child running untagged into the next run.

   Discovery cannot rest on the argv tag alone, because the tag dies with the
   wrapper. A command that forks a replacement and then **exits** leaves that
   replacement reparented, untagged, and with no ancestor left to walk down
   from. So each mapped command starts with a request identity in its
   environment and an open descriptor on the request marker. A coordinator
   lease also persists a unique command identity before work starts. The
   command gets that identity in its argv and environment and holds its command
   marker open. Normal completion drains only the command identity, so sibling
   commands can continue. Crash recovery drains every lease identity and then
   the request identity before it acknowledges any lease obligation.

   The parallel parent opens the existing request marker before the fork. In
   coordinator mode, it also opens the shared generation marker for the worker.
   The worker therefore has request and mixed-version recovery identity from its first instruction without
   creating a command marker that could outlive an unregistered lease. The
   parent also opens a launch pipe before the fork. The worker waits there until
   the parent records its PID/start identity, validates `PGID == PID`, and
   publishes all aligned cleanup registries. The coordinator journal owns the
   command-to-request recovery mapping. A pure legacy parent writes the command
   identity as a drain obligation before launch release because it has no
   journal. The worker creates and retains its command marker only after that
   recovery mapping exists and, in coordinator mode, after its lease exists. It
   publishes complete result files through an atomic ready rename, then blocks
   as the live process-group leader until the parent drains it.

   Linux cleanup validates that live leader by its PID/start identity or an
   inherited token handle. It snapshots the leader's current process group into
   the command identity's durable capture before the first signal. Crash
   recovery derives the group only from a still-tagged group leader. It pins
   that leader's PID/start identity before the group snapshot. Each candidate
   must still have the same PID/start identity and current PGID. The drain then
   revalidates the leader after that candidate read. It does not persist or
   later signal a bare PGID. Each drain pass asks argv, environment, descriptor,
   and the validated live group anchor for new processes. Every persisted
   process uses a PID/start pair. Linux rechecks the kernel start tick before
   each numeric signal.

   Darwin cleanup uses a different contract. It creates durable state before
   the scheduler lease request, refreshes the complete baseline after the
   grant, and binds the wrapper's exact kernel identity before `START`. Each
   census classifies same-UID processes through stable process unique IDs and
   captured parent unique IDs. A process unique ID survives `setsid`,
   reparenting, environment removal, marker closure, and `exec`. The parent
   unique ID can change during `exec`. Two complete row reads detect that
   transition. An incomplete chain stays ambiguous unless a prior durable
   tombstone owns it. Settlement signals descendants through their audit
   tokens. Each row also contains the resource and jetsam coalition IDs. The
   native probe requires non-zero IDs and exact parent-child coalition
   inheritance. The bound root and launcher store and validate the same pair.
   XNU allocates unique IDs in increasing order. The native probe, parser,
   bound state, and census require each child unique ID to be greater than its
   non-zero parent unique ID. Non-monotonic evidence fails closed. A complete
   chain to the root is owned. An incomplete new chain is unrelated only when
   its coalition pair differs from the bound root's pair. An incomplete
   same-coalition chain remains ambiguous and keeps the global settlement
   barrier. The verified-empty record stays durable until the lease or recovery
   obligation is released.

   A broker that existed before the baseline breaks observable parent
   causality. The Darwin broker-launch preflight rejects unapproved repository
   client paths before mapped work starts. It scans ignored source outside the
   explicit dependency, cache, generated-output, documentation, and evidence
   exclusions. Mapped commands cannot use excluded content to request broker
   process creation. The coalition mismatch exclusion classifies external
   services only inside this preflight contract. Static inspection cannot
   identify arbitrary runtime-built calls or broker behavior hidden in a
   dependency or system executable. Those forms are unsupported without an
   OS-enforced containment boundary. The Trunk daemon is the explicit named
   trusted service. Other persistent services need their own reviewed resource
   and lifecycle contract.

   Everything a PID authorises is re-checked at the moment it is used, because
   every one of these answers goes stale. Enumeration and the identity read are
   two calls with a gap, so a PID recorded from a walk is confirmed to still be
   one of ours — still carrying a handle, or still a child of the exact
   PID/start identity the walk reached it through. Linux uses the kernel start
   tick for this live parent relation. The parent identity brackets the fresh
   child query. A child that cannot be confirmed is recorded with no identity,
   which is never signalled and holds the drain open. The census
   and the signal are separated by the bound and persist checks, so identity is
   read again immediately before each `kill` rather than trusted from the
   census. On a host with no identity source at all, a captured PID is signalled
   only while it still answers to one of the run's handles. And the set that
   stops a PID being recorded twice is per token, not per run: carried across
   tokens it would skip a PID that has since been recycled by a process
   belonging to the next one, recording it under no identity check at all.

   **A scan that failed is not a scan that found nothing.** `pgrep` and `lsof`
   both exit 1 for "no match" and above that for a real failure. Procfs
   enumeration applies the same rule. Reading a failed scan as empty would
   discharge an obligation on the strength of a question that was never
   answered. A failed scan keeps the drain open exactly
   as an unverifiable process does, and fails closed at the bound with its own
   line. Skipping an unreadable `/proc/<pid>/environ` is deliberately **not**
   that case. It happens three ways — another user's process, a process the
   kernel will not let us read because it changed credentials, and a process
   that exited between the directory listing and the read — and none of them can
   be a process this run started, because everything it starts keeps this user's
   credentials and this run's environment. Where that reasoning is stretched by
   a credential-changing descendant, the argv-tag and marker-descriptor scans
   still name it or fail closed; neither reads the environment. Counting an unreadable
   environment as a failed scan would instead fail every crash recovery closed
   on any host that has one such process, which every GitHub runner does. The
   read is wrapped in a group carrying its own `2>/dev/null`, because a
   redirection that cannot open its target is reported by the shell itself,
   before a `2>/dev/null` beside it applies: the bare form printed
   `/proc/<pid>/environ: Permission denied` into every drain's output on a
   runner (GitHub issue #1919). The `-r` test stays in front of it as a fast
   path — this loop runs once per process on the host — but it is not the
   guard, because permission bits are not what the kernel decides on. The scan
   reads NUL-delimited records with Bash builtins and compares each complete
   record. It does not start `tr` or `grep` for each visible PID. An exact-PID
   revalidation reads only that PID's argv and environment records. It does not
   run the host-wide `pgrep` query. Full refreshes retain the host-wide scan
   that discovers new descendants.

8. **Elapsed time comes from the clock, not from counting sleeps.** A loop that
   adds its own poll interval per iteration is measuring what it asked for. Any
   process can be descheduled, suspended, or stopped for longer than it slept —
   `SIGSTOP`, a laptop lid, a loaded runner — and such a loop resumes believing
   almost no time has passed. It then outlives the deadline it announced and
   reports a duration that never happened, which is worse than being late:
   every wait, drain, and watchdog budget in this path is also the evidence
   printed when one expires. Each of those loops reads the clock once before it
   starts and subtracts at the top of every iteration. The lock wait reads it in
   milliseconds (`EPOCHREALTIME`, falling back to whole seconds on a shell
   without it), because whole-second reads truncate at both ends: a wait that
   begins at `X.99` and lasts 1.05s subtracts to two seconds, and `--lock-wait 1`
   then reported a budget it had kept as an overshoot (GitHub issue #1919).

Rule 4 does not depend on getting an interleaving right. The other rules keep
clients and workers from crossing resource boundaries. Rule 4 makes any
residual displacement a single loud abort. Release stays token-guarded. It
moves and validates the exact owner, removes only an empty lock directory, and
restores the owner if `rmdir` fails without a successor. A stopped coordinator
cannot delete the lock of its successor.

The Bash self-test sweeps the legacy-lock crash boundaries by killing a holder
at each named point. It asserts that the next run reaches its mapped commands
and releases the lock. It also pins stale-record elections, persisted drain
obligations, unreadable identity, PID reuse, process-tree escape, and elapsed
wall-clock accounting. The coordinator test pins protocol refusal,
request-level fairness, all-capacity barriers, named resources, exact
coalescing, disconnects, journal restart, and drain acknowledgement. The real
Bash integration suite also pins hard-killed follower output cleanup. It pins
coordinator-disabled recovery of a killed new-protocol leader on Linux and the
bounded no-signal refusal for the same compatibility path on Darwin. Add each new
persistent operation to its crash table and test boundary in the same change.
The following synchronization and fault-injection controls are intentional. The
gate requires `NODE_ENV=test` for each active control. A normal run rejects any
active control.

- The paired `AGENT_QUALITY_GATE_LOCK_TEST_READY_FILE` and
  `AGENT_QUALITY_GATE_LOCK_TEST_RELEASE_FILE` paths pause a displaced-holder
  fixture after marker publication. Both paths must be set together.
- `AGENT_QUALITY_GATE_TEST_WORKER_REGISTRATION_BARRIER` pauses inside parallel
  worker registration before a pending signal is replayed. On Darwin, its
  validated test-control preflight establishes the worktree runtime capability
  receipt before the gate creates a parallel worker.
- `AGENT_QUALITY_GATE_TEST_DRAIN_REFRESH_BARRIER` pauses once between a drain's
  refreshed tag capture and its process census.
- `AGENT_QUALITY_GATE_TEST_PARALLEL_RELEASE_FAILURE_AT` accepts a positive
  integer and injects failure at that parallel lease-release attempt.
- `AGENT_QUALITY_GATE_TEST_OWNER_WITNESS_BARRIER`,
  `AGENT_QUALITY_GATE_TEST_OWNER_DISCARD_BARRIER`, and
  `AGENT_QUALITY_GATE_TEST_OWNER_QUARANTINED_BARRIER` pause after the owner
  hard-link witness, before the prepared pathname move, and after the moved
  pathname is validated.
- `AGENT_QUALITY_GATE_TEST_MARKER_WITNESS_BARRIER` pauses after the raw run
  marker has a hard-link witness.
- `AGENT_QUALITY_GATE_TEST_QUARANTINE_BEFORE_CLAIM_BARRIER` pauses after a
  waiter selects a quarantine and before it starts the claim.
- `AGENT_QUALITY_GATE_TEST_QUARANTINE_CLAIM_OPEN_BARRIER` pauses after the claim
  helper opens the source and placeholder and before it revalidates the source
  pathname.
- `AGENT_QUALITY_GATE_TEST_QUARANTINE_AFTER_CLAIM_BARRIER` pauses after an atomic
  whole-directory quarantine claim.
- `AGENT_QUALITY_GATE_TEST_OWNER_RESTORE_LINK_FAILURE=1` forces a live remnant's
  canonical hard-link restoration to fail.
- `AGENT_QUALITY_GATE_TEST_RELEASE_VALIDATED_BARRIER` pauses after the
  recovery-visible release owner is validated against its snapshot and before
  its private move.
- `AGENT_QUALITY_GATE_TEST_RELEASE_PRIVATE_BARRIER` pauses after the private
  release owner has a hard-link witness and before its pathname moves into that
  quarantine.
- `AGENT_QUALITY_GATE_TEST_LOCK_TAKEN_BARRIER` pauses after a stale owner
  pathname moves to its recovery-visible remnant and before the stale verdict is
  applied.

The self-test also sets
`AGENT_QUALITY_GATE_LOCK_RELEASE_BEFORE_TAKE_DELAY_SECONDS` and
`AGENT_QUALITY_GATE_LOCK_RELEASE_AFTER_TAKE_DELAY_SECONDS` to widen the two
release-owner interleavings. `AGENT_QUALITY_GATE_LOCK_DISCARD_DELAY_SECONDS` is a
delay-only seam immediately before a prepared quarantine pathname moves. The
implementation does not guard these delay seams with `NODE_ENV=test`. Normal
runs leave them unset.

A lock with no usable owner record — no file at all, or an unfinished one from
a run killed mid-write — counts as abandoned after a 30-second grace, measured
from the waiter's own first sighting. Both halves of publishing a record sit
inside that same accounting, and a live claimer cannot be condemned by it
anyway: if its record is discarded while it sleeps, its own `link` fails or
its read-back mismatches, and it queues rather than runs. The grace path is
still reachable, so it stays, but it carries no correctness weight; it only
keeps churn down.

`--no-lock` and `AGENT_QUALITY_GATE_LOCK=0` bypass the coordinator, its global
capacity, its worktree lease, its named resources, and legacy-version
exclusion. They are exceptional unsafe diagnostics. Do not use them to avoid a
normal queue or to make a push proceed. Use them only when you have proved that
no other gate, dashboard server, browser fixture, or mapped command can overlap.
They still create a request token and a marker in the private repo-local
`.tmp/agent-quality-gate/no-lock-handles` directory. This handle supports local
descendant cleanup. It does not serialize runs or use
`AGENT_QUALITY_GATE_LOCK_DIR`, so an unusable configured lock root does not
disable the explicit escape hatch.
A nested gate also uses this private directory for its own token, marker, and
Darwin lineage state. It keeps the ancestor's lock unchanged and does not
reuse the ancestor's token. The ancestor remains the successor recovery owner
if both gates stop.
A completed parallel worker still waits as a live group anchor while its
no-lock parent drains it. The worker tracks the parent's exact PID/start
identity and exits if that parent dies, because no successor owns its cleanup.
Coordinator workers apply the same parent-death rule before a granted lease has
a matching persisted recovery record. Darwin coordinator sentinels also apply
it after the grant because the unique-lineage record, not the out-of-lineage
sentinel, is the successor recovery authority.
On Darwin, the no-lock path still requires the unique-lineage state and atomic
audit-token signals. It never enters the portable numeric fallback. A failed
Darwin settlement returns non-zero and retains its state for inspection. On
Linux, a failed normal drain uses its recorded direct-child, worker-group, and
drain-capture identities for a bounded TERM/KILL settlement attempt. It
rechecks each generation before it sends a signal. It keeps the original
failure status because this fallback cannot prove that an unobserved detached
process is absent. Failed teardown changes an otherwise successful `EXIT`
status to 2.

`AGENT_QUALITY_GATE_LOCK_HELD` remains an internal self-test path. The self-test
exports `AGENT_QUALITY_GATE_LOCK=0` because its isolated fixture repositories
are not machine gate requests. Do not use either environment variable in an
operator workflow.

`AGENT_QUALITY_GATE_COORDINATOR=0` is also internal. Compatibility tests use it
to restore the safe serialized legacy lock. It does not disable exclusion. Do
not use it to avoid the coordinator in a normal gate run.

**Every fixture process the self-test scans for carries that run's own PID in
its name** (GitHub issue #1898). `pgrep` and `pkill` scan the whole machine, so
a fixed fixture name is not a run's own: four worktrees running this suite at
once each saw the others' timeout and interrupt fixtures, failed on them, and
passed on a clean re-run — and a `pkill` cleanup would have reaped a sibling's
live fixture. A new fixture whose liveness the suite asserts takes the same
`$((RANDOM % 900 + 100))-$$` suffix the lock-race fixtures use, and every scan
for it is scoped to that exact name.

The pre-push hook reaches neither bypass. It runs a fixed command line, and
Trunk strips these variables. If coordination fails, the hook exits non-zero.
After the reported recovery or compatibility blocker clears, fetch the hook's
base and warm the matching stamp with `git fetch --quiet origin main && pnpm
agent:quality-gate --run --base origin/main`. A verified matching success lets
the hook's `--skip-if-fresh` path exit before it registers another request.

Set `AGENT_QUALITY_GATE_DEBUG_STAMP=1` to print the active freshness-stamp
schema and fields, one per line on stderr. The first line names the schema. The
remaining lines mirror the exact v3 or v4 fields, including `scrubPolicy` and
the v4 `coordinatorContext`. The output therefore follows the active base
binding instead of assuming whether it is a tip or merge-base. It prints only
the stored identifiers and hashes. It does not print raw environment values.
The switch does not change the stamp or stdout. To diagnose a miss, capture the
warm command and the hook's exact fetch-and-run command back to back. The first
changed line names the input that prevented reuse.

**Heavy suites form barriers.** Dashboard coverage, its scoped `vitest related`
substitute, browser work, production builds, and size-limit work take all
configured capacity. The mutation baselines remain ordinary weight-1 work
because their serial runtimes do not prove contention. An older heavy command
stops new ordinary admission, waits for active commands to drain, then runs
alone. The weight-2 gate self-test reserves two
units when it becomes the oldest runnable weighted command. Cheap lint,
typecheck, unit, and knip commands can otherwise overlap across worktrees.

The reason, measured on a 12-core mac: that suite forks its own Vitest workers
across every core, and inside it `browser-api-policy.test.ts` spawns
`scripts/browser-api-policy-lint-runner.mjs`, a single ESLint program load that
costs ~17 seconds of CPU whatever else is happening. Wall clock is what moved —
the same subprocess took ~19s uncontended and 29–38s with a load average around
30 — so a wall-clock test budget expired while the work itself was unchanged.
That is starvation, not a flaky assertion. The barrier stops co-scheduling
instead of widening the budget. The suite's fixture wait now lives in a
`beforeAll` sized to that measurement, so a slow lint runner reports as a slow
lint runner instead of as a policy assertion failure.

Add to the all-capacity set only with a measurement. Every entry is wall time
that other requests cannot overlap. Fair request turns let cheap feedback run
without allowing later short work to starve an older barrier.

### Scoped local test runs (Refs #1413)

A per-package quality bundle normally runs `pnpm --filter <pkg> test:coverage`
(the package's full suite plus its coverage floor). Locally, when a package's
changed paths are a small set of production source files, the gate narrows that
one command to `pnpm --filter <pkg> exec vitest related --run <files>` so an
agent only pays for the tests reaching its edit. The reason string carries
`(scoped-tests)` so the substitution is visible in dry-run output. This is a
local-signal optimization only: CI still runs the full `test:coverage` coverage
floors, so scoping never changes what gets enforced.

The rewrite fires for a package only when **all** of these hold:

- the run has 15 or fewer total changed paths;
- every changed path inside that package directory is production source: a
  recognized TS/JS module extension (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`,
  `.jsx`, `.mjs`, `.cjs`) that is not `*.test.*`/`*.spec.*`, `__tests__/**`,
  `test/**`/`tests/**`, `vitest.config.*`, `vitest.hermetic-setup.ts`,
  `tsconfig*`, `package.json`, `*.graphql`, `__generated__/**` or other
  generated types, or `fixtures/**`. Non-module files (JSON/YAML/CSS/assets)
  disqualify scoping because tests may read them via `fs` rather than the
  import graph `vitest related` follows;
- the package is not `@mento-protocol/config` (shared-config's downstream blast
  radius is the point, so it keeps full suites);
- the run is not a full-workspace escalation (those keep full `test:coverage`
  everywhere);
- no test-infra file and no `shared-config/**` path changed anywhere in the
  diff (shared-config edits can regress any consumer through the dependency
  graph, which `vitest related` on the consumer's own changed files cannot
  see)
  (`scripts/envio-schema-stubs.graphql`, any vitest setup file).

Anything outside those bounds keeps the full `test:coverage`. `vitest related`
takes the file list relative to the package root and exits 0 when a changed file
has no related tests. Two escape hatches force the full local suite everywhere:
the `--full-local-tests` flag and the `AGENT_GATE_FULL_TESTS=1` environment
variable. Aegis (`test:cov` + `forge test`) is out of scope and always runs its
full suite.

QuickNode webhook state parsing has a dedicated fail-closed regression suite.
Changes to its shared parser, repair tool, shell test, or the listener
replacement provisioner map to
`bash alerts/infra/scripts/fix-webhook-state.test.sh`; the handler test suite
also executes that shell fixture in CI.

The [PR operating card](pr-operating-card.md#the-loop) owns ordinary gate and
closeout sequencing. A second `--run` request from another worktree joins the
coordinator. A request from the same worktree waits for that worktree lease.
Before a full gate starts, finish direct validation, dashboard servers, browser
suites, and package-manager work that runs outside the coordinator on the same
machine. Do not start uncoordinated work there until the gate exits. The
coordinator can schedule only registered gate work. An unregistered
package-manager process in the same worktree can change `node_modules`.
Unregistered validation from another worktree can still starve the scheduled
workers. Browser tests and size-limit can rewrite `next-env.d.ts`. Use
same-machine spare workers only for read-only work. Run concurrent validation
outside the coordinator only on another machine. Run focused checks first, then
let the gate own the mapped batch. For a non-trivial batch, freeze the card's
scope baseline and run autoreview after the gate. After accepted fixes, rerun
focused checks and autoreview.

**Stage timing and capture deadlines.** The wrapper and helper append
best-effort stage JSONL to `.tmp/agent-autoreview/durations.jsonl`; override
the directory with `AGENT_AUTOREVIEW_DURATIONS_DIR` or enable stderr summaries
with `AGENT_AUTOREVIEW_STAGE_SUMMARY`. Base lookup and `--feedback-pr auto`
use `AGENT_AUTOREVIEW_GH_DEADLINE_SECONDS` (60 seconds by default); feedback
capture uses `AGENT_AUTOREVIEW_FEEDBACK_DEADLINE_SECONDS` (120 seconds by
default). Evidence capture spends one shared budget,
`AGENT_AUTOREVIEW_CAPTURE_DEADLINE_SECONDS` (600 seconds by default), across
every capture a run performs in each runtime. Timeouts fail closed and name the
stage that ran out. Linux signals the detached process group. Before the first
Darwin deadline child starts, the wrapper snapshots its native lineage runtime,
then compiles and proves the private native helper's runtime capabilities. It
publishes a same-boot receipt only after that proof and its cache revalidation
succeed. A successor settlement process repeats that full authority check when
its worktree has no receipt for a durable lineage obligation. It reuses the
accepted census as its first recovery census and stays inside the original
settlement deadline. It captures each child's nonreusable kernel identity while the parent
relation is live. Every status check and signal uses that exact identity and
requires the receipt. The standalone wrapper settles each child and its
descendants through `darwin-coherent-lineage-v2`; the helper never sends a
numeric PID or negative-PID signal on Darwin. A prebound recovery watcher owns
the same obligation if the wrapper exits without cleanup. The watcher starts
its monotonic deadline before bootstrap. Bootstrap retries typed census
contention within that deadline. While the parent chain is coherent, the
watcher durably records exact owned or ambiguous descendants. It does not
record unrelated process churn. Each 200 ms census cycle makes one native
snapshot call. After typed contention, the watcher rechecks the private action,
controller, launcher, and remaining time. The watcher atomically publishes
private `armed` evidence after it validates its controller, launcher, action
marker, and exact lineage. The wrapper does not release deadline work until it
validates that evidence and confirms that the exact watcher identity remains
live. Normal finalization publishes the private `settle` action. The watcher
then becomes the only settlement writer. Setup abort paths publish `cancel`
instead. Settlement retries typed contention inside its existing monotonic
deadline. Expiry preserves the lineage state and recovery barrier.

The Sentry broker probe and CI-gate extractor each use a detached Bash
group-leader supervisor. Their children inherit every declared quality-gate
marker descriptor before their first instruction when the declaration is still
active. A Darwin runtime can close every marker descriptor while it retains the
environment declaration and then reuse those descriptor numbers for pipes. The
spawn helper treats that declaration as stale only when no declared descriptor
is an open regular file. Any partial survivor fails closed. Linux rejects an
all-stale declaration because its marker can be the only remaining containment
handle. The extractor's in-group watchdog writes a private timeout marker, then
signals `-$$` while the supervisor is still the live group leader. The broker
probe gives its watchdog a private control pipe that the target does not
inherit. A stop request, parent pipe EOF, or target exit settles the group while
the leader is live. Node never signals a returned numeric PID or process-group
ID after that leader is reaped.

This adapter uses the repo-local helper at `scripts/agent-autoreview.mjs` and
keeps the repo's branch-local target: merge-base-to-`HEAD` commits plus current
tracked and untracked work. It includes deterministic Mento checks and selected
repo checklist/feedback context. Review bundles are never silently truncated.
When a semantic prompt is too large, the helper losslessly partitions the
complete bundle into a bounded pass index for prepared-bundle handoff. One
fresh-context reviewer must inspect every listed pass so cross-pass contracts
remain visible. Direct Codex or Claude execution fails closed instead of
launching independent semantic passes, and bundle preparation fails if the full
review cannot fit the bounded pass budget.

Because the published changed-path and prompt metadata are line-oriented, paths
containing tabs or line breaks are rejected before review; rename such a path
before running autoreview.

Autoreview runs the review in an isolated, credential-stripped workspace. The
complete shell, helper, Darwin containment, and mapped-command
process-identity runtime closure is pinned to protected `main`. Evidence capture is
bounded and fail-closed, prepared bundles are identity- and manifest-checked,
and sensitive inputs are rejected before they reach a semantic engine. Every one
of those checks fails closed, and none of them is a knob. Operators need only
the invocation contract in this runbook; the defenses themselves are background
in [`autoreview-runtime-trust.md`](autoreview-runtime-trust.md).

One consequence reaches the invocation contract: a dirty or committed change to
the autoreview runtime itself fails closed and must be reviewed from a separate
trusted checkout with an explicit compatible `AUTOREVIEW_HELPER`, using the
procedure below.

An interrupted or unverified prepared bundle must not be reviewed. A failed
destination reservation is never recursively deleted, so inspect and remove an
incomplete, unmarked destination before retrying. Prepared bundles also reject
`--dry-run`: publication requires completed content validation, the main prompt,
and every strictly ordered, deterministic indexed bounded pass. Direct
`--bundle-output` publication refuses to replace an existing destination, so a
failed multi-pass write cannot corrupt a previously valid index — use a fresh
output path or deliberately remove the old set first.

When `--base` is omitted, automatic PR-base lookup falls back to `origin/main`
only when GitHub CLI is absent or the lookup confirms zero matching PRs.
Malformed output, multiple matching PRs, and operational lookup failures fail
closed because they cannot prove the correct review target. When GitHub CLI is
available, automatic lookup requires a canonical `github.com` origin, ignores
inherited `GH_HOST` and `GH_REPO`, and addresses that origin repository
explicitly. A unique match must also belong to the current repository owner,
preventing a same-named branch in a fork from selecting the wrong PR. Pass
`--base` explicitly as the offline escape hatch.
When prepared-bundle feedback selection is `auto`, the adapter resolves the
unique PR base, number, and canonical repository slug together and reuses that
one GitHub snapshot for the frozen diff and `feedback-state.json`. Missing
GitHub CLI, zero or multiple matches, and malformed metadata fail closed.
An explicit `--base` therefore requires an explicit `--feedback-pr` number
instead of `auto`. Commit-mode reviews also require an explicit feedback PR
number because the current branch's automatic PR cannot prove membership for an
arbitrary selected commit.

Direct supplemental-evidence paths must be repo-relative, regular UTF-8 files
confined to the worktree. A quiet semantic reviewer emits a progress heartbeat
every 60 seconds.

Inside an active Codex sandbox, and only when no engine was selected explicitly,
the adapter defaults to the helper's local deterministic engine because nested
`codex exec` is unavailable there. An explicit engine selection through
`--engine codex`, `--engine claude`, or `AUTOREVIEW_ENGINE` takes precedence
and fails closed if that engine is unavailable; it never silently falls back.

The helper resolves each external CLI in one order: an absolute path in
`AUTOREVIEW_<COMMAND>_BIN` (`AUTOREVIEW_CODEX_BIN`, `AUTOREVIEW_CLAUDE_BIN`),
then `PATH`, then the well-known install directories `/opt/homebrew/bin`,
`/usr/local/bin`, and `~/.local/bin`. That last list keeps the reviewer working
from agent-isolation and CI shells whose `PATH` omits the local package
manager's bin directory; set `AUTOREVIEW_EXTRA_BIN_DIRS` to replace it, or to an
empty value to search `PATH` alone. Every candidate still passes the same
trusted-executable checks, so the wider search never widens what the reviewer
will execute. An engine that resolves to nothing fails with the override
variable and the probed paths instead of a bare command-not-found exit. Set
`AUTOREVIEW_TRACE_COMMANDS=1` to log which candidate won.

A resolved codex that exits 127 **and** cannot report `--version` in the same
isolated environment is a launcher shim, not a working engine: shims re-resolve
the real CLI from a `PATH` the reviewer deliberately withholds, so the search
drops that candidate and continues. An engine that answers `--version` keeps its
own exit 127 as a review failure, and the search never silently swaps in a
different installation behind it. The probe spawns through the same
snapshot-revalidating path as every other trusted executable, captures no pipes
a descendant could hold open, and is bounded at 15 seconds by a `SIGKILL` sweep
of its own process group on Linux. On Darwin the shell wrapper binds the helper
to an exact lineage before launch. The wrapper settles that lineage on normal
exit and an autonomous exact-identity watcher settles it if the wrapper exits
or is killed. A probe that times out counts as failed, and the message says so.
When every candidate is a shim, one message names each with the reason its probe
failed and carries the engine's error.

Set `AUTOREVIEW_HELPER` only when intentionally testing or replacing the
pinned repo helper with a compatible implementation of its CLI contract.
Prepared-bundle replacements receive only the final prompt handoff and must
support the helper's `--bundle-output`, `--bundle-output-display`, and
`--trusted-input-root` flags. In the owning checkout an explicit override is
accepted only when the current shell wrapper matches pinned protected main and
the complete compatible runtime closure can be materialized from that same
protected object. Otherwise the command fails closed with the
separate-trusted-checkout
instruction used for runtime-changing reviews; a wrapper nested anywhere inside
the reviewed checkout is never treated as external. The old autoreview
`--parallel-tests` path is removed: the mapped quality gate owns test execution
and isolation.

The repo command itself is executable code from the active checkout. The
committed/pre-change runtime comparisons protect review integrity when the
runtime is unchanged; they do not turn an untrusted checkout into trusted
executable code. Merge-review provenance must not pass through the reviewed
checkout's package manager, package scripts, or package-manager configuration.

This preflight is **not merge-specific**. Any adapter call that trusts repository
identity — `pr:feedback-state`, `pr:ready-state`, a gate, a review — needs it, so an
ordinary babysit run binds identity before its first such call, not only when a conflict
appears. The merge case adds the two review axes below; it does not own the preflight.

For a same-repository merge review, bind repository identity before any
repo-local adapter command. Require `origin` to have one effective canonical
GitHub fetch URL. Normalize that URL and require its slug to equal the resolved
base repository and head repository. Fetch the resolved base branch and
protected `main` through that `origin` into their matching remote-tracking refs.
Pin their immutable values as `base_oid` and `protected_main_oid`. Require
`origin/<baseRefName>` and `origin/main` to keep those exact values; when the
base is `main`, require the two pins to match. Fail closed on a missing or
ambiguous URL, fetch error, malformed object ID, or ref drift. Do not change a
remote URL to satisfy this guard. Use a clean dedicated checkout with the
correct `origin`. Other verified remotes may remain, but the wrapper consumes
only the pinned `origin` identity and refs.

Repeat the canonical origin-URL check and both retained-ref checks immediately
before and after every feedback-state, ready-state, gate, or review adapter
call. Any error or drift stops the workflow and invalidates the result. Any
refetch, including a conflict-triggered base refresh, restarts this preflight and
refreshes both pins before another adapter call.

### The two review axes

A conflict repair is reviewed against **two** axes, because either alone can miss a
regression the other catches. Pin both inputs as immutable commit IDs before merging:
`base_oid` for the fetched base and `premerge_oid` for the published PR head as it stood
before the merge. Merge the exact `base_oid`, resolve, validate, and create the merge
commit locally without pushing it.

Pin the result as `final_head`, require a clean worktree, and require both inputs to be
its ancestors:

```bash
git merge-base --is-ancestor "$base_oid" "$final_head" || exit 1
git merge-base --is-ancestor "$premerge_oid" "$final_head" || exit 1
```

Then run the mapped gate against **both** axes, not just the new base:

```bash
pnpm agent:quality-gate --base "$base_oid" --head HEAD --run
pnpm agent:quality-gate --base "$premerge_oid" --head HEAD --run
```

`base_oid..final_head` shows what the branch adds to the new base. `premerge_oid..final_head`
shows what the merge changed about the branch — the axis that catches a resolution which
silently drops branch behaviour, since such a resolution looks clean against the new base.
Prepare, verify, and post-verify a separate review bundle per axis. Only after both
post-verifications pass, run the sequential suite as separate behaviour evidence, then push.

For each review axis, compare its immutable base tree with the immutable final
tree before any autoreview entrypoint runs. Treat the axis as runtime-sensitive
only when
`scripts/agent-autoreview.sh`, `scripts/agent-autoreview.mjs`,
`scripts/agent-autoreview-core.mjs`,
`scripts/agent-autoreview-secret-suppressions.json`,
`scripts/gate/darwin-process-identity.c`,
`scripts/gate/darwin-process-identity-runtime.inc.c`,
`scripts/gate/darwin-process-identity-helper.mjs`,
`scripts/gate/darwin-process-lineage-model.mjs`,
`scripts/gate/darwin-process-lineage-state.mjs`,
`scripts/gate/darwin-process-lineage.mjs`, or
`scripts/gate/mapped-command-process-identity.mjs` differs. Compare the modes
and blob IDs for all eleven paths on both axes. Fail closed on any Git, blob,
mode, or comparison error. If neither axis is sensitive, use the clean final
checkout's absolute wrapper and explicit helper. Invoke it through `/bin/bash`
from the reviewed checkout. Never use `pnpm agent:autoreview` for this
merge-review sequence.

For a runtime-changing PR, pin an immutable `trusted_oid` from the verified base
repository. It must be the last independently reviewed commit before every
runtime change found on the review axes. Retain the independent-review evidence.
Do not infer trust from ancestry alone. Prove that the helper protocol supports
bundle preparation, numeric feedback capture, explicit branch bases, and bound
pre/post manifest verification. Protected main is acceptable only with both the
review and compatibility evidence and only when it predates the runtime change
under review.

Create a clean detached physical checkout at `trusted_oid` outside the reviewed
worktree. Require its `HEAD` to equal `trusted_oid` and its worktree to be clean.
Require the wrapper, helper, core, exact-patch suppression JSON, both Darwin
identity sources, Darwin helper, Darwin lineage model, Darwin lineage state
runtime, Darwin lineage entry point, and mapped-command process-identity modes
and blob IDs to match `trusted_oid`.
Stop concurrent writers to both checkouts. From the reviewed checkout directory,
use the same absolute trusted wrapper and explicit compatible
`AUTOREVIEW_HELPER` for every required axis preparation. Invoke the wrapper
through `/bin/bash`. Use that exact trusted wrapper and helper for every
pre-review manifest check and retained-digest post-review check. Never
substitute the reviewed checkout's package script or wrapper.

Before and after every preparation or verification invocation, repeat the
normalized `origin` identity check; require the retained base and protected-main
refs to keep their pinned OIDs; require the reviewed checkout to remain clean at
its immutable final head; and repeat the selected eleven-file runtime closure's
physical-root, mode, and blob checks. Repeat the detached `trusted_oid` and
clean checks when the runtime is external. Any check error or drift invalidates
the invocation.

The basic one-axis call shape is:

```bash
reviewed_checkout=/absolute/path/to/reviewed-checkout
trusted_checkout=/absolute/path/to/trusted-pre-change-checkout
review_base_oid="$base_oid" # full immutable OID for this review axis
bundle_parent="$(mktemp -d)" || exit 1
bundle="$bundle_parent/context-bundle"
autoreview_wrapper="$trusted_checkout/scripts/agent-autoreview.sh"
autoreview_helper="$trusted_checkout/scripts/agent-autoreview.mjs"

run_trusted_autoreview() {
  (
    cd "$reviewed_checkout" || exit 1
    AUTOREVIEW_HELPER="$autoreview_helper" \
      /bin/bash "$autoreview_wrapper" "$@"
  )
}

run_trusted_autoreview --prepare-bundle-dir "$bundle" \
  --feedback-pr <number> -- --mode branch --base "$review_base_oid"
run_trusted_autoreview --verify-bundle-dir "$bundle"
# Retain the printed manifest digest outside the bundle. After semantic review:
run_trusted_autoreview --verify-bundle-dir "$bundle" \
  --expected-bundle-manifest <retained-digest>
```

For a runtime-insensitive review, set `autoreview_wrapper` and
`autoreview_helper` to the absolute final-checkout paths and use the same direct
call shape. Never point `trusted_checkout` at the runtime-changing checkout.
For multiple axes, allocate a distinct absent bundle path for each immutable
base outside both worktrees, then repeat the preparation and both manifest
checks with that base. Prepare and preverify every bundle, complete every
semantic review, then postverify every retained digest through the same bound
runner.

Only after every postverification passes, run the sequential suite without the
package manager:

```bash
(
  cd "$reviewed_checkout" || exit 1
  AUTOREVIEW_TEST_FOCUS=suite /bin/bash \
    "$reviewed_checkout/scripts/agent-autoreview.test.sh" --jobs 1
)
```

The suite is behavior evidence and establishes no review provenance. Require
terminal success, then repeat the origin, retained-ref, final-head, clean-state,
runtime-identity, and trusted-root checks. Any fix, `HEAD` movement, dirty
worktree, origin identity drift, base or protected-ref drift, trusted-runtime or
provenance drift, failed compatibility check, sequential-suite failure, or
manifest mismatch invalidates every result. Restart preflight, both gates, both
bundle preparations, both semantic reviews and postverifications, and the
direct sequential suite from the new clean final head.

For a true Codex semantic pass from inside Codex, prepare a repo-context bundle
and pass that bundle to a fresh-context reviewer:

```bash
pnpm agent:autoreview --prepare-bundle-dir /tmp/autoreview-bundle
pnpm agent:autoreview --verify-bundle-dir /tmp/autoreview-bundle
pnpm agent:autoreview --verify-bundle-dir /tmp/autoreview-bundle \
  --expected-bundle-manifest <digest-printed-by-the-pre-review-check>
```

Use a directory outside the repo worktree whose parent already exists so
local-mode bundles do not include their own generated files. Every canonical
ancestor of that parent must be owned by the current user or root; a
group/other-writable ancestor is accepted only when its sticky bit protects
other users' entries (for example `/tmp`). The bundle contains changed paths,
patch files, repo-selected checklist/prompt context, and the helper's
`autoreview-prompt.md`. Add `--feedback-pr <number>` to include the current
`pr:feedback-state` ledger as a review dataset for feedback-fix batches.
Prepared-bundle mode owns that prompt path, so do not combine
`--prepare-bundle-dir` with `--bundle-output`.
The generated README names the exact producing wrapper in both verification
commands; a runtime-changing review must not replace those commands with the
reviewed checkout's package script.
Retain the pre-review digest in reviewer state outside the bundle. After the
fresh-context reviewer has read every bounded pass, repeat
`--verify-bundle-dir` with that digest as `--expected-bundle-manifest`; both
checks must pass and must name the same digest. They detect persistent drift,
not a malicious same-UID process that can mutate and restore files between
checks, so an external helper must leave no background writer behind.

Autoreview answers whether the source bundle contains review findings. It does
not prove CLI/API behavior, generated artifacts, deployment/runtime behavior,
or a UI interaction. Keep the mapped quality gate and every applicable browser,
generation, integration, and runtime check in the validation record. The final
PR all-clear still comes from `pnpm pr:ready-state`, not autoreview.

To classify review depth and likely context-update requirements before or after
the mapped gate, use:

```bash
pnpm agent:review-materiality
```

The command reports `trivial`, `standard`, or `full` materiality from changed
path risk and diff size, plus whether the change likely needs AGENTS, README,
runbook, checklist, or skill context updates. It is advisory and does not
replace `pnpm agent:quality-gate --run`,
`pnpm agent:autoreview`, or `pnpm pr:ready-state`.

To warm Turbo's local cache for the Turbo-backed package tasks mapped by the
same gate without running deploy, Terraform, mutation, codegen, or install
commands, use:

```bash
pnpm agent:prewarm --base origin/main
```

It is a no-op when the gate maps no relevant Turbo commands. Like the run mode
gate, prewarm refuses those same package scripts until you review the
script/lifecycle diff and pass `--allow-package-script-changes`. Prewarm runs
Turbo commands with bounded parallelism too (`--parallel <n>`, default `2`, or
`AGENT_PREWARM_PARALLELISM`) and captures each command's output separately so
concurrent logs do not interleave. The same dashboard `.next` serialization rule
applies to prewarm.

The Trunk pre-push hook delegates to this same path-aware gate with
`--parallel 3 --skip-if-fresh`. Independent ordinary commands can run
concurrently within the global capacity. An all-capacity command runs after the
active pool drains. The hook reuses a recent successful manual gate run when
the whole-run freshness key is unchanged and the recorded success is no older
than the freshness TTL (two hours). Because it runs in parallel rather than
`--fail-fast`, a red push runs the remaining in-flight ordinary commands before
failing. Package-script acknowledgement is folded out
of the reuse key when there is no package-script risk, so a warm
`pnpm agent:quality-gate --run` — even one passed `--allow-package-script-changes`
defensively — satisfies the flag-less hook's `--skip-if-fresh` check, and
warm-then-push then skips the mapped commands. When a push DOES change package
scripts or package-manager config, the acknowledgement is part of the reuse key:
review the script/lifecycle diff first, then set
`agent.qualityGate.allowPackageScriptChanges=true` in local git config (seen by
both the manual warm run and the hook) so a just-passed acknowledged manual gate
can satisfy the `--skip-if-fresh` check.

Coordinator coalescing and retained-result reuse use the complete execution key
described above, including HEAD. The leader recomputes it before execution and
before result publication. A waiter recomputes it before accepting a shared
success.

The worktree-local whole-run stamp can exit before coordinator registration.
Its v4 freshness key binds every complete-key input except HEAD. It also records
the exact HEAD and coordinator fingerprint. An unchanged HEAD requires that
fingerprint to match. If HEAD changed, reuse still requires the same repository,
base, paths, plan, validated bytes and modes, implementation, timeout,
effective `--lock-wait` budget, fail-fast policy, OS, architecture, Node and
pnpm identities, coordinator policy and runtime, and material environment. This
exception lets a warm run made before a commit satisfy the pre-push hook after
the commit records the same validated bytes. Legacy and explicit no-lock runs
retain the v3 stamp. Any other change reruns the mapped commands. An unchanged
stamp still expires after two hours to avoid masking drift.

Validated file content is bound by each path's bytes, its worktree file mode,
and the `git diff --summary` lines for it — minus the `create mode` lines,
which report that a path became tracked rather than anything about what was
validated. An untracked path is invisible to `git diff`, so before that
exclusion a bare `git add` of a file the gate was already validating moved the
signature and cost a warm stamp a full re-run, with the changed-path set, the
mapped command plan, the base OID and the file's own bytes unchanged (GitHub
issue #1899). Everything that genuinely changes validation still moves it:
edited bytes, a changed file mode, and an add that puts a path the gate routes
into the changed-path set — `git add -f` of an ignored file, which no
`--exclude-standard` listing reports until it is tracked.

The base commit is a bound input, so warm the stamp **after**
`git fetch origin main`, not before: the pre-push hook fetches before it runs
the gate, and a stamp warmed against a stale `origin/main` is invalidated by
that fetch — correctly, because the validation base really did move.

Below the whole-run stamp, `--run` also keeps per-command success stamps
(`.tmp/agent-quality-gate/command-stamps.tsv`) so a run that was killed
mid-way, or that lost a single flaky check, resumes instead of restarting
(GitHub issue #1410). Each stamp records the exact same whole-run fingerprint
string, the command, and its completion time. When the whole-run fast-path skip
does not fire and execution begins, each mapped command is skipped (printed as
`↻ <command> (fresh from previous run)` and reported as `reused`, not executed)
only when a stamp exists whose fingerprint and command both match this run
exactly, and whose age is within the same two-hour TTL. Every
other outcome — parse error, missing file, fingerprint mismatch, TTL expiry —
fails toward rerun. Any edit to a validated file invalidates every per-command
stamp, and a start-of-run prune drops non-matching and expired entries. Only
quality commands are stamped. Before it dispatches a mapped command, the gate
snapshots and atomically replaces an existing cache with the pruned copy. A
read, write, or replacement failure stops the gate. Prerequisite phases
(install/codegen/quality-setup) always re-run: their outputs (node_modules,
generated code, built packages) are invisible to the source fingerprint, so a
stamp could skip them after their outputs were deleted. Within a leader
execution, the Trunk check, gate self-test, and advisory ADR reminder also
always re-run. The Trunk check is skipped, never reused, where Trunk's downloads
are blocked: the CLI, its plugin sources, or the linters that a check needs.

Each mapped command has a watchdog. The ordinary default is 1500 seconds. The
gate self-test default is 2100 seconds. The current exact-head suite passed in
1710 seconds after an earlier run reached the old 1500-second bound at 1504
seconds. This leaves 390 seconds of measured headroom.
`--command-timeout <n>` or
`AGENT_QUALITY_COMMAND_TIMEOUT_SECONDS` replaces both defaults. The resolved
ordinary and self-test bounds are part of the coordinated execution identity.
On Linux, the watchdog TERM→KILLs the validated process tree. On Darwin, it
signals the exact watchdog and wrapper identities, changes the lease to
`settling`, and completes the unique-lineage census. It never uses a bare PID or
process-group ID. A failed exact settlement returns within the configured
drain bound and keeps the scheduler barrier. The gate reports
`Command timed out after <n>s: <command>` and logs durations status `fail`. The
timeout never bounds the whole run.

A failing command's captured output is printed inline, and its last 20 lines are
repeated under `Failure output (last 20 lines per command):` next to the final
verdict. In a parallel run the inline dump can sit thousands of lines above that
verdict, and a command that fails while printing nothing — a launcher that
redirects its own errors away — reads as `(no output captured)` there instead
of leaving no trace at all.

That default was 900 until this gate's own self-test became the longest mapped
command. Most of its time proves lock, scheduler, interrupt, and descendant
recovery boundaries. The cap is a backstop against a hung command, not a
performance budget. Use `durations.jsonl` to find a command that has grown too
slow.

Package-local gate tasks for `lint`, `typecheck`, `knip`, dashboard size-limit,
local dashboard browser tests, and dashboard React Doctor checks run through
Turbo's local filesystem cache (`pnpm exec turbo run ... --cache=local:rw`).
The gate coalesces same-task Turbo checks into one invocation with multiple
explicit `--filter` arguments when several packages map the same task. Remote
caching is disabled in `turbo.json`. The Turbo config is only for the gate's
explicit package-filtered invocations; do not use it as a general workspace
task orchestrator.
Per-package coverage floors run as direct package commands such as
`pnpm --filter <pkg> test:coverage` (or Aegis `test:cov`) so they always
exercise the current local coverage threshold rather than a stale cached test
result. A small production-source-only diff narrows the local `test:coverage`
command to `vitest related` per the scoped-test rules above; the full coverage
floor still runs in CI.
Dashboard build/browser/React Doctor cache keys explicitly include
`shared-config`, package-manager, workflow, wrapper-script, and relevant env
inputs; CI still runs browser tests normally and remains the Linux snapshot
authority. The build task passes and hashes both Vercel deployment identity
inputs. The local size-limit command pins
`VERCEL_DEPLOYMENT_ID=local-quality-gate`, so Trunk's stripped hook environment
and empty operator-local Vercel placeholders cannot produce an empty persisted
cache salt; `agent:prewarm` reuses that same mapped command. The only task
dependency is `size-limit -> build`, because
size-limit reads `.next/` output; the local gate relies on that dependency
instead of mapping a separate dashboard build command for size-limit checks.
High-risk or cross-layer commands stay outside Turbo, including codegen,
install, dep-cruiser, coverage floors, mutation baselines, and Terraform.

The gate exports `TURBO_CACHE_DIR="$HOME/.cache/turbo-monitoring-monorepo"`
before running any Turbo task (unless the caller already set `TURBO_CACHE_DIR`,
or opted out with `AGENT_TURBO_SHARED_CACHE=0`), so every worktree shares one
Turbo cache and a fresh per-PR worktree reuses warm entries instead of starting
cold. The material environment digest includes the effective cache location.
Gates with different caller-selected locations do not coalesce or reuse a
whole-run freshness stamp. Turbo still restores an entry only on a
content-addressed input-hash match. Turbo 2.9.x writes artifacts via
temp file + atomic rename with PID-namespaced temp names, so concurrent gates
cannot corrupt the shared dir. When `HOME` is unset or the dir is unwritable
(e.g. a sandbox allowlist excluding it), the gate leaves `TURBO_CACHE_DIR`
unset and falls back to Turbo's per-worktree default; the `Turbo cache dir:`
header prints only when sharing is active. The shared dir is pure cache and
grows without bound — delete it any time to reclaim disk:
`rm -rf "$HOME/.cache/turbo-monitoring-monorepo"`. Refs GitHub issue 1411.

## Self-test families (`GATE_TEST_FOCUS`)

`scripts/agent-quality-gate.test.sh` is partitioned into families. Every test
lives inside exactly one `run_<family>_family` function; nothing but blank lines
and comments sits between those functions. A family is a subject, so a change to
one part of the gate can be iterated against that subject alone instead of the
whole suite:

```bash
GATE_TEST_FOCUS=routing-sources bash scripts/agent-quality-gate.test.sh
GATE_TEST_FOCUS=routing-packaging,routing-docs bash scripts/agent-quality-gate.test.sh
```

| Family               | Subject                                                                                                                            | Solo runtime |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `gate-contract`      | Pins on the gate's source text, classifier resolution, Turbo task-graph inputs, agent context check.                               | 2s           |
| `coordinator`        | Coordinator protocol, fair weighted capacity, barriers, named resources, coalescing, and recovery.                                 | 210s         |
| `install-wiring`     | Pre-push hook installation, the install-marker library, the package-script pin validator.                                          | 1s           |
| `routing-packaging`  | Manifests, package-manager config, root package-script and dev-metadata classification, lockfile-importer scoping.                 | 52s          |
| `routing-sources`    | Source-path routing: scoped `vitest related`, indexer codegen order, shared-config blast radius, deploy/terraform arms.            | 86s          |
| `execution-phases`   | Phase order, fail-fast prerequisites, local parallelism, quality-setup, and scheduler classification.                              | 41s          |
| `stamps-freshness`   | The fresh-run stamp: what busts it and what may reuse it.                                                                          | 15s          |
| `failure-output`     | Quiet failure output, stack traces, React Doctor, renames, the manifest-change refusal.                                            | 10s          |
| `routing-docs`       | Documentation, agent context, code-health, Sentry and PR-tooling routing, including the `scripts/` symlink reach.                  | 92s          |
| `stamps-commands`    | Per-command stamps, always-rerun exemptions, command timeouts and interrupts.                                                      | 27s          |
| `execution-parallel` | Parallel identity and process-group drains, detached-session lease ordering, the production identity contract, prerequisite reuse. | 51s          |
| `lock-drain`         | Legacy compatibility lock: acquisition, stale-holder reclaim, drain obligations, and crash-point recovery.                         | 319s         |

Rules that keep the focus honest:

- **Unset or empty runs everything.** The dispatch tests the value, not its
  presence, so `GATE_TEST_FOCUS` unset and `GATE_TEST_FOCUS=` behave alike: both
  run every family in registry order, which is the file order and the order this
  suite has always used. `pnpm agent:quality-gate:test`, the gate's own mapped
  self-test, and CI all run in that mode.
- **The focus is refused where it could answer for the whole suite.** A
  non-empty `GATE_TEST_FOCUS` exits 2 when any of `AGENTQG_RUN`,
  `AGENT_QUALITY_GATE_LOCK_HELD`, or `GITHUB_ACTIONS` holds a non-empty value,
  so an exported focus cannot shrink the gate's self-test or CI's run.
  `AGENTQG_RUN` is the load-bearing one because the gate puts it on the argv of
  every mapped command in every mode. Explicit no-lock runs create a private
  process handle, but they still export no global lock or coordinator state.
- **The partition is checked, not assumed.** `verify_gate_family_partition`
  runs before the family definitions, reading the suite file through the path
  resolved at startup. It reds the suite when a test line sits outside every
  family, when a family is missing from the registry, when the definitions drift
  out of registry order, and when the lines after the closing marker are
  anything but exactly one `dispatch_gate_test_families` call — a second call
  would run every family twice, and none would run nothing and still exit 0. An
  unassigned test fails there before it can execute.
- **A new test goes inside the family that owns its subject.** A new subject
  gets a new family function plus its `gate_test_families` entry, in file order.
- Selection follows registry order, not the order given, and a repeated family
  runs once. Unknown family names exit 2 and print the known set.

## Common local-gate traps

- `codespell` flags short variable names that match common abbreviations (e.g. a two-letter loop var that looks like a misspelling). Use descriptive names like `netData` to avoid this.
- `trunk check --ci <file>` checks only the specified files. That is correct for
  the path-aware local agent gate. Use `trunk check --ci --all` to reproduce
  CI's full-repo Trunk job manually.
- If `indexer-envio typecheck` fails with "Cannot find module 'generated'", run `./scripts/setup.sh` first
