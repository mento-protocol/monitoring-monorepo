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
- [ ] Enable `exactOptionalPropertyTypes: true` on `ui-dashboard/tsconfig.json`. The flag is already on for `shared-config` (PR #443), `indexer-envio`, and `metrics-bridge`. Dashboard had ~107 errors at last scout, dominated by TS2375/TS2379 (object literals with `key: value | undefined`). Pattern: prefer changing the destination type from `?: T` to `?: T | undefined` once per `Props`/option type (one edit unlocks every caller) rather than wrapping each call site in `...(val !== undefined && { key: val })`. Reserve the spread form for payloads that get serialized (URL params, GraphQL variables, fetch bodies) where absent key vs `"key": null` is materially different.

### Lighthouse CI Follow-Ups

The initial Lighthouse CI gate landed in PR #451 with desktop performance + accessibility budgets. Remaining work to graduate it from advisory to fully-trusted:

- [ ] **Architect a reliable Vercel deployment-protection bypass for lhci.** PR #451 shipped with bypass-via-header, but lhci's puppeteer-launched Chrome appears to redirect to the Vercel SSO interstitial despite the `x-vercel-protection-bypass` header — verified empirically (lhci audited `vercel.com/login?next=...` URLs instead of the dashboard). The query-param form works but embeds the secret in the publicly-readable lhci report (`temporary-public-storage`). Options to evaluate: (a) configure Vercel project to disable preview protection (Vercel project setting, may need governance approval); (b) gate the secret-bearing audit to a separate `workflow_run`-triggered job that runs from trusted base ref; (c) deploy a CDN-fronted preview alias that's unprotected for crawlers but auth-gated for browsers; (d) self-host lhci on a runner that talks to Vercel's API directly and uses a different auth flow. Once a reliable bypass lands, **promote accessibility from `warn` to `error` in `.lighthouserc.cjs`** so regressions block.
- [ ] Promote performance budgets from `warn` to `error` in `.lighthouserc.cjs` once 5+ stable runs and a representative percentile distribution are collected. Drop the budget to the post-distribution floor with conservative headroom and confirm the gate doesn't flake on CI runner load variance. Depends on the bypass mechanism above — performance numbers from the SSO interstitial are not meaningful.
- [ ] Add INP (interaction-to-next-paint) coverage via lhci's user-flow mode with scripted interactions on the dashboard pages. Lighthouse's default navigation mode never produces an INP numeric value, so the budget was intentionally omitted in PR #451 to avoid silent-pass false confidence. User-flow mode would script the typical "open page, hover a chart, click a filter" interaction and run an INP audit on the scripted timespan.

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

## Envio v3 Migration Follow-Ups

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

_None remaining._ The `splunk_on_call` "1 to change" drift was fixed by bumping `grafana/grafana` from `3.7.0` to `3.25.9`, which picks up upstream PR [#2123](https://github.com/grafana/terraform-provider-grafana/pull/2123) (v3.22.3) marking `victorops.url` as `Sensitive` and packing it from state on refresh. Side effect to be aware of: out-of-band changes to the webhook URL itself are now invisible to plan, the same way Slack tokens and PagerDuty integration keys already are; title/description still drift-detect.

## Alerts hygiene follow-ups (from 2026-05 weekend-noise triage)

The 2026-05-22/24 weekend exposed several over-paging classes on `#alerts-critical`. PRs #569 / #572 / #574 / #576 fixed the highest-leverage items (reserve thresholds, weekend FX feed mute, Metrics Bridge Poll Errors rule tuning, stale-price Slack template). These are the loose ends.

- [ ] **Auto-apply for Terraform modules — design decision.** All four Terraform stacks in the repo (`terraform/`, `alerts/rules/`, `alerts/infra/`, `aegis/terraform/`) follow the same shipping model: merge to main → manual `terraform apply` from a local checkout. The 2026-05 weekend triage revealed three pending applies across two stacks (PRs #569/#572/#576 to `aegis/terraform/`, PR #574 to `alerts/rules/`) that had to be hand-applied at session end. CI gap: a merged PR doesn't tell anyone "deploy is still pending"; nothing surfaces drift between merged code and Grafana state. PR #584 closed the validate-only gap for `aegis/terraform/`; auto-apply is the next step. Needs a long-lived Grafana SA token in CI secrets (or short-lived OIDC if Grafana Cloud supports it), plus a deliberate call on whether `terraform apply` on merge loses too much plan-review value (once the plan-review is automated, there's no last-human-in-the-loop step for alert rules). Recommend evaluating per-stack: `aegis/terraform/` and `alerts/rules/` are higher-risk (a bad template breaks every alert until reverted), `alerts/infra/` and `terraform/` may be safer candidates to go first.

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
