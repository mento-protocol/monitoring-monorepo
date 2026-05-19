# Backlog

Active work only. Remove items from this file once they ship or are closed.
Durable lessons belong in `AGENTS.md`, `docs/pr-checklists/`, `docs/notes/`,
or tests.

## CDP indexer: deploy + resync to land the schema/handler fixes

Two indexer-side changes are in code waiting for a single resync to land:

1. **`LiquityInstance.systemDebt` derivation** — `applySystemDebtDelta` in
   `indexer-envio/src/handlers/liquity/troves.ts` runs in every trove handler
   (`TroveOperation`, `TroveUpdated`, `BatchUpdated`, plus the loop in
   `reclassifyTrovesForLoadedParams`). The pool-event summation in
   `pools.ts:updatePoolGauge` no longer sets `systemDebt` (it would clobber
   the delta-tracked value on the first DefaultPool event post-resync).
2. **Rebalance-redemption split** — PR #31 in `mento-protocol/bold` added
   `redeemCollateralRebalancing` which fires identical `Redemption` events
   to user redemptions; on Celo today ALL 368 GBPm + 13 JPYm redemptions are
   rebalance-driven. New schema fields on `LiquityInstance` /
   `LiquityInstanceSnapshot` / `LiquityInstanceDailySnapshot`:
   `rebalanceRedemption{Count,Debt,Fee}Cum` plus matching hour/day buckets,
   and `RedemptionEvent.isRebalance: Boolean!`. Discriminator:
   `event.transaction.to == cdpLiquidityStrategy` (single shared strategy
   `0x4e78bd9565341eabe99cdc024acb044d9bdcb985` on Celo). Totals
   (`redemption*Cum`) still increment for every redemption — the rebalance
   subset is added on top, so user-driven = total − rebalance.

What's left:

- [ ] **Deploy the indexer code** (`/deploy-indexer`). Schema added required
      fields, so this requires a full resync — codegen + redeploy + sync
      from genesis. No way to forward-only this.
- [ ] **Promote to prod** after resync completes and Hasura schema reflects
      the new fields.
- [ ] **Delete the dashboard `systemDebt` workaround** in
      `ui-dashboard/src/app/cdps/_lib/health.ts` / `cdps-page-client.tsx` /
      `cdp-detail-client.tsx` / `lib/queries/liquity.ts`. Drop the `Trove {
id collateralId status debt coll }` selection from `CDP_MARKETS`, stop
      calling `aggregateTroves`, read `instance.systemDebt` directly. Keep
      `aggregateTroves` for the borrower count — `activeTroveCount` still
      excludes zombies (that's a separate indexer-side gap; consider adding
      an `openTroveCount` field maintained alongside `activeTroveCount` in
      the same delta path).
- [ ] **Surface rebalance vs user redemption split** in the dashboard once
      Hasura returns the new fields. Existing UI shows nothing about
      redemptions, but Total / Rebalance / User KPI tiles or a stacked
      time-series in the CDP detail page would be the natural next surface.

## CDP glue contracts: state mutations without events (NICE TO KNOW)

From the mento-core + deployments-v2 sweep on 2026-05-19:

- `CDPLiquidityStrategy.setCDPConfig(pool, CDPConfig)` lets governance rotate
  `stabilityPool` / `collateralRegistry` / `stabilityPoolPercentage` /
  `maxIterations` post-add with no event. Our `CdpPool` row doesn't store
  these fields today, so silent rotation is invisible. If we ever surface
  any of them, re-read `getCDPConfig(pool)` via `eth_call` on
  `PoolAdded`/`LiquidityMoved` or ask mento-core for a `CDPConfigSet` event.
- `ReserveTroveFactory.withdraw(token, recipient)` is owner-only and silent.
  Pulls accumulated debt/coll tokens (factory holds `ETH_GAS_COMPENSATION`
  refunds from each `createReserveTrove`). Re-derivable from ERC20 Transfer
  logs if we ever need it.

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

### Lighthouse CI Follow-Ups

The initial Lighthouse CI gate landed in PR #451 with desktop performance + accessibility budgets. Remaining work to graduate it from advisory to fully-trusted:

- [ ] **Architect a reliable Vercel deployment-protection bypass for lhci.** PR #451 shipped with bypass-via-header, but lhci's puppeteer-launched Chrome appears to redirect to the Vercel SSO interstitial despite the `x-vercel-protection-bypass` header — verified empirically (lhci audited `vercel.com/login?next=...` URLs instead of the dashboard). The query-param form works but embeds the secret in the publicly-readable lhci report (`temporary-public-storage`). Options to evaluate: (a) configure Vercel project to disable preview protection (Vercel project setting, may need governance approval); (b) gate the secret-bearing audit to a separate `workflow_run`-triggered job that runs from trusted base ref; (c) deploy a CDN-fronted preview alias that's unprotected for crawlers but auth-gated for browsers; (d) self-host lhci on a runner that talks to Vercel's API directly and uses a different auth flow. Once a reliable bypass lands, **promote accessibility from `warn` to `error` in `.lighthouserc.cjs`** so regressions block.
- [ ] Promote performance budgets from `warn` to `error` in `.lighthouserc.cjs` once 5+ stable runs and a representative percentile distribution are collected. Drop the budget to the post-distribution floor with conservative headroom and confirm the gate doesn't flake on CI runner load variance. Depends on the bypass mechanism above — performance numbers from the SSO interstitial are not meaningful.
- [ ] Add INP (interaction-to-next-paint) coverage via lhci's user-flow mode with scripted interactions on the dashboard pages. Lighthouse's default navigation mode never produces an INP numeric value, so the budget was intentionally omitted in PR #451 to avoid silent-pass false confidence. User-flow mode would script the typical "open page, hover a chart, click a filter" interaction and run an INP audit on the scripted timespan.

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
- [x] Produce a short recommendation PR: either implement the low-noise hardening
      directly, or document why the existing controls are sufficient for now.
      → Done: `scripts/lockfile-lint.mjs` + `supply-chain.yml` lockfile-lint job.
      Validates sha512 integrity on all lockfile packages + blocks custom registry
      overrides. Note: `lockfile-lint` npm package doesn't support pnpm v9 format
      (no `resolved:` URLs); check is a custom zero-dep Node.js script instead.

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
