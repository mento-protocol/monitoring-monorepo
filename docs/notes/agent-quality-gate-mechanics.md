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
quality prerequisites: a browser setup failure still lets independent
lint/typecheck/unit/knip feedback run. `--fail-fast` stays sequential so it
still stops before starting the next mapped command.

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
The helper resolves a symbolic branch base or commit target once to an immutable
object ID, fingerprints the symbolic branch or detached state, `HEAD`,
staged/unstaged bytes, and untracked file or symlink state, and fails if that
source changes during bundle construction or semantic review. The repo adapter
also removes reviewed-repo directories from its executable search path and
resolves Git/GitHub CLI targets outside the worktree before capture. Prepared
repo-context bundles apply the same before/after fingerprint while every
artifact remains in an adjacent ephemeral directory, then publish the complete
bundle with one rename only after validation passes. The published
`helper-output.txt` reports the final prompt/pass paths, never the discarded
staging directory.

Semantic Codex and Claude passes run from an empty temporary workspace with
repo/project instructions, hooks, plugins, and inherited environment restricted
to the review contract. Reviewer credentials remain available only to launch
the selected engine; repository tooling and unrelated environment state do not.
For Claude/Bedrock this includes standard AWS web-identity, container, profile,
and shared-file credential-chain locators. Credential/config file variables are
canonicalized to existing regular files outside the reviewed repository; a
repo-contained path fails closed before Claude starts.
Direct supplemental-evidence paths must be repo-relative, regular UTF-8 files
confined to the worktree. The narrow trusted exception is the adapter-generated
`pr:feedback-state` dataset inside its prepared-bundle directory. Sensitive
paths, credential-like content, private keys, and secret-bearing URLs fail
closed before any prepared-bundle artifact is published or review input is sent
to a semantic engine. A quiet semantic reviewer emits a progress heartbeat
every 60 seconds.

Inside an active Codex sandbox, and only when no engine was selected explicitly,
the adapter defaults to the helper's local deterministic engine because nested
`codex exec` is unavailable there. An explicit engine selection through
`--engine codex`, `--engine claude`, or `AUTOREVIEW_ENGINE` takes precedence
and fails closed if that engine is unavailable; it never silently falls back.
Set `AUTOREVIEW_HELPER` only when intentionally testing or replacing the
pinned repo helper with a compatible implementation of its CLI contract.
Prepared-bundle replacements must support `--source-snapshot-only` plus the
helper's bundle-output and trusted-input flags. The old autoreview
`--parallel-tests` path is removed: the mapped quality gate owns test execution
and isolation.

For a true Codex semantic pass from inside Codex, prepare a repo-context bundle
and pass that bundle to a fresh-context reviewer:

```bash
pnpm agent:autoreview --prepare-bundle-dir /tmp/autoreview-bundle
```

Use a directory outside the repo worktree so local-mode bundles do not include
their own generated files. The bundle contains changed paths, patch files,
repo-selected checklist/prompt context, and the helper's
`autoreview-prompt.md`. Add
`--feedback-pr <number>` to include the current `pr:feedback-state` ledger as a
review dataset for feedback-fix batches. Prepared-bundle mode owns that prompt
path, so do not combine `--prepare-bundle-dir` with `--bundle-output`.

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
