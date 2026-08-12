---
title: Agent Quality Gate — Mechanics
status: active
owner: eng
canonical: true
last_verified: 2026-08-12
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
Indexer changes additionally route the protected
[`docs/pr-checklists/indexer-handler-invariants.md`](../pr-checklists/indexer-handler-invariants.md)
policy into prepared autoreview bundles.

The dry-run gate maps changed paths to package checks and PR checklists. For a
routing-sensitive source, the shared classifier adds the offline
`pnpm docs:navigation-eval -- --check-fixtures` check. It invokes no model or
scheduled evaluation. Review the output, then run:

```bash
pnpm agent:quality-gate --run
```

Every non-empty candidate change set also runs `pnpm tf:test`. The required
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
(`scripts/check-agent-quality-gate-package-scripts.sh`) runs as a fail-fast
quality-setup prerequisite: an unpinned or drifted alias aborts the run before
any `pnpm <alias>` executes, and `--skip-if-fresh` cannot skip it. Existing changed paths run
targeted Trunk checks for faster local iteration. Deleted paths,
Trunk/tooling changes, package-manager changes, pnpm patches, and
package-manifest changes still run full-repo Trunk locally. CI also runs a
required full-repo Trunk check on every
PR. Normal `--run` mode executes independent quality-phase commands with
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
workspace-manifest-class change and `scripts/lockfile-scope.mjs` (js-yaml
structural diff) reports that only importer sections changed; a parse/`git show`
failure, a co-changed manifest, any non-importer top-level section
(`settings`, `catalogs`, `overrides`, `patchedDependencies`,
`packageExtensionsChecksum`, `packages`, `snapshots`, …), or an importer that
maps to no known package bundle falls back to the full suite. The dev-metadata
class covers a root `package.json` whose changed JSON pointers are all under
`/devDependencies` or `/name`, `/description`, `/license`, `/keywords`,
`/author`, `/repository`, `/bugs`, `/homepage`; any `/dependencies`, `/pnpm`,
`/packageManager`, `/engines`, `/scripts`, or unknown-key change keeps today's
full-suite and package-script refusal behavior. Both classes still set the
package-script risk flag, so `--run` continues to refuse until
`--allow-package-script-changes`, and `package.json` still gets a full-repo
Trunk scan.

`classify_root_package_json_changes` is lifted out of this script and re-run by
`scripts/check-sentry-suites-in-ci-gate-probe.mjs`, which proves each alias still
routes to the arm it is supposed to. The probe runs it with an empty `$PATH`
under `set -r`, so the function must reach nothing but shell builtins, keywords
and `json_change_paths` — no external command, and no output redirection, which
restricted mode forbids. Its verdict must also be a function of the change paths
alone, so it may not read anything the probe did not supply: `< <(json_change_paths …)`,
heredocs and here-strings are fine, a redirection from a file is not. Editing it
to need any of those fails the check with an explanation; change the probe in the
same PR or keep the classifier free of them.

### Scheduling contract (Refs #1802)

The gate owns the machine while it runs. Two rules make that true, and both
exist because contention — not flakiness — produced the failures in issue
#1802.

**One `--run` gate at a time, machine-wide.** `--run` takes a mkdir lock
(`$HOME/.cache/agent-quality-gate/run.lock`, falling back to
`$TMPDIR/agent-quality-gate-<uid>`; override with
`AGENT_QUALITY_GATE_LOCK_DIR`) before it executes anything, and releases it on
exit. `mkdir(2)` and `O_EXCL` are the primitives because macOS has no
`flock(1)`, BSD `mv` has no `-T` — `mv src dir` moves `src` _inside_ an
existing `dir` instead of failing, so a rename can never be a conditional
claim here — and the repo's floor is Bash 3.2. A second run prints the
holder's PID, host, and worktree, then waits — bounded by `--lock-wait` / `AGENT_QUALITY_GATE_LOCK_WAIT_SECONDS`,
1800 seconds by default — and exits 2 naming that holder if the wait runs out.
Nothing that will not execute mapped commands ever competes for the lock: a dry
run, a `--skip-if-fresh` cache hit, and a package-script refusal all exit
before it. After waiting, a `--skip-if-fresh` run re-checks freshness, so the
pre-push hook that queued behind a manual warm-up run reuses that run's stamp
instead of repeating its work.

The invariant the lock keeps is: **at every instant at most one process
believes it holds it, and no waiter ever removes or renames another run's
lock.** Three rules carry that. A holder is made in two atomic steps — win
`mkdir` on the lock path, then create `owner` with `O_EXCL` — so a creator
descheduled between them finds its exclusive write refused and queues instead
of running beside whoever took over. A waiter that judges a lock stale must
first win a `mkdir` election on `run.lock/reclaim`, then **re-read the owner
record and confirm it is still the same dead identity it judged**; a verdict
formed before winning the election is worthless, because another reclaimer may
have taken the lock over in between. Only then does it drop that record and
claim, again with `O_EXCL`. Nothing renames or deletes a lock directory except
the run that owns it.

A killed holder cannot release its own lock, so recovery is explicit rather
than time-based: the lock records the holder's PID, and a waiter that finds
that PID gone takes the lock over in place. `kill -9` on a gate run therefore
costs the next run one line of output, never manual cleanup. The one state
that does need a hand is a reclaimer `kill -9`ed inside the milliseconds it
holds `run.lock/reclaim` — no waiter can break that marker without reopening
the race it exists to close, so the gate fails closed after five polls and
prints the exact `rm -rf` to run. A signal the process can catch clears the
marker on the way out, which leaves `SIGKILL` as the only way in.

A lock whose owner record never appeared — a run killed between `mkdir` and
its write leaves exactly that — counts as abandoned after a 30-second grace.
That path is still reachable, so it stays, but it no longer carries any
correctness weight; it only keeps churn down.

Two escape hatches start immediately: `--no-lock` (or `AGENT_QUALITY_GATE_LOCK=0`),
and an inherited `AGENT_QUALITY_GATE_LOCK_HELD`, which is how the gate's
self-test drives the gate against fixture repos from inside a gate run without
deadlocking behind its own ancestor. The self-test exports
`AGENT_QUALITY_GATE_LOCK=0` for the same reason: its fixture runs are not this
machine's gate, and must neither queue behind a real one nor block it.

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
run lock above queues it behind the first one, on any worktree. What is still
yours to avoid is a dashboard server or browser suite you started yourself
alongside a gate — the lock does not know about those. Browser tests and
size-limit both run `next build` and can rewrite `next-env.d.ts`; run focused
checks first, then let one gate own the mapped batch. For a non-trivial batch, freeze the card's scope baseline
and run autoreview after the gate; after accepted fixes, rerun focused checks
and autoreview.

**Stage timing and gh-lookup deadlines.** The wrapper and helper append
best-effort stage JSONL to `.tmp/agent-autoreview/durations.jsonl`; override
the directory with `AGENT_AUTOREVIEW_DURATIONS_DIR` or enable stderr summaries
with `AGENT_AUTOREVIEW_STAGE_SUMMARY`. Base lookup and `--feedback-pr auto`
use `AGENT_AUTOREVIEW_GH_DEADLINE_SECONDS` (60 seconds by default); feedback
capture uses `AGENT_AUTOREVIEW_FEEDBACK_DEADLINE_SECONDS` (120 seconds by
default). Timeouts fail closed: the wrapper terminates then kills its process
group, and the helper kills its synchronous child directly.

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
executable code. Inspect a potentially hostile branch from a separate trusted
checkout rather than invoking that branch's package scripts.

For a runtime-changing PR, run the clean, detached wrapper and compatible MJS
helper from the last independently reviewed pre-change commit while the current
directory remains the reviewed checkout. Protected main is acceptable only when
its helper still supports the current bundle protocol:

```bash
reviewed_checkout=/absolute/path/to/reviewed-checkout
trusted_checkout=/absolute/path/to/trusted-pre-change-checkout
bundle_parent=/tmp/autoreview-runtime-review
mkdir -p "$bundle_parent"
(
  cd "$reviewed_checkout"
  AUTOREVIEW_HELPER="$trusted_checkout/scripts/agent-autoreview.mjs" \
    "$trusted_checkout/scripts/agent-autoreview.sh" \
    --prepare-bundle-dir "$bundle_parent/context-bundle" \
    --mode auto --base origin/main --feedback-pr <number>
)
"$trusted_checkout/scripts/agent-autoreview.sh" \
  --verify-bundle-dir "$bundle_parent/context-bundle"
```

Use that same trusted wrapper for `--expected-bundle-manifest` after the review.
Never point `trusted_checkout` at the runtime-changing checkout.

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
gate self-test, and the advisory ADR reminder also always re-run.

Each mapped command has a watchdog (default 900 seconds; override with
`--command-timeout <n>` or `AGENT_QUALITY_COMMAND_TIMEOUT_SECONDS`). On timeout
it TERM→KILLs the process tree, reports
`Command timed out after <n>s: <command>`, and logs durations status `fail`. A
self-daemonizing child can escape the tree (none do). The timeout never bounds
the whole run.

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

## Common local-gate traps

- `codespell` flags short variable names that match common abbreviations (e.g. a two-letter loop var that looks like a misspelling). Use descriptive names like `netData` to avoid this.
- `trunk check <file>` only checks the specified files. That is fine for the path-aware local agent gate, but use `--all` when you need to manually reproduce CI's full-repo Trunk job.
- If `indexer-envio typecheck` fails with "Cannot find module 'generated'", run `./scripts/setup.sh` first
