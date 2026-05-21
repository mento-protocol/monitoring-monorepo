# Backlog

Active work only. Remove items from this file once they ship or are closed.
Durable lessons belong in `AGENTS.md`, `docs/pr-checklists/`, `docs/notes/`,
or tests.

## CDP dashboard cleanup (indexer side already shipped)

Indexer-side `systemDebt` delta-tracking and the rebalance-redemption split
landed on prod at commit `026c629` (promoted 2026-05-20). Verified via
introspection against `https://indexer.hyperindex.xyz/2f3dd15/v1/graphql`:
`LiquityInstance.systemDebt` returns non-zero (cBRL 16.4M, cREAL 70K, GBPm
314K), and `RedemptionEvent.isRebalance` + the `rebalanceRedemption{Count,
Debt,Fee}Cum` buckets are populated (GBPm 367/368 rebalance-driven, JPYm
13/13).

Background on the indexer changes (kept here because the dashboard cleanup
below assumes them):

1. **`LiquityInstance.systemDebt` derivation** — `applySystemDebtDelta` in
   `indexer-envio/src/handlers/liquity/troves.ts` runs in every trove handler
   (`TroveOperation`, `TroveUpdated`, `BatchUpdated`, plus the loop in
   `reclassifyTrovesForLoadedParams`). `pools.ts:updatePoolGauge` no longer
   sets `systemDebt` (it would clobber the delta-tracked value on the first
   DefaultPool event).
2. **Rebalance-redemption split** — PR #31 in `mento-protocol/bold` added
   `redeemCollateralRebalancing` which fires identical `Redemption` events
   to user redemptions. Discriminator: `event.transaction.to ==
cdpLiquidityStrategy` (single shared strategy
   `0x4e78bd9565341eabe99cdc024acb044d9bdcb985` on Celo). Totals
   (`redemption*Cum`) still increment for every redemption — the rebalance
   subset is added on top, so user-driven = total − rebalance.

What's left (dashboard only):

- [ ] **Delete the dashboard `systemDebt` workaround** in
      `ui-dashboard/src/app/cdps/_lib/health.ts` / `cdps-page-client.tsx` /
      `cdp-detail-client.tsx` / `lib/queries/liquity.ts`. Drop the `Trove {
id collateralId status debt coll }` selection from `CDP_MARKETS`, stop
      calling `aggregateTroves`, read `instance.systemDebt` directly. Keep
      `aggregateTroves` for the borrower count — `activeTroveCount` still
      excludes zombies (that's a separate indexer-side gap; consider adding
      an `openTroveCount` field maintained alongside `activeTroveCount` in
      the same delta path).
- [ ] **Surface rebalance vs user redemption split** in the dashboard.
      Existing UI shows nothing about redemptions, but Total / Rebalance /
      User KPI tiles or a stacked time-series in the CDP detail page would
      be the natural next surface.
- [ ] **Replace `formatTokenAmount`'s `-1` sentinel for signed values.**
      `ui-dashboard/src/app/cdps/_lib/format.ts` treats `-1` as the
      "unknown" sentinel for unsigned counters, but with the new signed
      `collChange` / `debtChange` int256 deltas (PR #477) a hypothetical
      `-1 wei` withdrawal would render as `—` instead of the actual
      amount. Astronomically unlikely in practice, but the semantic
      collision worsens as the helper grows. Fix: split into
      `formatTokenAmount` (unsigned, keeps the sentinel) and
      `formatSignedWei` (signed, only guards `null`/`undefined`); migrate
      callers individually.

## Indexer relabel: mento-router-v2 / -v3 (next /deploy-indexer)

PR #513 (merged 2026-05-21) renamed the broker classifier's `mento-router-v2`
label to `mento-router-v3` for v3 router (`0x4861840…`) traffic, and added
the actual v2 router (`0xBE729350F8CdFC19DB6866e8579841188eE57f67`) to
`aggregators.json` as `mento-router-v2`. Indexer prod is still on commit
`026c629` (pre-rename), so existing `BrokerAggregatorDailySnapshot` rows
keep the old labels until the next indexer deploy + resync. No action
needed standalone — fold into the next `/deploy-indexer` cycle.

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

## Claude Code permissions hardening

- [ ] **Narrow `Bash(bash scripts/*)` in `.claude/settings.json`.** The blanket allow pre-approves production-changing scripts (`deploy-indexer.sh`, `deploy-indexer-promote.sh`, `deploy-dashboard.sh`, `deploy-bridge.sh`). Replace with a per-script allowlist that only covers safe read/test scripts; deploy/promote scripts should keep their permission prompt.
- [ ] **Remove or narrow `Bash(until *)`.** Pre-approves any shell loop whose first token is `until`, with arbitrary body. Replace with a specific polling-command allow or remove entirely.

## Intel marathon follow-ups (deferred from PR #488)

One item deferred from the May 2026 marathon PR review.

1. **URL-state for paginated UI surfaces** — `IntelTransfers` and
   `EntitySearch` keep `page` (and `EntitySearch`'s `query`) in
   `useState` only. Refresh / back-forward / bookmark-share all lose the
   current view. Internal-only tool so low priority, but the existing
   stateful-data UI checklist (`docs/pr-checklists/stateful-data-ui.md`)
   already covers the URL-as-state idiom.

## Discord → Slack alert migration: cutover + cleanup

Phase 1 (setup + dual-route) shipped in PRs #485 and #494. Both Aegis and v3 alert stacks are live in Grafana Cloud; every Aegis alert fires both Discord (legacy) and Slack (new) during the soak window. Splunk On-Call routing for `severity=page` is preserved and now also fires for prod trading-modes (newly-escalated). Weekend FX mute timing extended to every new Slack route.

### Soak verification (during the ≥5-day soak window)

- [ ] **Oracle-relayer warning on Celo prod** — confirm parity in Discord `#prod-oracle-relayers` AND Slack `#alerts-oracles`.
- [ ] **`severity=page` event** (oracle-relayers stale, trading-limits L1/LG, aegis service health, or trading-modes-prod circuit-breaker) — confirm Splunk On-Call still pages, `#alerts-critical` lights up, Discord side still fires.
- [ ] **FX-feed alert during Fri 21:00 – Sun 21:00 UTC** — confirm muted on Splunk + `#alerts-critical` + `#alerts-oracles` + `#alerts-testnet`. Easy to test on a weekend-disabled feed (e.g. CELOPHP, EURXOF).
- [ ] **celo-sepolia alert** — confirm it lands in `#alerts-testnet` only, NOT `#alerts-critical` or `#alerts-oracles`.
- [ ] **Daily catch-all sweep** — eyeball Discord `#alerts-catch-all` for any unmapped alerts. Anything that lands there is alert-config-drift signal worth fixing before cutover.

### Cutover PR (when soak shows clean parity, ≥5 days dual-routing without surprises)

Single-file change to `aegis/terraform/grafana-alerts/notification-policies.tf`. After this PR ships, Discord alerts stop firing entirely; Slack is the only delivery (plus Splunk for page-severity).

- [ ] Remove the 8 Discord-contact-point policy blocks (oracle-relayers staging/prod, reserve, trading-modes staging/prod, aegis, trading-limits).
- [ ] Flip root `contact_point` from `discord_channel_catch_all` → `grafana_contact_point.slack_alerts_infra`.
- [ ] Flip the 2 weekend-FX `continue = true` flags back to `false` (no Discord siblings left to chain into).
- [ ] Test plan mirrors the soak checks above, but with Discord channels now expected to be silent.

### Cleanup PR (final, immediately after cutover)

- [ ] Delete the 8 `discord_channel_*` contact-point resources from `aegis/terraform/grafana-alerts/contact-points.tf`.
- [ ] Delete `aegis/terraform/grafana-alerts/message-templates-discord.tf` (the consolidated bundle — its whole purpose was a stepping stone to free template quota; goes away when Discord retires).
- [ ] Delete `local.alert_config` dispatcher in `aegis/terraform/grafana-alerts/locals.tf`. Splunk already migrated to `alert_config_victorops`; only Discord references the original.
- [ ] Drop the 6 `discord_*_template` fields from each `alert_types` entry in `locals.tf` (Discord-named templates won't exist anymore).
- [ ] Remove the 8 `discord_alerts_webhook_url_*` variables from `aegis/terraform/grafana-alerts/variables.tf`, `aegis/terraform/variables.tf`, and `aegis/terraform/main.tf`.
- [ ] Drop the Discord webhook URLs from `aegis/terraform/terraform.tfvars` (manual; gitignored).
- [ ] Update docs: `aegis/README.md` lines 305–393 (replace Discord setup with Slack setup), root `AGENTS.md` (change "Discord contact points" → "Slack contact points" in the Aegis terraform description), `docs/BACKLOG.md` (drop this entire section), `docs/ROADMAP.md` (mark Aegis migration complete, remove dual-route notes).
- [ ] Archive (don't delete) the 8 Discord channels in the Discord server UI. Preserves incident archaeology.
- [ ] Confirm `DISCORD_BOT_TOKEN` GitHub Actions secret is deleted (was deleted earlier when the deploy-notification workflow retired; re-verify).
- [ ] Confirm no other repo references to Discord remain: `rg -i 'discord' aegis/ .github/ docs/ scripts/ AGENTS.md CLAUDE.md README.md` should be empty after this PR.

### Loose ends carried in from the migration session

- [ ] **`BLOB_READ_WRITE_TOKEN` lost `development` scope** during the unrelated root-stack apply on 2026-05-20. Production + preview were restored on 2026-05-21 via Vercel-API-driven store-project reconnect (after the broken token caused the daily address-labels-backup cron to fail; see [ANALYTICS-MENTO-ORG-G](https://mento-labs.sentry.io/issues/ANALYTICS-MENTO-ORG-G)). Development is still missing — fix is `target = ["production", "preview", "development"]` in `terraform/main.tf:117` (currently `["production", "preview"]`) on next quiet-window apply. Out of band by the OIDC upgrade item below — if OIDC lands first, this becomes moot (no static token).
- [ ] **Vercel `protection_bypass_for_automation` was removed** during the same root-stack apply. If lhci or curl-based preview verification breaks, that's why — restore by re-adding the field to `vercel_project.dashboard` if needed.
- [ ] **`splunk_on_call` always shows "1 to change" on every aegis plan** — known terraform-provider-grafana quirk with sensitive `victorops {}` blocks (provider can't no-op-diff). Pre-dates this migration; harmless but annoying. Track for a future provider-bump.

## address-labels backup: per-hash blob splits

Daily backup snapshot crossed both restore-path caps on 2026-05-21 (Sentry [ANALYTICS-MENTO-ORG-19](https://mento-labs.sentry.io/issues/ANALYTICS-MENTO-ORG-19) / [ANALYTICS-MENTO-ORG-18](https://mento-labs.sentry.io/issues/ANALYTICS-MENTO-ORG-18)): total snapshot 33.8 MB > `MAX_RESTORE_BLOB_BYTES` (32 MB) and `intel_deep` EVAL payload 8.78 MB > `MAX_REDIS_HASH_REPLACE_BYTES` (8 MB, Upstash Lua EVAL ceiling). Backup itself still succeeds and the raw blob is salvageable manually, but disaster-recovery restore would reject it. Code comment at `ui-dashboard/src/app/api/address-labels/backup/route.ts:11` already prescribes the right fix ("the cron should switch to per-hash blob splits").

Plan — single PR, additive on restore side:

- [ ] **Backup route** (`backup/route.ts`): replace the single `address-labels-backup-YYYY-MM-DD.json` write with parallel per-hash blobs under `address-labels-backup-YYYY-MM-DD/<hash>.json` (one per `labels`, `reports`, `intelDeep`, `intelTransfers`, `intelWealth`, `intelEntities`, `intelEntityCps`) plus a `manifest.json` listing `{exportedAt, hashes: [{name, pathname, size, sha256}]}`. All 8 blobs uploaded via `Promise.all`. No single blob crosses ~10 MB → both caps stop biting.
- [ ] **Restore route** (`restore/route.ts`): detect manifest vs legacy blob shape (filename pattern or JSON probe of first chunk); manifest path fetches each referenced hash blob in parallel and runs `replaceRedisHashes` per hash (preserves per-hash atomicity, drops cross-hash atomicity which the per-hash route already gave up). Keep the legacy monolithic-blob path for back-compat — restoring older snapshots stays possible. Bump `MAX_RESTORE_BLOB_BYTES` to 16 MB per blob (well under any platform limit).
- [ ] Update `isAllowedRestorePathname` to accept the new `address-labels-backup-YYYY-MM-DD/(<hash>|manifest).json` pattern alongside the existing patterns.
- [ ] `flagOversizeBackup` stays as a safety net; warnings should never fire under the new shape.
- [ ] Tests: extend `backup/__tests__/route.test.ts` to assert 8 blobs + manifest get written; add a restore test that consumes a manifest blob; keep an existing legacy-blob restore test.
- [ ] Optional follow-up: 30-day rolling cleanup of old monolithic blobs once new format has soaked for ~1 week.

## Upgrade `@vercel/blob` to ^2.4.0 + switch to OIDC tokens

Eliminates the static-token rotation pain that took ~1 hour to root-cause on 2026-05-21 (terraform apply on 2026-05-20 silently wrote a broken `BLOB_READ_WRITE_TOKEN`; first scheduled cron at 03:00 UTC hit `BlobStoreNotFoundError`; rotation required Vercel-API surgery on store-project connections). With OIDC the SDK auto-fetches a short-lived (~1h) project-scoped token from Vercel's identity issuer at runtime — no env var to rotate or accidentally clobber.

- [ ] Bump `@vercel/blob` from `^2.3.1` to latest `^2.4.x` in `ui-dashboard/package.json` (OIDC support landed in 2.4).
- [ ] Verify both call sites — `backup/route.ts:89` (`put`) and `restore/route.ts:51` (`get`) — still type-check and behave. OIDC is transparent to consumers; SDK fetches OIDC token when `BLOB_READ_WRITE_TOKEN` is absent.
- [ ] `pnpm test` — both route tests mock `@vercel/blob`, should pass unchanged.
- [ ] Ship via normal worktree + `/ship` flow.
- [ ] After prod deploy READY: Vercel dashboard → Storage → `address-labels-backup` → click **Upgrade to OIDC** banner.
- [ ] Verify cron: `curl -H "Authorization: Bearer $CRON_SECRET" https://monitoring.mento.org/api/address-labels/backup` → expect 200.
- [ ] Remove the static env var: `vercel env rm BLOB_READ_WRITE_TOKEN production --yes && vercel env rm BLOB_READ_WRITE_TOKEN preview --yes`. Also drop `vercel_project_environment_variable.blob_token` from `terraform/main.tf` (and the `blob_token` variable + tfvars entry).
- [ ] Optional: trigger a cron-style restore against the latest backup blob to confirm OIDC works for `get()` too.
- [ ] Closes the "lost development scope" loose end above (no static token → no scope to lose).
