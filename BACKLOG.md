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

### Lighthouse CI Follow-Ups

The initial Lighthouse CI gate landed in PR #451 with desktop performance + accessibility budgets. Remaining work to graduate it from advisory to fully-trusted:

- [ ] **Investigate + fix the /pools CLS regression so the CLS budget can graduate from `warn` to `error`.** First real CI run with the bypass working (PR #614) measured CLS = 0.4896 deterministically on /pools — all three runs identical, so this is a real layout shift during hydration, not measurement noise. Promoting CLS to `error` at the standard 0.10 "good" threshold is blocked on this fix. Likely suspects: pool table rendering before async swap/health data arrives, chart placeholders without reserved aspect-ratio space, or a route-private component re-rendering after `useSearchParams` hydrates. Once the fix lands and a few CI runs confirm CLS < 0.10, flip `.lighthouserc.cjs`'s `cumulative-layout-shift` budget from `warn` to `error`.
- [ ] **Add an INP measurement for pool-detail chart interaction.** `ui-dashboard/scripts/measure-inp.mjs` now covers /pools filter, leaderboard sort, and leaderboard time-window. The remaining BACKLOG'd surface is a TVL chart point hover/select on a pool detail page — skipped initially because pool detail pages require a valid pool address in the URL and the workflow doesn't know one at lhci time. Either (a) hardcode a stable representative pool address (e.g., the canonical Celo USDC pool), (b) hit `/api/pools` from the Node script to pick the first one, or (c) navigate via `/pools` and click the first pool tile. Add as a fourth entry in `SURFACES[]` once selectors are confirmed.
- [ ] **Switch INP gate from single-run to multi-run median if it flakes.** `ui-dashboard/scripts/measure-inp.mjs` takes one INP sample per CI run. `lhci` uses `numberOfRuns: 3` + median precisely because lab CWV measurements are noisy under runner-load variance (GC pauses, V8 JIT warmup). The current 200 ms budget has substantial headroom (typical INP on blacksmith-4vcpu is 40–80 ms), so single-run flakes should be rare in practice. If the gate flakes more than ~1 in 50 runs once it's been live for a week, run the `goto + interact + flush` loop N times (3) on separate page instances and assert `median(measurements) ≤ budget`.
- [ ] **Move Lighthouse + INP secret-handling into a trusted workflow_run trigger.** Both `.github/workflows/lighthouse.yml`'s lhci step and its INP step hand the `VERCEL_AUTOMATION_BYPASS_SECRET` to PR-controlled code (`.lighthouserc.cjs` consumes `extraHeaders` and could exfiltrate via a custom `upload.target`; `ui-dashboard/scripts/measure-inp.mjs` receives the headers JSON as env). The fork+Dependabot guards in `decide` mitigate this for outside contributors, but same-repo PRs still expose the secret to PR-controlled Node + config. The architectural fix is a `workflow_run`-triggered job that runs the secret-bearing audit from the trusted base ref's workflow YAML, similar to how the original PR #451 BACKLOG entry framed option (b). Cost: ~2–3 days to split the workflow + plumb the preview URL / PR number across the trigger boundary, plus rework of the sticky-PR-comment posting. Same-repo PR exposure has been accepted on #605/#451 for the past ~10 days; this item closes that gap properly.

### React Compiler Evaluation

Context: `ui-dashboard` is already on Next.js 16.2.6 + React 19.2.6, and
`pnpm --filter @mento-protocol/ui-dashboard react-doctor` reports 100/100 with
no issues. React Compiler is not enabled yet; Next.js 16 supports it via the
top-level `reactCompiler` config and `babel-plugin-react-compiler`.

- [ ] **Pilot React Compiler in annotation mode first.** Add
      `babel-plugin-react-compiler` as a dashboard dev dependency and configure
      `reactCompiler: { compilationMode: "annotation" }` in
      `ui-dashboard/next.config.ts`, leaving global compilation off until the
      pilot has behavior and build-time evidence.
- [ ] **Pick one high-churn client surface for `"use memo"`.** Prefer
      `leaderboard`, `pools`, or a chart-heavy page where URL state, filters,
      tables, and derived arrays currently rely on manual `useMemo` /
      `useCallback`. Keep the first PR narrow enough that regressions are easy
      to attribute.
- [ ] **Measure before expanding.** Capture baseline vs compiler-enabled
      interaction behavior with React Profiler or Playwright traces for a small
      set of real interactions: filter/search updates, tab/range changes, chart
      hover/toggle, and table sort/page changes. Record whether the win is
      measurable UI smoothness, reduced render count, or only cleaner code.
- [ ] **Run the dashboard safety gate.** At minimum run `react-doctor`,
      `pnpm dashboard:build`, and the relevant browser interaction tests. Add a
      focused regression test if the pilot touches URL-backed controls,
      optimistic mutations, or chart/table synchronization.
- [ ] **Decide rollout mode from evidence.** If annotation mode is clean and
      useful, either expand `"use memo"` to the next client-heavy surfaces or
      switch to `reactCompiler: true` behind a follow-up PR with the same
      measurement and browser-test gate. If build time increases materially and
      user-visible wins are weak, keep compiler usage targeted.

Acceptance: the pilot PR documents build-time delta, interaction/render evidence,
and any components deliberately left uncompiled via `"use no memo"` or by
remaining outside annotation mode.

## File Size And Lint Hygiene

Current line counts for remaining watch files were refreshed on 2026-05-25.
`raw` is physical lines; `rough` approximates the ESLint `max-lines` count
after skipping blanks and comments. Refresh before starting a split.

| Raw | Rough | File                                            | Action                                                                                   |
| --: | ----: | ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 847 |   616 | `indexer-envio/src/rpc/effects.ts`              | Watch; split if adding another effect family.                                            |
| 759 |   520 | `ui-dashboard/src/lib/network-fetcher/fetch.ts` | Watch; split fetch orchestration if another network-wide data source lands.              |
| 701 |   435 | `indexer-envio/src/handlers/sortedOracles.ts`   | Watch; split only with related oracle-handler work.                                      |
| 627 |   330 | `ui-dashboard/src/lib/leaderboard-hero.ts`      | Watch; split if hero KPI fallback or overlap logic grows again.                          |
| 628 |   478 | `ui-dashboard/src/lib/queries/leaderboard.ts`   | Watch; split leaderboard GraphQL fragments/queries if another leaderboard surface lands. |

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

The `splunk_on_call` "1 to change" drift was fixed by bumping `grafana/grafana` from `3.7.0` to `3.25.9`, which picks up upstream PR [#2123](https://github.com/grafana/terraform-provider-grafana/pull/2123) (v3.22.3) marking `victorops.url` as `Sensitive` and packing it from state on refresh. Side effect to be aware of: out-of-band changes to the webhook URL itself are now invisible to plan, the same way Slack tokens and PagerDuty integration keys already are; title/description still drift-detect.

Follow-up `alerts/rules/` was moved onto the v4 major (3.25.9 → 4.36.2) by renaming the 25 `grafana_message_template` outer names away from `:` separators (`Slack: X` → `Slack - X`, same for `VictorOps`/`Discord`). Required because upstream PR [#2567](https://github.com/grafana/terraform-provider-grafana/pull/2567) (v4.28.1+) rewrote the resource to the Plugin Framework with an unbounded `strings.Split(id, ":")`, breaking colon-in-name parsing that v3.x and v4.28.0 handled fine via `SplitN(id, ":", 2)`. Inner `{{ define "slack.X" }}` names (referenced by `alert_config` locals) were left unchanged, so downstream `{{ template "X" . }}` invocations were untouched. `aegis/terraform/` followed on the same day with a clean `~> 4.36` bump (no colon-in-name resources, plan was "No changes" against the existing state).

## Alerts hygiene follow-ups (from 2026-05 weekend-noise triage)

The 2026-05-22/24 weekend exposed several over-paging classes on `#alerts-critical`. PRs #569 / #572 / #574 / #576 fixed the highest-leverage items (reserve thresholds, weekend FX feed mute, Metrics Bridge Poll Errors rule tuning, stale-price Slack template). These are the loose ends.

_Auto-apply design decision resolved 2026-05-27._ `alerts/rules/` and `alerts/infra/` now auto-apply via CI on merge (PRs #619 / #622), gated by the `production` GitHub Environment required-reviewer rule. See Terraform CI/CD audit follow-ups below for the remaining hardening work (read-only plan SA, scheduled drift detection, aegis bring-up).

## Terraform CI/CD audit follow-ups (post-#622)

PR #622 shipped a saved-plan-style "skip-when-no-changes" + production-environment gate refactor for `alerts/rules/` and `alerts/infra/`. The audit surfaced the seven follow-up items below: 3 hardening/coverage tasks, 2 quality-of-life fixes, and 2 deferred deeper-investment items.

### Tier 1 — Hardening + coverage

- [ ] **Read-only plan SA split.** Currently both plan and apply jobs in `alerts-rules.yml` / `alerts-infra.yml` use `metrics-bridge-deployer@` (impersonates `org-terraform`, write-capable). A malicious PR could add a plan-time `external`/`local-exec` data source to exfiltrate context. Split: new `metrics-bridge-plan-readonly@` SA + new `org-terraform-plan-readonly@` seed-project SA with `roles/storage.objectViewer` on the state bucket only. Plan jobs swap to the read-only chain via `-backend-config="impersonate_service_account=..."` + `-lock=false`; apply jobs unchanged. Two-PR sequence (prep PR for terraform/ wiring → workflow PR). Out-of-scope but useful: `metrics-bridge.yml` and `aegis-app-engine.yml` keep the existing SA (no `terraform apply` step). This does NOT mitigate `TF_VAR_*` cleartext exposure at plan time — providers still need them to refresh.
- [ ] **Scheduled drift detection workflow.** Daily `terraform plan -detailed-exitcode` for every stack whose `ci.apply == "push-main-production-environment"` in `terraform.stacks.json`. Matrix-driven from the registry (auto-picks up new auto-applied stacks). On exit-2, open or update a GitHub issue labelled `drift-detection` + `stack:<id>` with the plan tail. Single workflow file `.github/workflows/terraform-drift.yml`. Initial version skips `alerts-delivery` until the `local_file.env_file` follow-up below lands (perma-positive otherwise — would kill the signal). Once aegis flips to auto-apply, drift coverage is automatic.
- [ ] **Bring `aegis/terraform/` under CI auto-apply.** Single Grafana folder + dashboard + service-health alert. Mirror `.github/workflows/alerts-rules.yml` as `.github/workflows/aegis-terraform.yml`. Backend impersonation already wired since PR #443; the existing `ci_alerts_org_terraform_token_creator` IAM binding already covers aegis as a third consumer (same `(SA, role, member)` triple). Single PR (cosmetic rename of the binding to `ci_org_terraform_token_creator` folded via `moved {}` block + new workflow + `terraform.stacks.json` policy flip). Pre-flight: run `pnpm aegis:tf:plan` on a clean main checkout first to surface accumulated manual-apply drift; reconcile before merge.

### Tier 2 — Quality-of-life

- [ ] **`alerts/infra/onchain-event-handler/local-dotenv-file.tf` exit-2 false positive.** The `local_file.env_file` resource always plans as "create" on fresh-checkout CI runners (the file is gitignored and absent on clean clone). Defeats the skip-when-no-changes optimization for alerts-infra — production gate fires on every merge. Fix: replace with `terraform_data` + `local-exec` provisioner so refresh has no on-disk state to drift against. `removed { lifecycle { destroy = false } }` block detaches the old resource without nuking local `.env` files.
- [ ] **PR #609 follow-up — mixed-state trading-mode visibility.** When firing AND resolved trading-mode alerts arrive in the same Grafana group notification, the title's global `🚨` masks the resolved entries. Fix: switch the trading-mode title to the count-summary pattern proven in `slack.trading_limits_alert_title` (`[N FIRING | M RESOLVED] {{ .CommonLabels.alertname }}`) + embed per-alert emoji inline in body bold heading. Slack + Discord parity; in-place template updates only.

### Tier 3 — Deferred

- [ ] **Saved-plan binding via KMS — deferred.** PR #622's audit considered re-introducing the binary `tfplan` artifact via KMS envelope encryption to recover the "binding plan" property (byte-for-byte equality between PR-time review and apply-time execution). Recommendation: defer. Cost/value analysis: alerts stacks change ~1-2× per month, blast radius is alert delivery (recoverable on 15-min cycle), and the drift window between plan and apply is mitigated by the re-plan at apply gate. **Hard prerequisite to revisit: ship Tier-1 scheduled drift detection above.** Once drift is caught within 24h regardless of which plan ran, the marginal value of binding-plan approaches zero. Reopen only if a higher-blast-radius stack (e.g. `terraform/` platform) moves to auto-apply.
- [ ] **Local TF apply guard for auto-applied stacks.** `scripts/tf-stacks.mjs` apply path could refuse runs against stacks where `ci.apply == "push-main-production-environment"` unless on `main` + clean tree + `HEAD == origin/main`, with a `--force-local-apply` override. The 2026-05-27 alerts/rules ping-pong (local apply from a feature branch fighting CI auto-apply on main) was the proximate motivation; aliases removal alone closes the observed footgun but not the theoretical secondary path via `pnpm tf apply <stack>`.

## Alerts integration follow-ups

Core migration is complete: `mento-protocol/alerts` vendored into `alerts/infra/` and
archived on GitHub, state backends unified under `alerts-infra` + `alerts-rules`, CI
deploy job with manual approval gate live in `.github/workflows/alerts-infra.yml`.
Items below are net-new functionality or polish, not migration blockers.

### Tier 1 — Next-phase work

- [ ] **Retire legacy on-chain Discord resources after Slack soak** — once the
      Slack adapter apply has run and `#multisig-alerts` / `#multisig-events`
      receive production events, remove `module.discord_channels`, the root
      Discord provider/variables/GitHub secrets, and
      `channels/discord-channels/`. Keep the provider available until the
      first destroy apply can cleanly archive/delete the Discord-managed state.
- [ ] **Tighten Cloud Function ingress** — `alerts/infra/onchain-event-handler/main.tf` currently sets `ingress_settings = "ALLOW_ALL"` + `member = "allUsers"` on the function IAM, defended in-code by QuickNode HMAC-SHA256 signature verification, timestamp tolerance, and nonce replay protection. Accepted risk for now (matches vendored upstream). Revisit only with verified QuickNode stable egress IPs or OIDC-signed delivery: switch to `INTERNAL_AND_GCLB` + allowlist QuickNode IPs (or verify OIDC token in code) and drop `allUsers`. HMAC stays as defense-in-depth either way.

### Tier 2 — Gated on external work

- [ ] **Consolidate Aegis v2 alerts** under `alerts/rules-v2/` once the in-flight Aegis Discord→Slack cutover lands.

### Tier 3 — Hygiene / cosmetic

- [ ] **Tighten `local_file.env_file` permissions** — `alerts/infra/onchain-event-handler/main.tf` writes the runtime env file at `0777`. The file is gitignored and machine-local, but secret-bearing. Drop to `0600`.
- [ ] **Remove `ci_failures_invite_eng` read-path migration guard** — PR #597 temporarily accepts legacy `channel_not_found` refreshes for old state whose `read_path` still asks Slack for `channel=true` or `channel=false` before persisting the new `/api.test` read path. After the PR #597 apply confirms state is clean, remove that postcondition branch from `alerts/infra/ci-failures-channel.tf`.
- [ ] **Orphan GCS state files** — after PR #556 renamed backend prefixes to `alerts-infra` + `alerts-rules`, the old paths (`gs://<state-bucket>/alerts/default.tfstate` and `gs://<state-bucket>/monitoring-monorepo-alerts/default.tfstate`) still exist on GCS. No functional impact, pennies/month storage. Delete with `gcloud storage rm` on next cleanup pass.

### Sentry → Slack follow-ups (post #561 + #570)

- [ ] **Zero-default-monitor edge case in `data.sentry_project_issue_stream_monitor`** — if a brand-new Sentry project lands in the org before its default issue-stream monitor has been provisioned (rare — Sentry creates it eagerly), the per-project data source lookup fails and the `for_each` plan errors out for ALL projects in the same apply. Documented as a "Known limitation" in `alerts/infra/channels/sentry-bridge/README.md`. Promote to a structural fix when this actually bites — options: (a) two-phase apply with `data.sentry_project_issue_stream_monitor` re-resolved between phases; (b) pre-flight script that polls Sentry until each new project's default monitor is present; (c) filter `local.projects` to projects with monitors via a separate data source check.
- [ ] **Drop the now-unused `discord` provider declaration from `channels/sentry-bridge/`** — `versions.tf` `required_providers.discord` and `alerts/infra/main.tf` `providers = { discord = discord }` were intentionally retained through the migration apply so Terraform could destroy the Discord-typed resources cleanly. Once the apply lands and state no longer references Discord-typed resources, both blocks (and the cross-link comments) can be removed in a tiny follow-up PR.

## OracleSnapshot.priceDifference on drained pools (post #624)

PR #624's oracle-chart redesign surfaced rows where `priceDifference` runs into the 10–73 billion bps range (deviationRatio up to ~15 million) on the USDT/USDm pool `0x0feba76…3228d`. Initial framing was "integer overflow upstream of the handler" — investigation disproved that. The math reproduces exactly: `computePriceDifference` faithfully mirrors the on-chain FPMM formula `|reservePrice − oracle|/oracle`, and the bogus values are the correct output when a pool's reserves are wildly imbalanced (e.g. reserve0 = 8282 micro-USDT = $0.008, reserve1 = 60354 USDm, oracle ≈ 1 USDm/USDT → 7.3M× implied price). One observed window: pool `0x0feba76…` sat at reserve0 = 8282 from block 67886646 → 67892218 (≈1.5 h) with zero rebalance fired — the indexed deviation is a faithful keeper-coverage signal, not a bug.

Scope on Hasura (`indexer.hyperindex.xyz/2f3dd15`) as of 2026-05-27:

- **9,266 rows** affected, all on Celo (chain 42220). None on Monad.
- **4 pools** (`0x0feba76…3228d` USDT/USDm, `0x462fe04…aa19e` cUSD/USDC, `0xb285d4c…dd2d` cUSD/USDT, `0x1ad2ea0…9e29` cUSD/cKES). The three 6/18-decimal-mismatch pools land in the 70-billion-bps range; the 18/18 cUSD/cKES pool tops out at ~1.2 billion.
- **3 of 4 source values affected**: `update_reserves`, `oracle_reported`, `oracle_median_updated`. `rebalanced` is clean because that handler uses `event.params.priceDifferenceAfter` from the on-chain contract (post-rebalance reserves).
- Date range **2026-03-19 → 2026-05-26** (continuing as drained-pool windows recur).

PR #624's `source: { _eq: "oracle_median_updated" }` filter on `ORACLE_SNAPSHOTS_CHART` does NOT actually defuse the chart — bogus values exist on that source too. The chart only displays clean now because PR #624 also switched the y-axis to plot raw `oraclePrice` against the breaker band (the `priceDifference` field is no longer read by the chart). The filter is defensive-only and the rationale comment in `ui-dashboard/src/lib/queries/config.ts:60-70` is misleading on that point.

Downstream consumers still reading the field:

- `oracle-tab.tsx` rendering "Price Diff" column + search/sort (bogus rows show in the table).
- `deviationBreach.ts` lifecycle: opens real `DeviationThresholdBreach` rows on the rising edge and credits the duration toward `cumulativeBreachSeconds`. The 1.5-hour drained-pool windows DO contribute to that all-time uptime counter.
- `OracleSnapshot.deviationRatio` (= `priceDifference / rebalanceThreshold`, 6dp): inflated to the 10M+ range on bogus rows; will dominate any non-clamped numeric stat.

Recommended remediation (single approach, single PR):

- [ ] **Add `degenerateReserves: Boolean!` on `OracleSnapshot`** — computed at write time in `computePriceDifference`'s callers, true when `min(norm0, norm1) * RATIO_LIMIT < max(norm0, norm1)` for some threshold (start with `RATIO_LIMIT=10_000` → flags pools where one side is <0.01% of the other when scaled to 18dp). Reasons over the alternatives (clamp / skip-write / cap-at-INT32): preserves the on-chain-faithful math, doesn't lose data, gives every consumer independent choice (oracle-tab can dim the row, breach pipeline can exempt it from `cumulativeBreachSeconds`, the chart's `priceDifference`-based mode if ever resurrected can filter it). The schema field is additive (defaults `false` on existing rows so unaffected pools keep current behaviour). Apply the same flag on `Pool.priceDifference` and gate the breach-rising-edge predicate in `deviationBreach.ts` on it so the cumulative counters stop accruing during drained-pool windows. Schema-additive deploy posture: pre-deploy via `/deploy-indexer --no-promote` from the branch tip → wait for full re-sync → **promote BEFORE merging** (`pnpm deploy:indexer:promote <commit> -y`, wait ~5 min for DNS flip) → then merge. Merge-before-promote would break the dashboard for ~75 min (Vercel ships the new UI querying the new field before prod Hasura has it — PR #523 hit exactly this in 2026-05).
- [ ] **Update the misleading rationale comment in `ui-dashboard/src/lib/queries/config.ts`** (lines 60-70) in the same PR — make explicit that the filter is defensive-only on `priceDifference`, and the chart's correctness comes from plotting `oraclePrice` against the breaker band, not from the source restriction.
- [ ] **Update `indexer-envio/schema.graphql` `OracleSnapshot.priceDifference` field comment** with a one-liner: "Magnitude can run into billions of bps on degenerate (effectively one-sided) reserves — see `degenerateReserves` flag and BACKLOG entry."
- [ ] **No backfill needed.** Historical rows keep their faithful (large) values; the new flag defaults false on them. Adding the flag changes only future writes and the breach predicate going forward. Consumers that suppress on the flag will silently drop pre-fix historical bogus rows in their displays — acceptable since those windows were already visually noisy.
