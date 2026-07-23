---
title: Agent Quality Gate — Mechanics
status: active
owner: eng
canonical: true
last_verified: 2026-07-22
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Agent Quality Gate — Mechanics

This runbook owns the invocation contract and the mechanics behind it: how the
gate maps paths to commands, its parallelism and caching behavior, and the
package-script refusal guard. Root `AGENTS.md` keeps only the mandatory trigger
and routes here.

## Invocation contract

Before opening or updating an agent-authored PR:

```bash
pnpm agent:quality-gate          # inspect mapped commands and checklists
pnpm agent:quality-gate --run    # execute the safe local mapped commands
pnpm agent:autoreview            # required for a non-trivial completed batch
pnpm agent:autoreview:test -- --jobs 1  # sequential full regression closeout for autoreview runtime changes
```

The gate is local-only and never deploys or runs Terraform apply. Do not assume
the pre-push hook is installed; run the gate explicitly.

`pnpm agent:autoreview` performs source review and never runs tests.
`pnpm agent:autoreview:test` is the canonical command boundary for the complete
autoreview regression harness. It defaults to at most three independent family
workers and emits bounded family-start/heartbeat progress plus per-family
completion timings, so a long adversarial case does not look hung. The mapped
local quality gate invokes this package command and preserves those progress
and timing lines. For deterministic autoreview-runtime closeout, pass
`-- --jobs 1`; this changes scheduling only and keeps the same full family
coverage. The path-filtered `Autoreview adversarial suite` job runs that same
complete family set sequentially on `ubuntu-latest` whenever autoreview runtime
or fixture inputs change. The required `ci` sentinel allows the job to skip for
unrelated paths and requires it to pass whenever the path filter selects it.

Agent sessions must run `--run` gate invocations and `git push` as background
tasks: foreground commands are killed at 600s, and a killed run writes no
freshness stamp, so the next invocation re-runs the full mapped command set
instead of hitting `--skip-if-fresh`.

`--run` appends one JSON line per mapped command (plus one `__run_total__`
summary line per invocation) to `.tmp/agent-quality-gate/durations.jsonl`, a
gitignored scratch file, for local wall-clock tracking. Budget targets: the
common-case mapped set should finish in 3 minutes or less; the full workspace
suite in 8 minutes or less. Treat a durations regression against these targets
like any other perf regression (Refs #1415).

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

The gate defaults to dry-run mode and maps changed paths to the package checks
and PR checklists that apply. Review the checklist output, then run the mapped
safe local commands with:

```bash
pnpm agent:quality-gate --run
```

The execution mode is intentionally local-only: lint, typecheck, tests, codegen,
Trunk, and formatting/validation commands. It never runs deploy commands or
Terraform apply. Terraform formatting receives an explicit Git-visible source
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
`scripts.issue:release`, `scripts.sentry:ingest`,
`scripts.sentry:ingest:test`, `scripts.docs:index`, `scripts.docs:index:test`,
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
regression tests instead of the package-script refusal path. Existing changed paths run
targeted Trunk checks for faster local iteration. Deleted paths,
Trunk/tooling changes, package-manager changes, pnpm patches, and
package-manifest changes still run full-repo Trunk locally. CI also runs a
required full-repo Trunk check on every
PR. Normal `--run` mode executes independent quality-phase commands with
bounded parallelism (`--parallel <n>`, default `auto` capped at 4 workers, or
`AGENT_QUALITY_PARALLELISM`). Preflight, codegen, post-codegen install,
Terraform init/validate chains, and shared-config build setup remain ordered
prerequisites. Playwright browser install, dashboard `test:browser`, and
build-backed `size-limit` stay serialized with each other, but are not global
quality prerequisites. The quality-gate self-test is also serialized before the
parallel pool because it temporarily mutates tracked fixture files; this keeps
source-fingerprinting tests such as autoreview from observing synthetic drift.
A browser setup failure still lets independent lint/typecheck/unit/knip
feedback run. `--fail-fast` stays sequential so it still stops before starting
the next mapped command.

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

### Scoped local test runs (Refs #1413)

A per-package quality bundle normally runs `pnpm --filter <pkg> test:coverage`
(the package's full suite plus its coverage floor). Locally, when a package's
changed paths are a small set of production source files, the gate narrows that
one command to `pnpm --filter <pkg> exec vitest related --run <files>` so an
agent only pays for the tests reaching its edit. The reason string carries
`(scoped-tests)` so the substitution is visible in dry-run output. This is a
local-signal optimization only: CI still runs the full `test:coverage` coverage
floors, so scoping never changes what gets enforced — it only trims the local
feedback loop.

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

Do not launch dashboard browser tests, a dashboard dev server, or another
quality-gate run concurrently with `pnpm agent:quality-gate --run` in the same
worktree. Browser tests serve a fixture production build (`.next-fixture`) via
`next start` rather than `next dev`, but their `next build` and size-limit's
`next build` both rewrite the tracked `next-env.d.ts`, and a stray dev server
still writes `ui-dashboard/.next`; competing writers can produce false
`Another next dev server is already running` or `ChunkLoadError` failures. The gate also schedules coverage alongside other
independent checks, so an extra ad hoc coverage run only adds load and can turn
normally passing accessibility tests into timeout noise. Run focused tests
before the gate, then let one gate invocation own the full mapped batch.

For non-trivial behavioral, workflow, security, data-flow, or UI batches, run
the structured closeout review after the mapped gate and before pushing:

```bash
pnpm agent:autoreview
```

Use it as a batch-boundary verifier. Verify every accepted finding in the real
code before editing, rerun focused checks after review-triggered fixes, and
rerun autoreview for the fixed batch. Freeze the initial request, target/owner,
changed-file set, and non-test changed-line count as the scope baseline before
the first pass. Classify proposed additions as in-scope, follow-up, or stop;
create an issue before deferring a valid follow-up, warn when non-test scope
approaches twice the baseline, and pause for reclassification after two
review-triggered patch cycles instead of starting a third automatically.

**Stage timing and gh-lookup deadlines.** Both the wrapper and the helper
append one best-effort JSON line per stage (`target-selection`, `bundle-prep`,
`engine-invocation` from the helper; `prepare-bundle`, `verification` from the
wrapper) to `.tmp/agent-autoreview/durations.jsonl` (gitignored), each shaped
`{"ts","stage","seconds","mode"}`. `AGENT_AUTOREVIEW_DURATIONS_DIR` overrides
that directory; `AGENT_AUTOREVIEW_STAGE_SUMMARY` (any non-empty value) also
echoes a filterable `agent:autoreview: stage-timing ...` line per stage to
stderr — off by default so it never violates the reviewer-cleanliness stderr
contract. Logging failure never aborts or fails a run. Automatic `gh`-based PR
lookups for base-branch detection and `--feedback-pr auto` resolution are
bounded by `AGENT_AUTOREVIEW_GH_DEADLINE_SECONDS` (default 60s); the separate
multi-call PR feedback capture is bounded by its own
`AGENT_AUTOREVIEW_FEEDBACK_DEADLINE_SECONDS` (default 120s, higher because it
runs several GitHub calls in one pass). Either way a hung `gh` process cannot
stall autoreview indefinitely; a lookup that exceeds its deadline fails closed
like any other lookup error. The wrapper's
own `gh`/subprocess deadlines (`run_with_deadline`) run the command in its own
process group and escalate `SIGTERM` then `SIGKILL` on timeout or on the
wrapper itself being interrupted; the helper's `gh` calls (`spawnSync`) use
`SIGKILL` directly, since a synchronous child-process call blocks until the
child actually exits and a `SIGTERM`-ignoring child would otherwise hang it
despite the timeout.

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
The direct helper and prepared-bundle adapter enforce one cumulative input
budget while capturing diffs, untracked files, checklists, and feedback, before
those bytes can accumulate in memory or staging sidecars.
For a real review, the helper resolves a symbolic branch base or commit target
once to an immutable object ID. Direct `--dry-run` instead reports the requested
ref without resolving or freezing it. Source fingerprints cover the symbolic
branch or detached state, `HEAD`, and staged/unstaged bytes. They include
untracked file or symlink state only when local working-tree content is part of
the selected target (`local` or the adapter's branch-local target); explicit
branch and commit snapshots ignore unrelated untracked files. The repo adapter
first brackets target selection with a lightweight `HEAD`/branch/status
fingerprint, so concurrent dirty-state or checkout changes still fail closed
without reading untracked file contents. After the target is frozen, explicit
branch and commit reviews use only the target-scoped source fingerprint, so
unrelated untracked churn cannot invalidate them; automatic mode retains the
status guard because its selected target depends on clean/dirty state. Every
Git path collection uses NUL-delimited output, so enumeration does not depend
on Git quoting or newline splitting. Because the published changed-path and
prompt metadata are line-oriented, paths containing tabs or line breaks are
rejected before review; rename such a path before running autoreview. The
adapter also resolves `origin/main^{commit}` once to an independently protected
baseline and sources checklist policy only from that pinned object ID in every
target mode.
Checklist edits in a local target, PR-selected base, current head, or selected
commit stay visible as diff evidence but cannot rewrite the policy used to
review themselves. The adapter also
requires the current shell adapter's bytes and executable mode to match frozen
`HEAD`. In every target mode it requires the shell, MJS helper, and core at that
frozen `HEAD` to match the pinned protected-main object, then executes MJS files
materialized from that protected object instead of a PR-selected base or
mutable worktree. Commit mode also requires the selected commit's executable
runtime to match the protected baseline. Local and branch-local prepared
bundles require helper/core worktree bytes to match frozen `HEAD`. Any dirty or
committed runtime change fails closed and must be reviewed from a separate
trusted checkout with an explicit compatible `AUTOREVIEW_HELPER`. Direct
default-helper execution in the owning checkout uses the same frozen-HEAD and
protected-main checks and materialized MJS runtime. Wrapper-owned Node launches,
including executable discovery and validation helpers, discard `NODE_OPTIONS`
and `NODE_PATH`, plus dynamic-loader and interpreter startup-injection
variables, so ambient hooks cannot run before the pinned helper. An explicit
helper from a separate checkout remains an explicit trust decision. The adapter
also requires the physical checkout root to match Git's top level, removes
reviewed-repo directories from its executable search path, and runs bare shell
utilities from the system path. Direct Git, Node, GitHub CLI, and semantic-engine
executables and every canonical ancestor must be owned by the current user or
root and must not be group/other-writable. On Darwin, Homebrew-style paths that
fail only that ancestry rule are accepted solely through sealed private
snapshots of native Mach-O executables whose linked-library closure is entirely
system-only. On Linux, and only for a root-run wrapper, an otherwise
path-untrusted Node may be recovered only when its inode matches a live wrapper
ancestor across an uninterrupted all-root UID chain; this includes root- or
foreign-owned writable/hard-linked toolcache layouts, while set-ID semantics
remain forbidden. Direct helper invocation receives no runtime exception. The
wrapper copies bytes from the bound `/proc/<pid>/exe` descriptor into a
root-owned `0500`, single-link snapshot, then re-hashes both the ancestor and
candidate descriptors before launch. Bounded ELF parsing
rejects unsafe interpreters, RPATH/RUNPATH and loader-injection tags, and
path-qualified dependencies. The glibc-only fallback recursively resolves every
static `DT_NEEDED` name to a root-owned, non-writable target, publishes those
names through a private `0700` alias directory, and launches with that exact
controlled `LD_LIBRARY_PATH`; `/etc/ld.so.preload` must remain absent. The
helper reproduces the wrapper-sealed loader path/symlink/stat/content
fingerprint and validates the handed-off current snapshot, sealed manifest,
loader, alias names, targets, and ancestry before and after semantic-engine
launches. This exception trusts the
UID-0 wrapper/runtime and covers the static startup closure, not later
application-level `dlopen`, provider, or plugin loads. Scripts and native
executables with relative or non-system library closure fail closed. Node
discovery never executes a version-manager
shim: Volta is queried through a sealed native `volta which node`, and the
returned Node path is revalidated before launch. Git invocations ignore
inherited repository-routing variables such as `GIT_DIR` and
`GIT_WORK_TREE`.

The required `autoreview-root-runtime` CI job is the focused Linux/root proof.
It selects the repository's Node version through Blacksmith's x64
`/opt/hostedtoolcache` layout, launches that exact runtime through `sudo` and a
minimal `env -i`, and requires the target-guard suite to observe the sealed
snapshot rather than silently taking the ordinary trusted-path branch. The job
does not install workspace dependencies or run the full autoreview suite. Its
test-only diagnostic switch retains only the deepest allowlisted trust stage,
prints that one stage if Node resolution fails, and is unset before the helper
or semantic engine starts; normal invocations keep the generic trusted-Node
error.

Prepared repo-context bundles apply the same target-scoped
before/after fingerprint while every artifact remains in an adjacent ephemeral
directory. The destination parent's canonical inode and the freshly created
staging directory's `dev:ino` are pinned before content generation. After
the wrapper stages its evidence, it manifests that evidence before and after
the helper runs, excluding only the helper-owned prompt and metadata outputs.
After prompt validation, the adapter also hashes the complete staged evidence
before and after the final helper source-fingerprint call. It rejects symlinks,
special files, externally linked regular files, and any identity or content
change. The
validated Node runtime exclusively reserves the destination, rechecks the
staging identity throughout transfer, and verifies the same manifest after
transfer and again immediately before hard-linking
`.agent-autoreview-complete` last. That marker contains the manifest digest;
`pnpm agent:autoreview --verify-bundle-dir <dir>` reopens every file without
following symlinks and checks the marker plus manifest. Run it immediately
before reading every pass and retain its printed digest outside the bundle;
after review, pass that digest back with
`--expected-bundle-manifest <retained-digest>` so replacing the bundle and its
marker cannot reset the second check. A destination created during the final
race window is never replaced; an interrupted or unverified bundle must not be
reviewed. Failures before an explicit helper runs, plus failures from the
wrapper-attested default helper runtime, receive pinned-identity cleanup. The
adapter atomically moves the candidate into a random adjacent quarantine, opens
the moved directory without following symlinks, verifies its recorded
`dev:ino`, and pins that inode with `fchdir` before recursive deletion. Later
pathname cleanup is non-recursive and fails closed on identity drift. Once an
explicit `AUTOREVIEW_HELPER` has run, however, the adapter retains failed
staging without recursive deletion: an unattested helper may leave a same-UID
writer that can substitute child directories even beneath a descriptor-pinned
root. Canonical secret-scan failures use the attested helper and therefore do
not leave raw diff sidecars behind. It cleans up its private marker while its
inode still
matches, but never recursively deletes a failed destination reservation;
inspect and remove an incomplete, unmarked destination before retrying. The
mutable repo helper is not re-entered for publication. The published
`helper-output.txt` reports the final prompt/pass paths, never the discarded
staging directory. A detached producing wrapper can verify the bundle from a
non-Git working directory. On macOS, preparation, publication, and verification
also reject write-granting extended ACLs on every canonical parent ancestor and
bundle entry; those ACL checks bracket evidence hashing.
Prepared bundles reject `--dry-run`: publication requires completed content
validation and the main prompt plus every strictly ordered, deterministic
indexed bounded pass. Prompt-index validation normalizes a UTF-8 BOM, CRLF line
endings, and leading blank lines before applying the strict pass-order and
companion-file checks, and rejects any undeclared extra pass file.
Direct `--bundle-output` publication uses an exclusive same-directory link and
refuses to replace any existing destination, including a file created during
the final publication race window. A failed multi-pass write therefore cannot
corrupt a previously valid index and its companions. Use a fresh output path or
deliberately remove the old set first.

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
one GitHub snapshot for the frozen diff and `feedback-state.json`. It
materializes the feedback-state Node runtime from the same pinned protected-main
object ID used for checklist policy, never from the PR-selected base, current
`HEAD`, or a selected commit's parent. Prepared-bundle generation fails closed
when that protected baseline is unavailable; feedback capture also fails when
its bounded regular runtime blobs are unavailable. It executes the pinned
runtime directly from the repo root with frozen canonical `--repo` routing; no
reviewed package script or pnpm lifecycle runs. Missing GitHub CLI, zero or
multiple matches, and malformed metadata fail closed. Before publication it
also verifies that the feedback ledger still names that PR, base branch, current
head branch, and frozen head object ID.
An explicit `--base` therefore requires an explicit `--feedback-pr` number
instead of `auto`. Commit-mode reviews also require an explicit feedback PR
number because the current branch's automatic PR cannot prove membership for an
arbitrary selected commit.

Semantic Codex and Claude passes run from an empty temporary workspace with
repo/project instructions, hooks, plugins, and inherited environment restricted
to the review contract. Reviewer credentials remain available only to launch
the selected engine; repository tooling and unrelated environment state do not.
For Claude/Bedrock this includes standard AWS web-identity and container
credential-chain inputs. Explicit `AWS_CONFIG_FILE` and
`AWS_SHARED_CREDENTIALS_FILE` locators opt into trusted static/profile files;
their private snapshots reject `credential_process`. When either locator is
absent, the helper supplies a private empty snapshot so the AWS SDK cannot fall
back implicitly to `~/.aws/config` or `~/.aws/credentials`; users who need
those files must set the locators explicitly. Claude's other file-valued cloud
credential/config locators, plus `SSL_CERT_FILE` for both Claude and Codex,
must resolve outside the reviewed repository to a root- or reviewer-owned
regular file with no shared-write mode, unsafe non-sticky ancestry, or
write-granting ACL. The helper opens each explicit source no-follow, revalidates
its identity and ancestry while copying it into a private per-run `0600`
snapshot, and passes only that snapshot to the selected engine. Snapshot files
are removed with the engine workspace during normal completion and partial
setup failure. On process interruption they are identity-checked and unlinked
before the bounded process-group termination path settles, so even an escaped
descendant holding
reviewer pipes cannot retain a credential path or block parent termination. An
untrusted or repo-contained source fails closed before the selected engine
starts. Semantic autoreview rejects non-empty `SSL_CERT_DIR` because a
directory of trust anchors loaded on demand cannot be frozen safely; unset it
or provide a trusted external PEM bundle through snapshotted `SSL_CERT_FILE`.
Closure of the direct engine leader triggers immediate `SIGKILL` for its
remaining process group before tracking or escalation timers are released,
including ordinary success and failure as well as timeout or interruption.
Direct supplemental-evidence paths must be repo-relative, regular UTF-8 files
confined to the worktree. The narrow trusted exceptions are adapter-generated
feedback state and protected-main checklist copies inside its
prepared-bundle directory. Sensitive paths,
credential-like content, private keys, wallet recovery phrases, Stripe live
keys, common Slack/Discord/Telegram webhook URLs, and secret-bearing URL query parameters
fail closed before any prepared-bundle artifact is published or review input is
sent to a semantic engine. Evidence reads reject symlinks and verify that the
opened descriptor still identifies the file that was inspected, closing
path-swap races. A quiet semantic reviewer emits a progress heartbeat every 60
seconds.

Inside an active Codex sandbox, and only when no engine was selected explicitly,
the adapter defaults to the helper's local deterministic engine because nested
`codex exec` is unavailable there. An explicit engine selection through
`--engine codex`, `--engine claude`, or `AUTOREVIEW_ENGINE` takes precedence
and fails closed if that engine is unavailable; it never silently falls back.
Set `AUTOREVIEW_HELPER` only when intentionally testing or replacing the
pinned repo helper with a compatible implementation of its CLI contract.
Prepared-bundle replacements receive only the final prompt handoff and must
support the helper's `--bundle-output`, `--bundle-output-display`, and
`--trusted-input-root` flags. Source fingerprints and untracked-file
serialization remain wrapper-owned operations executed by the attested helper;
a trusted wrapper physically outside the reviewed checkout copies its sibling helper/core no-follow into the
private command runtime and binds that snapshot to an identity plus full
content manifest before use. The source directory is descriptor-pinned across
both copies; its POSIX ancestry, source identities, and macOS ACLs are stable
and non-write-granting before and after the copy. This attestation also applies
when an explicit `AUTOREVIEW_HELPER` resolves to that external wrapper's own
default sibling helper, as in the runtime-review command below. In the owning checkout, an explicit override is
accepted only when the current shell wrapper matches pinned protected main and
compatible helper/core blobs can be materialized from that same protected
object. Otherwise the command fails closed with the separate-trusted-checkout
instruction used for runtime-changing reviews; a wrapper nested anywhere inside
the reviewed checkout is never treated as external. An explicit replacement cannot
run before wrapper-owned recursive cleanup is finished. After that handoff, the wrapper performs no recursive cleanup and
retains its command runtime plus failed staging because the replacement may
have left a same-UID writer. The old autoreview
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
other users' entries (for example `/tmp`), and macOS write-granting ACLs are
always rejected. The bundle
contains changed paths, patch files, repo-selected checklist/prompt context,
and the helper's
`autoreview-prompt.md`. Add
`--feedback-pr <number>` to include the current `pr:feedback-state` ledger as a
review dataset for feedback-fix batches. Prepared-bundle mode owns that prompt
path, so do not combine `--prepare-bundle-dir` with `--bundle-output`.
The generated README names the exact producing wrapper in both verification
commands; a runtime-changing review must not replace those commands with the
reviewed checkout's package script.
Retain the pre-review digest in reviewer state outside the bundle. After the
fresh-context reviewer has read every bounded pass, repeat
`--verify-bundle-dir` with that digest as `--expected-bundle-manifest`; both
checks must pass and must name the same digest. These checks detect persistent
drift and retain/revalidate every staged entry during each scan. They are not an
OS-level immutable filesystem against a malicious same-UID process that can
mutate and restore files between checks, so external helpers must leave no
background writer behind.

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
runbook, checklist, or skill context updates. It is advisory: it helps choose
review depth, but it does not replace `pnpm agent:quality-gate --run`,
`pnpm agent:autoreview`, or `pnpm pr:ready-state`.

To warm Turbo's local cache for the Turbo-backed package tasks mapped by the
same gate without running deploy, Terraform, mutation, codegen, or install
commands, use:

```bash
pnpm agent:prewarm --base origin/main
```

It is a no-op when the gate maps no relevant Turbo commands. Like the run mode
gate, prewarm refuses to execute Turbo-backed package scripts when package
manifests, lockfiles, `.npmrc`, pnpmfile, or `patches/**` changed unless you
first review the script/lifecycle diff and pass `--allow-package-script-changes`. Prewarm runs
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

An exact-signature success stamp is reusable for at most two hours. The
signature binds the fetched base object, mapped plan, gate implementation,
changed paths and validated content, plus package-risk state; any bound-input
change reruns the mapped commands immediately, and an unchanged stamp older
than two hours expires instead of masking drift.

Below the whole-run stamp, `--run` also keeps per-command success stamps
(`.tmp/agent-quality-gate/command-stamps.tsv`) so a run that was killed
mid-way, or that lost a single flaky check, resumes instead of restarting
(GitHub issue #1410). Each stamp records the exact same whole-run fingerprint
string, the command, and its completion time. When the whole-run fast-path skip
does not fire and execution begins, each mapped command is skipped (printed as
`↻ <command> (fresh from previous run)` and reported as `reused`, not executed)
only when a stamp exists whose fingerprint matches this run exactly, whose
command matches exactly, and whose age is within the same two-hour TTL. Every
other outcome — parse error, missing file, fingerprint mismatch, TTL expiry —
fails toward rerun. Because the fingerprint includes the content hash of every
changed file, ANY edit to a validated file invalidates every per-command stamp,
so reuse only helps the killed-run / single-flake case where content is
unchanged; that same invalidation, plus a start-of-run prune that drops
non-matching and expired entries, keeps the file bounded. Only
quality/serialized/parallel commands are stamped. Prerequisite phases
(install/codegen/quality-setup) always re-run: their outputs (node_modules,
generated code, built packages) are invisible to the source fingerprint, so a
stamp could skip them after their outputs were deleted. The Trunk check and
the gate self-test are also exempt and always re-run: they validate repo/gate
state cheaply and self-referentially. The ADR
reminder also re-runs every time, for a mechanical reason rather than an
exemption: its command string embeds the run's temporary changed-paths file
path, so its stamp key never matches a prior run (fail-safe — an advisory,
self-suppressing check that only ever over-runs).

Every mapped command runs under a per-command watchdog so no single check can
hang forever. A command that runs longer than the timeout (default 900 seconds,
override with `--command-timeout <n>` or `AGENT_QUALITY_COMMAND_TIMEOUT_SECONDS`)
has its process tree signalled (TERM, then KILL after a short grace; a
self-daemonizing child that reparents away from the tree can escape — no
mapped command does this) and
is reported as an ordinary failure — `Command timed out after <n>s: <command>`,
logged with status `fail` in the durations log. The timeout is strictly
per command; it never bounds the whole run.

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
local Turbo cache outside any worktree and a fresh per-PR worktree reuses warm
typecheck/lint/knip/build/size-limit entries instead of starting 100% cold. The
cache location is deliberately absent from the gate's freshness stamp: Turbo
restores a cache entry only when the entry's own content-addressed input hash
matches, so the cache directory changes a command's speed, never its pass/fail
outcome, and the `implementation_signature`/stamp machinery does not need to
fingerprint it. Editing this script does re-hash `implementation_signature` and
invalidate existing stamps once (expected). Turbo 2.9.x writes each cache
artifact via temp file + atomic rename with PID-namespaced temp names, so two
worktrees' gates writing the shared dir concurrently cannot corrupt it.

When `HOME` is unset or `$HOME/.cache/turbo-monitoring-monorepo` cannot be
created or written to — e.g. a sandboxed agent whose writable allowlist excludes
paths outside the repo — the gate leaves `TURBO_CACHE_DIR` unset and falls back
to Turbo's per-worktree default, so those runs stay cold and share nothing. The
`Turbo cache dir:` header line is printed only when the shared path is active;
its absence means the fallback (or the opt-out) is in effect.

The shared cache lives outside every worktree, so unlike the old per-worktree
`.turbo/cache` it is not reclaimed when a worktree is deleted. Turbo only reaps
its own orphaned `.tmp` files, never finished entries, so the directory grows
without bound as task hashes accumulate. It is pure cache — delete it any time to
reclaim disk and Turbo repopulates on the next run: `rm -rf
"$HOME/.cache/turbo-monitoring-monorepo"`. Refs GitHub issue 1411.

## Common local-gate traps

- `codespell` flags short variable names that match common abbreviations (e.g. a two-letter loop var that looks like a misspelling). Use descriptive names like `netData` to avoid this.
- `trunk check <file>` only checks the specified files. That is fine for the path-aware local agent gate, but use `--all` when you need to manually reproduce CI's full-repo Trunk job.
- If `indexer-envio typecheck` fails with "Cannot find module 'generated'", run `./scripts/setup.sh` first
