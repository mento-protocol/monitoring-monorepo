# Backlog

Active work only. Remove items from this file once they ship or are closed.
Durable lessons belong in `AGENTS.md`, `docs/pr-checklists/`, `docs/notes/`,
or tests.

## Thoughtworks Technology Radar Follow-Ups

Source plan: `projects/mento-v3-monitoring/technology-radar-evaluation-plan.md`.
DORA metrics and Dev Containers remain intentionally excluded. CodeScene is covered
through the OSS quality-check follow-ups below rather than by adopting the
commercial product.

### `mise` Toolchain Management Trial

Why: tool versions are currently spread across `.node-version`,
`packageManager`, Trunk runtimes, README/setup docs, and Terraform config.
`mise` is only worth adding if it reduces setup drift for fresh worktrees and
agent sessions.

- [ ] Inventory current version sources for Node, pnpm, Terraform, Python, Trunk, and setup scripts.
- [ ] Draft a minimal `mise.toml` for the tools where version drift actually hurts.
- [ ] Test fresh-shell setup: `mise install`, `pnpm install`, codegen, typecheck, and tests.
- [ ] Decide whether `mise` is canonical or optional convenience.
- [ ] If canonical, update docs and remove/clarify duplicate version declarations where safe.

Acceptance: setup becomes simpler than today. Reject if it just adds another
version source of truth.

### CodeScene-Equivalent OSS Quality Checks — Remaining Follow-Ups

The 5-PR rollout (#422/#423/#424/#425/#426) shipped knip, dependency-cruiser,
ESLint complexity budgets (diff-aware baseline), jscpd duplication detection,
the code-health history report, and `indexer-envio` `no-unsafe-*`. See
`AGENTS.md` "Code health budgets" and `docs/pr-checklists/code-health.md` for
the landed mechanism + severities.

- [ ] Promote dashboard + indexer mutation gates from advisory (`break: null`) to PR-blocking once the same "runtime + noise sane in CI" + survivor-triage evidence we collected for bridge in PR 436 is captured for each. Pattern: trigger the workflow manually on `main`, confirm runtime ≤ 1 min, triage every survivor (add tests for real gaps; classify equivalents in `docs/mutation-testing.md`), then flip `break` to the post-triage rounded floor with a 2-pt margin, and add a new always-runs job (with inline `filter` + `decide` + `continue-on-error` shape) for that package — NOT a workflow-level `pull_request.paths` filter, since required-status checks must keep the trigger unfiltered (see `AGENTS.md`).
- [ ] Enable `noUncheckedIndexedAccess: true` on `ui-dashboard/tsconfig.json`. The strict-TS PR turned it on for `shared-config`, `indexer-envio`, and `metrics-bridge` (each was clean or near-clean); dashboard had **355 typecheck errors** so it was deferred. Fix incrementally — start with `lib/**` (pure logic), then `hooks/**`, then `components/**`. Pattern: wrap `arr[i]` accesses in explicit guards, or use destructuring with `??` defaults. Some sites genuinely need a re-think of the iteration shape rather than a null-check.
- [ ] Enable `exactOptionalPropertyTypes: true` on `indexer-envio`, `metrics-bridge`, and `ui-dashboard`. The flag is already on for `shared-config` (PR #443). `indexer-envio` already has a dry-run file (`tsconfig.strict-dry-run.json`) with the flag — run `tsc -p tsconfig.strict-dry-run.json --noEmit` to see current error count before committing. Pattern: replace `{ key: val | undefined }` object literals with `...(val !== undefined && { key: val })` spread form; update optional-field types from `?: T` to `: T | undefined` where the value is always present but may be undefined. Start with `indexer-envio` (dry-run config already exists), then `metrics-bridge`, then `ui-dashboard`.

### Package-Manager Supply-Chain Hardening Review

Why: the TanStack npm compromise shows that provenance and trusted publishing are
not enough when a release pipeline restores poisoned package-manager cache
contents. This repo already has useful defenses: minimumReleaseAge: 4320,
onlyBuiltDependencies, high+ pnpm audit, SHA-pinned CI install actions in the
shared install action, and a dedicated supply-chain workflow. The next step is a
targeted review, not a blind pnpm major bump.

- [ ] Compare current pnpm 10 protections with pnpm 11 security features and
      migration risk for this monorepo.
- [ ] Audit GitHub workflows for pull_request_target, writable token
      permissions, package-manager caches restored before untrusted code runs,
      and unpinned third-party actions; include .github/actions/pnpm-install
      and .github/workflows/supply-chain.yml.
- [ ] Decide whether minimumReleaseAge, minimumReleaseAgeExclude,
      onlyBuiltDependencies, and ignoredBuiltDependencies need tighter docs,
      tests, or policy checks.
- [ ] Evaluate whether an external package firewall or advisory service
      (Socket, Snyk, or equivalent) adds real signal beyond current pnpm audit
      without turning every lockfile refresh into noise.
- [ ] Produce a short recommendation PR: either implement the low-noise hardening
      directly, or document why the existing controls are sufficient for now.

Acceptance: any implementation must preserve CI stability, keep frozen-lockfile
installs fast, and include a rollback path. Reject pnpm 11 or third-party
scanners if the only benefit is theoretical.

## File Size And Lint Hygiene

Current line counts for remaining watch files were refreshed on 2026-05-11.
`raw` is physical lines; `rough` approximates the ESLint `max-lines` count
after skipping blanks and comments. Refresh before starting a split.

| Raw | Rough | File                                            | Action                                                                                   |
| --: | ----: | ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 749 |   542 | `indexer-envio/src/rpc/effects.ts`              | Watch; split if adding another effect family.                                            |
| 731 |   496 | `ui-dashboard/src/lib/network-fetcher/fetch.ts` | Watch; split fetch orchestration if another network-wide data source lands.              |
| 689 |   418 | `indexer-envio/src/handlers/sortedOracles.ts`   | Watch; split only with related oracle-handler work.                                      |
| 627 |   330 | `ui-dashboard/src/lib/leaderboard-hero.ts`      | Watch; split if hero KPI fallback or overlap logic grows again.                          |
| 608 |   464 | `ui-dashboard/src/lib/queries/leaderboard.ts`   | Watch; split leaderboard GraphQL fragments/queries if another leaderboard surface lands. |

## Envio v3 Migration Follow-Ups

- [ ] **Pin `envio` to stable `^3.0.0` once released.** The migration currently targets `3.0.0-rc.0`; after the stable release, bump the dependency, regenerate code, and rerun codegen/typecheck/tests to catch API drift.
- [ ] **Validate the Envio v3 backfill speedup against production sync time.** Baseline before the migration was roughly 15-40 minutes per push. After deploy, compare wall-clock from indexer deploy to caught-up sync and decide whether the medium-tier cache upgrade can remain deferred.
