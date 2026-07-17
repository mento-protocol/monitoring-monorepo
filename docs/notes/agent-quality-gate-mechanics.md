---
title: Agent Quality Gate — Mechanics
status: active
owner: eng
canonical: true
last_verified: 2026-07-06
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
---

# Agent Quality Gate — Mechanics

The invocation contract (which commands to run, in what order, before opening
or updating an agent-authored PR) lives in the "Agent Quality Gate" section of
root `AGENTS.md`. This note holds the underlying mechanics: how the gate maps
paths to commands, its parallelism and caching behavior, and the package-script
refusal guard.

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
`scripts.agent:autoreview`, `scripts.issue:board`,
`scripts.issue:board:test`, `scripts.issue:claim`, `scripts.issue:review`,
`scripts.issue:release`, `scripts.sentry:ingest`,
`scripts.sentry:ingest:test`, `scripts.pr:feedback-state`,
`scripts.pr:feedback-state:test`, `scripts.pr:ready-state`,
`scripts.pr:ready-state:test`,
`scripts.tf`, `scripts.tf:test`, `scripts.alerts:rules:lint`,
`scripts.alerts:rules:lint:test`, `scripts.lockfile:lint`,
`scripts.lockfile:lint:test`, `scripts.skew:check`,
`scripts.skew:check:test`, `scripts.sanitize:test`,
`scripts.override:prune-report`, or `scripts.override:prune-report:test`; the gate treats that
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
rerun autoreview once for that fixed batch. This adapter uses the repo-local
helper at `scripts/agent-autoreview.mjs` by default and does not replace the
final PR readiness probe. Inside an active Codex sandbox, the adapter defaults
to the helper's local deterministic engine because nested `codex exec` is unavailable there;
pass `--engine codex`, `--engine claude`, or `AUTOREVIEW_ENGINE` to override.
Set `AUTOREVIEW_HELPER` only when intentionally testing or replacing the pinned
repo helper.

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
review dataset for feedback-fix batches.

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
