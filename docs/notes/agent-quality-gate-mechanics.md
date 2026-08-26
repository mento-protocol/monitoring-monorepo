---
title: Agent Quality Gate — Mechanics
status: active
owner: eng
canonical: true
last_verified: 2026-08-23
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

`pnpm agent:autoreview` reviews source only. `pnpm agent:autoreview:test` runs
all families with at most three workers and bounded progress/timings, which the
mapped gate preserves. `-- --jobs 1` changes only scheduling. CI uses that mode
on `ubuntu-latest` for runtime or fixture changes; required `ci` demands success
when selected.

Background `--run` gates and `git push`: a 600s foreground kill writes no
freshness stamp, so the next run cannot use `--skip-if-fresh`. Each run appends
per-command JSON plus one `__run_total__` line to gitignored
`.tmp/agent-quality-gate/durations.jsonl`. Targets: 3 minutes for common mapped
sets and 8 minutes for the full workspace (Refs #1415).

If a sandboxed mapped run fails only because a command needs host capabilities,
rerun the full mapped gate with host access on the same head. The gate reuses
stamp-eligible fresh successes and runs the blocked commands. A resumed run does
not write a whole-run stamp. Trunk and the gate self-test are stamp-exempt and
always run, including during the later pre-push gate; Trunk's one exception is
an environment that blocks its downloads — the CLI, its plugin sources, or the
linters a check needs — where the arm is skipped. Other
eligible successes keep per-command stamps, so the later gate can avoid
repeating them. Running a command directly proves it but records no per-command
stamp.

For a manual full-repository reproduction of the server-side pre-push baseline,
including when hooks are absent or uncertain, use:

```bash
git fetch origin main:refs/remotes/origin/main
./tools/trunk fmt --all
./tools/trunk check --all
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
view. The live Bash case mirrors the derived patterns, and the routing-table
equality test pins both copies. The checklist arms contain exact current paths
only. Eighteen broad inventory patterns cover `.ts`, `.tsx`, `.mts`, `.cts`,
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
scheduled evaluation. Review the output, then run:

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
proxies egress and refuses any host outside its allowlist — the gate reports the
arm as `skipped` with a warning naming the allowlist fix instead of failing the
run, matching the posture `.trunk/hooks` already takes. Trunk downloads at two
stages and the gate classifies both. If the launcher cannot fetch the pinned CLI
from `trunk.io`, a probe run after the command fails
(`TRUNK_LAUNCHER_QUIET=true ./tools/trunk --version`) answers that directly. If
the launcher succeeds but the CLI cannot fetch its plugin sources or the
hermetic runtimes and linter binaries a check needs — `trunk.io` allowlisted,
`github.com` and `nodejs.org` not — the gate classifies the check transcript
instead. That classification never infers "nothing was found": it accepts the
transcript only when Trunk itself reported no issues, every failure Trunk
counted is a download step, and the reason each step recorded in its
`.trunk/out/*.yaml` detail file is one of Trunk's download-failure phrasings.
The warning replays those reasons so it names the host to allowlist. Everything
else fails the gate, including a partly-explained failure set and a download
step that failed for a local reason. Only a provisioning failure degrades: a
provisioned Trunk that finds real problems still fails the gate, and so does a
run that mixes real findings with a blocked download. A run whose Trunk arm was
skipped writes no whole-run success stamp, so the next `--skip-if-fresh` run
retries Trunk instead of inheriting a pass it never earned. Normal `--run` mode
executes independent
quality-phase commands with
bounded parallelism (`--parallel <n>`, default `auto` capped at 4 workers, or
`AGENT_QUALITY_PARALLELISM`). Preflight, codegen, post-codegen install,
Terraform init/validate chains, shared-config build setup, and the package
script pin validator remain ordered prerequisites on every path — including
`--parallel 1` and keep-going runs, where they previously degraded to ordinary
keep-going commands and let their dependents run after a
failure. Playwright browser install, dashboard `test:browser`, and
build-backed `size-limit` stay serialized with each other, but are not global
quality prerequisites. The quality-gate self-test is also serialized before the
parallel pool because it temporarily mutates tracked fixture files; this keeps
source-fingerprinting tests such as autoreview from observing synthetic drift.
A browser setup failure still lets independent lint/typecheck/unit/knip
feedback run. `--fail-fast` stays sequential so it still stops before starting
the next mapped command. Parallel workers use Bash job-control groups on macOS
Bash 3.2 and Linux. INT/TERM waits for PGID registration; teardown TERM→KILLs
each group and reaps its leader after descendants reparent. New sessions can
escape (none of the mapped commands create one).

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
bucket order, the four post-passes, the root-manifest classifier). Both are
routed by a change to the engine or the table, and the routing-table suite also
runs in the required `ci` job.

### Scheduling contract (Refs #1802)

The gate owns the machine while it runs. Two rules make that true, and both
exist because contention — not flakiness — produced the failures in issue
#1802.

Before invoking a full gate, wait for all direct validation, dashboard servers,
and browser suites on the same machine to finish. From invocation until the
gate exits, do not start any of them there. The gate owns dependency setup and
local validation parallelism. Concurrent package-manager processes in the same
worktree can recreate or invalidate `node_modules`. Validation from another
worktree on the same machine can still starve the gate of CPU and memory. Use
spare workers for read-only work. Run concurrent validation only from a fully
hydrated checkout on another machine.

**One `--run` gate at a time, machine-wide.** `--run` takes a mkdir lock
(`$HOME/.cache/agent-quality-gate/run.lock`, falling back to
`$TMPDIR/agent-quality-gate-<uid>`; override with
`AGENT_QUALITY_GATE_LOCK_DIR`) before it executes anything, and releases it on
exit. `mkdir(2)`, `link(2)` and `rename(2)` are the primitives because macOS
has no `flock(1)` and the repo's floor is Bash 3.2. Each is doing one job:
`mkdir` creates the lock, `link` publishes a finished owner record and refuses
an occupied path, and `rename` takes a record away — atomically, with the
source vanishing, so whoever arrives second fails with `ENOENT`. Neither
`link` nor `rename` is ever applied to the lock _directory_: `mv src dir`
moves `src` _inside_ an existing `dir` instead of failing, so a rename could
never be a conditional claim there. A second run prints the holder's PID,
host, and worktree, then waits — bounded by `--lock-wait` / `AGENT_QUALITY_GATE_LOCK_WAIT_SECONDS`,
1800 seconds by default — and exits 2 naming that holder if the wait runs out.
The expiry states itself on **stdout as well as stderr** (GitHub issue #1894).
Every other outcome already did — a green run ends `All mapped commands
passed.` — but the expiry once spoke on stderr alone, so a caller reading the
gate's stdout saw the `waiting up to Ns` banner and then nothing. Piped, that
became a fail-open: a pipeline reports the _reader's_ status unless the caller
set `pipefail`, so a run that executed nothing read as a pass on the stream and
on the status at once. The stdout verdict names the wait expiry, says no mapped
command ran, and names the status a pipeline hides. `SIGPIPE` is ignored for
those two writes, and they come after the stderr diagnosis: a stdout that
closes while the verdict is being written costs the caller the stdout copy,
never the stderr copy and never the exit status. A reader that closes _earlier_
still kills the run on the wait banner, which is a `SIGPIPE` death — non-zero,
so still not a pass. That is the invariant this path owes its caller: **a run
that executed nothing never reports success, in any output mode.**
Nothing that will not execute mapped commands ever competes for the lock: a dry
run, a `--skip-if-fresh` cache hit, and a package-script refusal all exit
before it. After waiting, a `--skip-if-fresh` run re-checks freshness, so the
pre-push hook that queued behind a manual warm-up run reuses that run's stamp
instead of repeating its work.

The current-run handles live in `scripts/gate/run-handles.sh`. The gate sources
that module from its own `$script_source_dir` before it changes directory, and
fails closed if the path is missing, unreadable, a symlink, or not a regular
file. The module provides run-token validation and pattern helpers, owns the
marker-path state and test-ready barrier, and provides tagged-process
discovery. Its path is included in `implementation_signature()`
and changes to it route the gate self-test. The ready/release barrier is test
only; it requires `NODE_ENV=test` and both lock-test paths, and normal runs do
not enter it.

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
unattended recovery. So the owner record stores the kernel's own start-time
string for the holder (`ps -o lstart=`), compared verbatim: same PID and same
start string means the holder, same PID with a different start string means
the PID was reused and the lock is stale. Where no start time is available on
either side — a sandbox without `ps`, a lock written by an older gate — this
falls back to PID existence, which errs toward waiting rather than evicting.

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
whose identity read came back empty, since the process was already gone, and a
host with no identity source at all records `<no-identity-source>` — the one
case that still signals on PID alone, because nothing better exists there.

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

The refusal also owns the wait's ending. A run that timed out because a reclaim
was refused is told that nothing was reclaimed and that the record may need
removing by hand, instead of the usual "holder is still alive; let it finish" —
which would send an operator to wait on a process this run already read as gone.

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
than time-based: a waiter that finds the recorded holder gone takes the record
away and claims. `kill -9` on a gate run therefore costs the next run one line
of output, never manual cleanup, and there is no state a signal can leave that
needs a hand: the temp path a reclaim renames into is registered with the exit
trap **before** the rename creates it, and cleanup restores rather than deletes,
so an interrupted reclaim puts the record back exactly as it found it.

#### Crash points

A signal can land between any two of the filesystem operations above, and a
`kill -9` skips the exit trap entirely, so the safe-state argument has to be
made per boundary rather than per function. The boundaries are finite; this is
all of them. Safe means: at most one process believes it holds the lock, no
record naming a live holder is invisible to the next reader, and no state
requires manual cleanup.

| Crash lands                                                                       | State left behind                                                                                                                   | Next run                                                                                                                                    |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| before `mkdir run.lock`                                                           | nothing                                                                                                                             | takes the lock normally                                                                                                                     |
| after `mkdir`, before the record is staged                                        | lock directory, no record                                                                                                           | no complete record, so after the grace it publishes its own                                                                                 |
| after staging, before `link`                                                      | `owner.claiming.<pid>` only                                                                                                         | same as above; the staged file is private and inert, and goes when the lock does                                                            |
| after `link`, before the staged copy is unlinked                                  | complete record plus an inert `owner.claiming.<pid>`                                                                                | reads the record; reclaims it if its holder is gone                                                                                         |
| while the holder runs mapped commands                                             | complete record naming a dead shell — and its command still running, because mapped commands are backgrounded and outlive the shell | the next run finds those commands by the dead run's token, stops them, and waits until they are gone before executing anything              |
| while the holder runs mapped commands, with its watchdog descheduled or suspended | same, and nothing will clean up on its own                                                                                          | identical: the check looks for the processes rather than waiting for the watchdog, so a watchdog that never runs changes nothing            |
| after `mv owner → owner.reclaiming.<pid>`, before the taken record is judged      | no `owner`, one remnant                                                                                                             | reads the remnant first: a live identity is linked back as the record, a spent one is discarded                                             |
| after judging a taken record stale, before the new record is published            | no `owner`, no remnant                                                                                                              | no complete record, so after the grace it publishes its own                                                                                 |
| after a taken record is judged NOT stale, before it is put back                   | same as the take boundary above                                                                                                     | same as the take boundary above                                                                                                             |
| during `rm -rf` in release                                                        | lock directory partially gone                                                                                                       | either it is absent (take it) or record-less (grace, then publish)                                                                          |
| after noting a condemned run, before publishing the replacement                   | the obligation names a run whose record is still in place                                                                           | reclaims that record again and notes the same token twice; draining a token whose processes are gone is a no-op                             |
| after publishing a replacement, before draining what it condemned                 | the obligation names a run nobody is clearing                                                                                       | inherits the whole directory, not just the holder it reclaimed, so a chain of crashes loses nothing                                         |
| after capturing a dead run's process tree, before the first signal                | the captured set is on disk, nothing has been signalled yet                                                                         | re-reads it, unions it with its own tag scan, and confirms every entry — a set naming already-dead PIDs costs identity-checked no-op checks |
| mid-drain, after the TERM pass has killed the tag carrier                         | no tagged process remains, but an untagged descendant may still run                                                                 | inherits the persisted captured set, so it looks for those PIDs rather than for a tag nobody carries any more                               |

#### Where evidence is destroyed

The crash-point table above asks what a crash leaves behind. This one asks the
question that produced most of the findings on this path: **every place that
destroys or consumes evidence, and why the obligations derived from it are
already durable when the destruction runs.** Round after round the same shape
turned up — evidence thrown away, or held only in memory, before the obligation
it implied had been written down — so the sites are enumerated here rather than
rediscovered one at a time.

| Destruction                                             | What derived from it                         | Why it is safe before the delete                                                                                           |
| ------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| remnant deleted after a successful `ln` restore         | the record itself                            | not destroyed — the content is now the owner record at the canonical path                                                  |
| remnant deleted because its holder is verified dead     | that run's commands, named only by its token | the token is published under `condemned.d/` first; a token for a run with nothing alive costs one drain that finds nothing |
| taken record dropped because `ln` could not put it back | same                                         | same: the token is published under `condemned.d/` before the copy goes                                                     |
| taken record deleted after a confirmed-stale verdict    | same                                         | `record_condemned_run` runs immediately before it, inside the election                                                     |
| `condemned.d/<token>` removed                           | that run's commands                          | removed only after its drain confirmed those processes gone; a drain that cannot confirm exits instead                     |
| `captured.<token>` removed after a drain                | that run's process tree                      | removed only once every captured PID is gone, is a confirmed zombie with the same identity, or is somebody else now        |
| `captured.<token>` removed when nothing was captured    | nothing                                      | reached only when the persisted file and the tag scan are both empty, so there is nothing to hand on                       |
| lock directory removed at release                       | this run's own commands                      | the exit trap tears down its commands before release, and release only deletes a record that still names this run          |
| private staged/claim files removed                      | nothing                                      | never published; no other process reads or expects them                                                                    |

Two properties make the table checkable rather than a promise. Obligations are
written to the lock **root**, not the lock directory, so releasing a lock never
takes them with it. And every entry above records before it deletes, which is
the same ordering the rest of this note argues for: the failure direction of
writing too early is a redundant no-op, and of writing too late is a run that
starts beside somebody else's work.

#### The rules the table rests on

Crashes are only half of it. The other half is ordinary interleaving: two runs
can each hold a verdict formed before the world changed, and act on it after.
Four rules cover both, and every fix on this path has been an instance of one
of them.

1. **Every file this path creates carries its creator's PID and is registered
   with the exit trap before it exists.** Cleanup can then never race its own
   creation, and never names another run's file.
2. **A lock with no record is not evidence of an absent holder until the
   remnants have been read.** A remnant naming a live process is the owner
   record, misfiled; it gets linked back. Only a remnant whose recorded
   identity is verified dead may be deleted — and a claim settles remnants
   immediately before publishing, not once at the top of a poll.
3. **A verdict is evidence, never authority.** Ownerless, stale, spent-remnant:
   each is re-checked immediately before the act it authorises, because the
   gap between deciding and acting is exactly where another run publishes.
4. **A holder re-reads its own record before executing anything.** Acquiring
   the lock and reaching the first mapped command are separated by real work.
   Anything that unseats the record in between — a waiter acting on a stale
   verdict, a hand-deleted lock — is caught here and the run stops with
   `this run no longer holds the gate run lock`, having executed nothing.
5. **A command does not outlive the gate that started it, and the next run
   proves it rather than assuming it.** Mapped commands run in the background,
   so a `kill -9` on the gate shell leaves them running while the lock they
   held becomes reclaimable — exclusion would hold on paper while two runs'
   commands shared the machine. Two things close that. Every process a run
   starts for a mapped command carries the run's lock token in its own argv,
   so it is identifiable from outside by something born with it, with no
   registry to keep in step and no window where a child exists untracked. And
   a run that took the lock from a dead holder, before executing anything,
   looks for processes carrying that holder's token: none means there is
   nothing to wait for, and any that are there are signalled and then **waited
   for until they are actually gone**. Killing another run's orphan is
   deliberate — that run is gone, its work cannot be reported, and leaving it
   running is the outcome the lock exists to prevent.

   Each command's watchdog also kills its command when it notices its gate has
   disappeared, which is the quicker path in the ordinary case. It is not the
   guarantee: a watchdog can be descheduled by the same host pressure that
   killed the gate, or suspended with the laptop, and a timer sized to it
   would be waiting on something that may not run.
   `AGENT_QUALITY_GATE_LOCK_ORPHAN_DRAIN_SECONDS` (120s) bounds the
   confirmation, not the mechanism: reaching it means commands from a dead run
   are still alive, and the gate refuses to run rather than start beside them.

6. **An obligation one run owes the next lives on disk, not in a variable.**
   Taking a lock from a dead holder makes this run responsible for that
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
   directory; the next run reads the token from the file's contents rather than
   its name, so the suffix costs nothing.

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
   the run and is named in the output.

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
   that claim: `captured.<token>` is appended to; each `condemned.d/<token>` is written privately and published by rename; the owner
   record is built in a private per-PID file and published with `ln`, so its
   one `>` is to something nobody else reads; `owner.reclaiming.<pid>` is
   created by rename. Nothing under the
   lock root is rewritten in place.

   The audit that goes with this rule, over the current code: the things that
   gate a destructive or permissive act are the staleness verdict
   (re-validated under the election immediately before acting, and the act
   itself is a single atomic rename, so a crash before it destroys nothing),
   the taken record (the remnant file _is_ the evidence), the obligation files
   and the captured set (both persisted, above), the holder's own record
   (re-read immediately before executing), and the per-run teardown list (its
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
   from. So each mapped command starts with two handles its descendants
   inherit and keep: the run's token in the environment, readable through
   `/proc/<pid>/environ` where that exists, and an open descriptor on the run's
   `holder.<token>` marker file, readable through `lsof` where that exists.
   Both are named by a token unique to one run, so unlike a PID or a process
   group neither can come to name a stranger. Each drain pass asks all three —
   argv, environment, descriptor — and captures whatever is new. Where no
   inherited handle is readable the argv tag stands alone, and a command of
   that shape can still escape; nothing at this shell's floor closes that.

   Everything a PID authorises is re-checked at the moment it is used, because
   every one of these answers goes stale. Enumeration and the identity read are
   two calls with a gap, so a PID recorded from a walk is confirmed to still be
   one of ours — still carrying a handle, or still a child of the process the
   walk reached it through — and one that cannot be confirmed is recorded with
   no identity, which is never signalled and holds the drain open. The census
   and the signal are separated by the bound and persist checks, so identity is
   read again immediately before each `kill` rather than trusted from the
   census. On a host with no identity source at all, a captured PID is signalled
   only while it still answers to one of the run's handles. And the set that
   stops a PID being recorded twice is per token, not per run: carried across
   tokens it would skip a PID that has since been recycled by a process
   belonging to the next one, recording it under no identity check at all.

   **A scan that failed is not a scan that found nothing.** `pgrep` and `lsof`
   both exit 1 for "no match" and above that for a real failure, and reading
   the second as the first would discharge an obligation on the strength of a
   question that was never answered. A failed scan keeps the drain open exactly
   as an unverifiable process does, and fails closed at the bound with its own
   line. Skipping an unreadable `/proc/<pid>/environ` is deliberately **not**
   that case. It happens three ways — another user's process, a process the
   kernel will not let us read because it changed credentials, and a process
   that exited between the directory listing and the read — and none of them can
   be a process this run started, because everything it starts keeps this user's
   credentials and this run's environment. Where that reasoning is stretched by
   a credential-changing descendant, the argv-tag and marker-descriptor scans
   still name it; neither reads the environment. Counting an unreadable
   environment as a failed scan would instead fail every crash recovery closed
   on any host that has one such process, which every GitHub runner does. The
   read is wrapped in a group carrying its own `2>/dev/null`, because a
   redirection that cannot open its target is reported by the shell itself,
   before a `2>/dev/null` beside it applies: the bare form printed
   `/proc/<pid>/environ: Permission denied` into every drain's output on a
   runner (GitHub issue #1919). The `-r` test stays in front of it as a fast
   path — this loop runs once per process on the host — but it is not the
   guard, because permission bits are not what the kernel decides on.

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

Rule 4 is the one that does not depend on getting an interleaving right, and
it is why the others are allowed to be merely careful: they keep runs from
tripping over each other, while rule 4 makes any residual displacement a single
loud abort instead of two runs on one machine. Release stays token-guarded, so
a run that stops there cannot delete the lock of whoever holds it now.

The self-test sweeps the crash boundaries by killing a run at each named point
and asserting the next run still reaches its mapped commands and releases the
lock, and pins the interleavings — two waiters on one stale record, a stalled
creator, a cached ownerless verdict, and a displaced holder — as separate
cases. A command that forks a fresh child on every `TERM`, a waiter held under
`SIGSTOP` past its own budget, and a reclaimer facing an obligation directory it
cannot write into are pinned there too: the first asserts no forked survivor
outlives the drain — in two shapes, one where the forking command keeps running
and one where it exits and orphans its replacement — the second that the
reported wait matches the wall clock,
the third that the run exits without executing and leaves the record it was
about to discard. Unreadable obligation files, an obligation left behind by a
dead drainer, and one published while a drain is running are pinned alongside
them. Adding an operation to this path means adding its boundary to the table
and to that sweep.

A lock with no usable owner record — no file at all, or an unfinished one from
a run killed mid-write — counts as abandoned after a 30-second grace, measured
from the waiter's own first sighting. Both halves of publishing a record sit
inside that same accounting, and a live claimer cannot be condemned by it
anyway: if its record is discarded while it sleeps, its own `link` fails or
its read-back mismatches, and it queues rather than runs. The grace path is
still reachable, so it stays, but it carries no correctness weight; it only
keeps churn down.

Two escape hatches start immediately: `--no-lock` (or `AGENT_QUALITY_GATE_LOCK=0`),
and an inherited `AGENT_QUALITY_GATE_LOCK_HELD`, which is how the gate's
self-test drives the gate against fixture repos from inside a gate run without
deadlocking behind its own ancestor. The self-test exports
`AGENT_QUALITY_GATE_LOCK=0` for the same reason: its fixture runs are not this
machine's gate, and must neither queue behind a real one nor block it.

**Every fixture process the self-test scans for carries that run's own PID in
its name** (GitHub issue #1898). `pgrep` and `pkill` scan the whole machine, so
a fixed fixture name is not a run's own: four worktrees running this suite at
once each saw the others' timeout and interrupt fixtures, failed on them, and
passed on a clean re-run — and a `pkill` cleanup would have reaped a sibling's
live fixture. A new fixture whose liveness the suite asserts takes the same
`$((RANDOM % 900 + 100))-$$` suffix the lock-race fixtures use, and every scan
for it is scoped to that exact name.

The pre-push hook reaches neither hatch — it runs a fixed command line and
Trunk strips the environment those variables would arrive in — so when a hook's
wait times out, recover in band by warming the stamps first
(`pnpm agent:quality-gate --run`, which queues behind the holder, or
`--no-lock` if you accept the contention) and then pushing: the hook's
`--skip-if-fresh` cache-hits and exits before it ever takes the lock.

**Heavy suites do not share the worker pool.** The quality phase runs in four
parts: ordered setup prerequisites, the serialized dashboard build/browser
group, the parallel pool, and an exclusive phase that starts only after the
pool has drained. `is_quality_exclusive_command` holds that last set. Today it
is the dashboard's Vitest suite — `pnpm --filter @mento-protocol/ui-dashboard
test:coverage` and the scoped `vitest related` substitute that can replace it.

The reason, measured on a 12-core mac: that suite forks its own Vitest workers
across every core, and inside it `browser-api-policy.test.ts` spawns
`scripts/browser-api-policy-lint-runner.mjs`, a single ESLint program load that
costs ~17 seconds of CPU whatever else is happening. Wall clock is what moved —
the same subprocess took ~19s uncontended and 29–38s with a load average around
30 — so a wall-clock test budget expired while the work itself was unchanged.
That is starvation, not a flaky assertion, which is why the remedy is to stop
co-scheduling the suite rather than to widen the budget until the starvation
stops being visible. The suite's fixture wait now lives in a `beforeAll` sized
to that measurement, so a slow lint runner reports as a slow lint runner
instead of as a policy assertion failure in whichever test happened to reach it
first.

Add to the exclusive set only with a measurement: every entry is wall time the
pool can no longer overlap. The exclusive phase runs last precisely so cheap
lint/typecheck feedback still arrives first.

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
closeout sequencing. A second `--run` gate no longer needs a convention: the
run lock above queues it behind the first one, on any worktree. Before invoking
a full gate, ensure that no direct validation, dashboard server, or browser
suite is active on the same machine. From invocation until the gate exits, do
not start any of them there — the lock does not know about those processes.
Browser tests and size-limit both run `next build` and can rewrite
`next-env.d.ts` in the same worktree; validation in another worktree can still
starve the gate. Run focused checks first, then let one gate own the mapped
batch. Run concurrent validation only on another machine. For a non-trivial
batch, freeze the card's scope baseline and run autoreview after the gate; after
accepted fixes, rerun focused checks and autoreview.

**Stage timing and capture deadlines.** The wrapper and helper append
best-effort stage JSONL to `.tmp/agent-autoreview/durations.jsonl`; override
the directory with `AGENT_AUTOREVIEW_DURATIONS_DIR` or enable stderr summaries
with `AGENT_AUTOREVIEW_STAGE_SUMMARY`. Base lookup and `--feedback-pr auto`
use `AGENT_AUTOREVIEW_GH_DEADLINE_SECONDS` (60 seconds by default); feedback
capture uses `AGENT_AUTOREVIEW_FEEDBACK_DEADLINE_SECONDS` (120 seconds by
default). Evidence capture spends one shared budget,
`AGENT_AUTOREVIEW_CAPTURE_DEADLINE_SECONDS` (600 seconds by default), across
every capture a run performs in each runtime. Timeouts fail closed and name the
stage that ran out: both runtimes signal the whole process group of the command
they bounded rather than the direct child alone.

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

Autoreview runs the review in an isolated, credential-stripped workspace: the
helper and core runtime are pinned to protected `main`, evidence capture is
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
of its own process group. A probe that times out counts as failed, and the
message says so. When every candidate is a shim, one message names each with the
reason its probe failed and carries the engine's error.

Set `AUTOREVIEW_HELPER` only when intentionally testing or replacing the
pinned repo helper with a compatible implementation of its CLI contract.
Prepared-bundle replacements receive only the final prompt handoff and must
support the helper's `--bundle-output`, `--bundle-output-display`, and
`--trusted-input-root` flags. In the owning checkout an explicit override is
accepted only when the current shell wrapper matches pinned protected main and
compatible helper/core blobs can be materialized from that same protected
object. Otherwise the command fails closed with the separate-trusted-checkout
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
`scripts/agent-autoreview.sh`, `scripts/agent-autoreview.mjs`, or
`scripts/agent-autoreview-core.mjs` differs. Compare the modes and blob IDs for
all three paths on both axes. Fail closed on any Git, blob, mode, or comparison
error. If neither axis is sensitive, use the clean final checkout's absolute
wrapper and explicit helper. Invoke it through `/bin/bash` from the reviewed
checkout. Never use `pnpm agent:autoreview` for this merge-review sequence.

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
Require the wrapper, helper, and core modes and blob IDs to match `trusted_oid`.
Stop concurrent writers to both checkouts. From the reviewed checkout directory,
use the same absolute trusted wrapper and explicit compatible
`AUTOREVIEW_HELPER` for every required axis preparation. Invoke the wrapper
through `/bin/bash`. Use that exact trusted wrapper and helper for every
pre-review manifest check and retained-digest post-review check. Never
substitute the reviewed checkout's package script or wrapper.

Before and after every preparation or verification invocation, repeat the
normalized `origin` identity check; require the retained base and protected-main
refs to keep their pinned OIDs; require the reviewed checkout to remain clean at
its immutable final head; and repeat the selected wrapper/helper/core
physical-root, mode, and blob checks. Repeat the detached `trusted_oid` and clean
checks when the runtime is external. Any check error or drift invalidates the
invocation.

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
`--parallel 3 --skip-if-fresh`, so the independent quality-phase members run
concurrently (the heavy `test:coverage` suites and the gate self-test overlap
instead of summing to the serial total), and it reuses a recent successful
manual gate run when the fetched base commit, mapped command plan, gate
implementation, changed paths, validated file content, and package-risk state
are unchanged and the recorded success is no older than the freshness TTL
(two hours). Because it runs in parallel rather than `--fail-fast`, a red
push runs the remaining in-flight members before failing (green pushes, the
common case, get the full speedup). Package-script acknowledgement is folded out
of the reuse key when there is no package-script risk, so a warm
`pnpm agent:quality-gate --run` — even one passed `--allow-package-script-changes`
defensively — satisfies the flag-less hook's `--skip-if-fresh` check, and
warm-then-push then skips the mapped commands. When a push DOES change package
scripts or package-manager config, the acknowledgement is part of the reuse key:
review the script/lifecycle diff first, then set
`agent.qualityGate.allowPackageScriptChanges=true` in local git config (seen by
both the manual warm run and the hook) so a just-passed acknowledged manual gate
can satisfy the `--skip-if-fresh` check.

The whole-run stamp's signature is the same bound-input set described above;
any change to it reruns the mapped commands immediately, while an unchanged
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
quality/serialized/parallel commands are stamped. Prerequisite phases
(install/codegen/quality-setup) always re-run: their outputs (node_modules,
generated code, built packages) are invisible to the source fingerprint, so a
stamp could skip them after their outputs were deleted. The Trunk check, the
gate self-test, and the advisory ADR reminder also always re-run — the Trunk
check is skipped, never reused, where Trunk's downloads are blocked (the CLI,
its plugin sources, or the linters a check needs).

Each mapped command has a watchdog (default 1500 seconds; override with
`--command-timeout <n>` or `AGENT_QUALITY_COMMAND_TIMEOUT_SECONDS`). On timeout
it TERM→KILLs the process tree, reports
`Command timed out after <n>s: <command>`, and logs durations status `fail`. A
self-daemonizing child can escape the tree (none do). The timeout never bounds
the whole run.

A failing command's captured output is printed inline, and its last 20 lines are
repeated under `Failure output (last 20 lines per command):` next to the final
verdict. In a parallel run the inline dump can sit thousands of lines above that
verdict, and a command that fails while printing nothing — a launcher that
redirects its own errors away — reads as `(no output captured)` there instead
of leaving no trace at all.

That default was 900 until this gate's own self-test became the longest mapped
command: it runs 525s alone and past 900s inside a full gate run, where it
competes with everything else on the machine, and most of that time is spent
asserting that runs queue rather than race — length that cannot be trimmed
without the assertions ceasing to bind. The cap is a backstop against a hung
command rather than a performance budget; `durations.jsonl` is where a command
that has grown too slow gets noticed.

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
cold. The location is deliberately absent from the freshness stamp: Turbo
restores an entry only on a content-addressed input-hash match, so the
directory changes speed, never pass/fail. Turbo 2.9.x writes artifacts via
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
whole ~9-minute suite:

```bash
GATE_TEST_FOCUS=routing-sources bash scripts/agent-quality-gate.test.sh
GATE_TEST_FOCUS=routing-packaging,routing-docs bash scripts/agent-quality-gate.test.sh
```

| Family               | Subject                                                                                                                 | Solo runtime |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------ |
| `gate-contract`      | Pins on the gate's source text, classifier resolution, Turbo task-graph inputs, agent context check.                    | 2s           |
| `install-wiring`     | Pre-push hook installation, the install-marker library, the package-script pin validator.                               | 1s           |
| `routing-packaging`  | Manifests, package-manager config, root package-script and dev-metadata classification, lockfile-importer scoping.      | 52s          |
| `routing-sources`    | Source-path routing: scoped `vitest related`, indexer codegen order, shared-config blast radius, deploy/terraform arms. | 86s          |
| `execution-phases`   | Phase order, fail-fast prerequisites, the parallel quality pool, quality-setup, dashboard serialization.                | 41s          |
| `stamps-freshness`   | The fresh-run stamp: what busts it and what may reuse it.                                                               | 15s          |
| `failure-output`     | Quiet failure output, stack traces, React Doctor, renames, the manifest-change refusal.                                 | 10s          |
| `routing-docs`       | Documentation, agent context, code-health, Sentry and PR-tooling routing, including the `scripts/` symlink reach.       | 92s          |
| `stamps-commands`    | Per-command stamps, always-rerun exemptions, command timeouts and interrupts.                                           | 27s          |
| `execution-parallel` | Parallel teardown process groups, the production identity contract, prerequisite reuse.                                 | 51s          |
| `lock-drain`         | Cross-run mutual exclusion: acquisition, stale-holder reclaim, drain obligations, crash-point recovery.                 | 319s         |

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
  `AGENTQG_RUN` is the load-bearing one: the gate puts it on the argv of every
  mapped command in every mode, while the lock marker is absent under
  `--no-lock` and `AGENT_QUALITY_GATE_LOCK=0`, where `acquire_gate_run_lock`
  returns before exporting it.
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
- `trunk check <file>` only checks the specified files. That is fine for the path-aware local agent gate, but use `--all` when you need to manually reproduce CI's full-repo Trunk job.
- If `indexer-envio typecheck` fails with "Cannot find module 'generated'", run `./scripts/setup.sh` first
