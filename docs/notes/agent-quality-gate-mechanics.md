---
title: Agent Quality Gate — Mechanics
status: active
owner: eng
canonical: true
last_verified: 2026-07-17
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
```

The gate is local-only and never deploys or runs Terraform apply. Do not assume
the pre-push hook is installed; run the gate explicitly.

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

The gate defaults to dry-run mode and maps changed paths to the package checks
and PR checklists that apply. Review the checklist output, then run the mapped
safe local commands with:

```bash
pnpm agent:quality-gate --run
```

The execution mode is intentionally local-only: lint, typecheck, tests, codegen,
Trunk, and formatting/validation commands. It never runs deploy commands or
Terraform apply. If any package manifest, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, `.npmrc`, pnpmfile, or `patches/**` file changed,
`--run` refuses to execute until you review package scripts/lifecycle hooks and pass
`--allow-package-script-changes`. The narrow exception is a root `package.json`
edit limited to root tooling scripts such as `scripts.agent:quality-gate`,
`scripts.agent:quality-gate:test`, `scripts.agent:prewarm`,
`scripts.agent:prewarm:test`, `scripts.agent:review-materiality`,
`scripts.agent:review-materiality:test`, `scripts.agent:context-check`,
`scripts.agent:context-budget`, `scripts.agent:context-budget:test`,
`scripts.agent:autoreview`, `scripts.issue:board`,
`scripts.issue:board:test`, `scripts.issue:claim`, `scripts.issue:review`,
`scripts.issue:release`, `scripts.sentry:ingest`,
`scripts.sentry:ingest:test`, `scripts.docs:index`, `scripts.docs:index:test`,
`scripts.docs:audit`, `scripts.docs:audit:test`, `scripts.docs:garden`,
`scripts.docs:garden:test`, `scripts.pr:feedback-state`,
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

QuickNode webhook state parsing has a dedicated fail-closed regression suite.
Changes to its shared parser, repair tool, shell test, or the listener
replacement provisioner map to
`bash alerts/infra/scripts/fix-webhook-state.test.sh`; the handler test suite
also executes that shell fixture in CI.

Do not launch dashboard browser tests, a dashboard dev server, or another
quality-gate run concurrently with `pnpm agent:quality-gate --run` in the same
worktree. Next processes share `ui-dashboard/.next`; competing writers can
produce false `Another next dev server is already running` or
`ChunkLoadError` failures. The gate also schedules coverage alongside other
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
status guard because its selected target depends on clean/dirty state. It also
resolves `origin/main^{commit}` once to an independently protected baseline and
sources checklist policy only from that pinned object ID in every target mode.
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
system-only. Scripts and native executables with relative or non-system
library closure fail closed. Node discovery never executes a version-manager
shim: Volta is queried through a sealed native `volta which node`, and the
returned Node path is revalidated before launch. Git invocations ignore
inherited repository-routing variables such as `GIT_DIR` and
`GIT_WORK_TREE`. Prepared repo-context bundles apply the same target-scoped
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
reviewed. Failure after an external helper sees the staging path leaves that
staging tree in place with a warning instead of recursively deleting a
potential replacement. The adapter cleans up its private marker while its inode
still matches, but never recursively deletes a failed destination reservation;
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
For Claude/Bedrock this includes standard AWS web-identity, container, profile,
and shared-file credential-chain locators. Claude's file-valued cloud
credential/config locators, plus `SSL_CERT_FILE` for both Claude and Codex, must
resolve outside the reviewed repository to a root- or reviewer-owned regular
file with no shared-write mode, unsafe non-sticky ancestry, or write-granting
ACL. The helper opens each source no-follow, revalidates its identity and
ancestry while copying it into a private per-run `0600` snapshot, and passes
only that snapshot to the selected engine. Snapshot files are removed with the
engine workspace during normal completion and partial setup failure. On process
interruption they are identity-checked and unlinked before the bounded
process-group termination path settles, so even an escaped descendant holding
reviewer pipes cannot retain a credential path or block parent termination. An
untrusted or repo-contained source fails closed before the selected engine
starts. Semantic autoreview rejects non-empty `SSL_CERT_DIR` because a
directory of trust anchors loaded on demand cannot be frozen safely; unset it
or provide a trusted external PEM bundle through snapshotted `SSL_CERT_FILE`.
Once timeout or interruption termination begins, closure of the direct engine
leader triggers immediate `SIGKILL` for its remaining process group before
tracking or escalation timers are released.
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
Prepared-bundle replacements must support `--source-snapshot-only`,
`--serialize-untracked-file`, plus the helper's `--bundle-output`,
`--bundle-output-display`, and
`--trusted-input-root` flags. For compatibility, the adapter invokes replacement
helpers with the bare `--source-snapshot-only` contract; target-mode snapshot
scoping is passed only to the pinned repo helper. The old autoreview
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
are unchanged. Because it runs in parallel rather than `--fail-fast`, a red
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
result.
Dashboard build/browser/React Doctor cache keys explicitly include
`shared-config`, package-manager, workflow, wrapper-script, and relevant env
inputs; CI still runs browser tests normally and remains the Linux snapshot
authority. The only task dependency is `size-limit -> build`, because
size-limit reads `.next/` output; the local gate relies on that dependency
instead of mapping a separate dashboard build command for size-limit checks.
High-risk or cross-layer commands stay outside Turbo, including codegen,
install, dep-cruiser, coverage floors, mutation baselines, and Terraform.

## Common local-gate traps

- `codespell` flags short variable names that match common abbreviations (e.g. a two-letter loop var that looks like a misspelling). Use descriptive names like `netData` to avoid this.
- `trunk check <file>` only checks the specified files. That is fine for the path-aware local agent gate, but use `--all` when you need to manually reproduce CI's full-repo Trunk job.
- If `indexer-envio typecheck` fails with "Cannot find module 'generated'", run `./scripts/setup.sh` first
