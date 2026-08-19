---
title: Pool criticality is depletion risk, not deviation magnitude
status: active
owner: eng
canonical: true
last_verified: 2026-08-19
scope: alerts
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0067 — Pool criticality is depletion risk, not deviation magnitude

**Status:** Accepted (Aug 2026), in force.
**Scope:** alerts (constrains shared-config thresholds, metrics-bridge, and the
dashboard's reading of pool health)

## Context

`#alerts-critical` stopped being actionable. Grafana alert-state history for
2026-08-05 → 2026-08-19 shows roughly 130 critical/page firing transitions plus
hourly repeats, of which about two were unambiguous "act now" events.

The largest single source was `Deviation Breach Critical`: a sticky
`deviation_ratio > 1.05` open-breach peak held for more than an hour. It fired
for pools sitting at 59/41, 60/40, and even 52.5/47.5 while recovering. Mento's
FPMMs are oracle-priced with zero slippage, so a swapper at 60/40 gets exactly
the price they get at 50/50. The alert described a number, not an experience.
Every page it produced resolved to the same instruction — make sure the
rebalancer acts — which `Rebalancer Stale` already covers, at critical
severity, with the blocked-reason annotation attached.

The magnitude rules also suppressed the warning tier they escalated from
(`deviation_warning_active_promql` subtracted the pools the critical rules had
taken over). Deleting them without touching that branch would have made the
loudest pools silent.

Separately, `DEVIATION_CRITICAL_RATIO = 1.05` is not only an alert threshold.
It classifies pool health for the dashboard badge, buckets breach history,
drives the indexer's persisted `criticalDurationSeconds`, feeds
`classifyDeviationAlertState` and the `mento_pool_deviation_alert_state` gauge,
and gates metrics-bridge rebalance-probe eligibility.

## Decision

A pool alert is critical when it reflects **user impact** or **rebalancer
inaction**, not when a ratio is large.

- **Depletion risk becomes the pool-side critical.** Two rules in
  `alerts/rules/rules-fpmms.tf` read `min(side share)` from the existing
  `mento_pool_reserve_share_token{0,1}` gauges:
  - `Pool Depletion Risk` — min side share in `[10%, 20%)`, sustained 15m,
    `severity = critical`, twice-daily repeat via `notify_critical_pool_slow`.
  - `Pool Nearly One-Sided` — min side share below 10% for 1m,
    `severity = page`. Below 10% the pool is minutes from rejecting one swap
    direction outright.

  The bands partition the range at the page share with no gap and no overlap,
  so one depleting pool produces exactly one notification. Neither rule carries
  the `keep_firing_for` hold that PR #1937 added to the other flap-prone pool
  criticals: on adjacent bands a hold is what creates a double notification,
  because the held band keeps firing while the pool crosses into its
  neighbour — in both directions. The 15m dwell and the 10-percentage-point
  gap between the bands absorb churn instead. Neither rule is FX-weekend
  gated: reserve share is on-chain balances, not an oracle-derived quantity,
  so a market pause does not make the signal spurious.

- **Page delivery uses one bundled contact point.** Every `service = "fpmms"`
  rule routes through rule-level `notification_settings`, which bypasses
  `grafana_notification_policy.all` entirely.
  `grafana_contact_point.pool_page` carries both a Slack destination
  (`#alerts-critical`, v3 body template) and a VictorOps destination (Splunk
  On-Call, plain text), exactly as the peg plane's
  `grafana_contact_point.peg_page` does.

- **`Rebalancer Stale` is the primary mid-range actionable critical**, kept
  unchanged. `Rebalance Ineffective` remains the earlier warning.

- **The magnitude-based criticals are deleted** — `Deviation Breach Critical`
  and `Deviation Breach Critical (anchored)`, plus their main.tf gating locals.

- **The warning tier is un-suppressed.** `deviation_warning_active_promql` and
  `deviation_warning_unavailable_active_promql` no longer subtract
  critical-owned pools, so every pool outside the 1% tolerance stays covered in
  `#alerts-pools` for as long as its breach is open.

- **`Deviation Breach Critical State Changed` is demoted to warning** and
  routed to `#alerts-pools` through `notify_warning_pools_transition`. Its
  subject is now an analytics-state change, not an incident. The now-unused
  `notify_critical_transition` local and its
  `grafana_contact_point.slack_critical_transition` are removed.

- **`DEVIATION_CRITICAL_RATIO` stays at 1.05 as an analytics classification**
  with every non-`alerts/` consumer untouched. It is no longer mirrored into
  Terraform; `scripts/alerts/check-deviation-threshold-drift.mjs` now enforces
  the surviving tolerance mirror plus the two new depletion shares.

## Alternatives considered

- **Raise the deviation critical threshold instead of replacing it** —
  rejected: no magnitude makes an oracle-priced, zero-slippage pool a user
  problem. A higher number would fire less often and still describe nothing an
  operator can act on differently.
- **Redefine `DEVIATION_CRITICAL_RATIO` coherently across indexer, dashboard,
  and bridge** — rejected for this change. The indexer persists
  `criticalDurationSeconds` from that boundary, so a redefinition means a
  schema-semantics change plus a full resync, and it would silently rewrite the
  meaning of historical breach records. Keeping 1.05 as the analytics
  classification and changing only what pages keeps the blast radius inside
  `alerts/`.
- **Delete the magnitude criticals and leave the warning suppression in
  place** — rejected: it looks like a no-op cleanup and is the opposite. The
  suppression branch existed to hand pools to the critical rules; with those
  gone it would hand them to nothing.
- **Route the page through the global notification policy tree** (a
  `service=fpmms, severity=page` branch, as trading limits and trading modes
  do) — rejected: the tree's Slack contact points render through
  `local.alert_config_slack`, an alertname dispatcher with no branch for pool
  rules, so the page would arrive as a raw label dump with no pool link. It
  would also put one rule of the fpmms plane on the label-routed plane, where a
  later edit restoring rule-level settings, or any new branch matching
  `service=fpmms`, would double-deliver the same page.
- **Give the depletion tiers the same `keep_firing_for = 1h` hold as the other
  pool criticals** — rejected: it defeats the partition. A pool crossing down
  from 15% to 8% would page while the held critical was still firing, and a
  pool recovering the other way would fire the critical while the held page was
  still open. No hold placement survives both crossings, so the tiers rely on
  dwell and band separation instead. The cost is accepted: a pool oscillating
  across a band boundary can produce a fire/resolve pair per dwell period.
- **A new metrics-bridge gauge for side share** — rejected as unnecessary. The
  per-token reserve-share gauges already carry the value at the exact pool
  fingerprint the alert instances use.

## Consequences

- Replaying the 2026-08-05 → 2026-08-19 window against these rules yields
  roughly 12–15 grouped critical notifications instead of hundreds. The
  CHFm/USDm breach that drove most of the noise bottomed at ~22% min side
  share, above both depletion bands, and would have been covered by
  `Rebalancer Stale` alone — which is the correct outcome.
- Pool health now has two independent ladders that must not be conflated:
  deviation ratio classifies drift for analytics, depletion side share measures
  user impact and decides paging. A future change to one is not a change to the
  other.
- `POOL_DEPLETION_CRITICAL_SHARE` and `POOL_DEPLETION_PAGE_SHARE` join the
  Terraform mirror set. `DEVIATION_CRITICAL_RATIO` leaves it; a future editor
  who bumps it will get no drift-check failure, because there is nothing in
  `alerts/` left to desync.
- The depletion floors are the first pool thresholds chosen from a
  bandwidth-exhaustion argument rather than from replayed alert history. They
  will need one review against production data once a pool actually reaches
  them, together with the band-boundary flap behaviour the missing hold leaves
  exposed.
- `Pool Depletion Risk` resolves both when a pool recovers and when it worsens
  into the page band, so its resolution copy is deliberately neutral. A future
  editor must not "fix" it into a recovery claim.
- Applying this stack destroys `grafana_contact_point.slack_critical_transition`
  and creates `grafana_contact_point.pool_page`. Both are Grafana-side
  resources behind the `production-infra` apply gate.

## Evidence

- Issue [#1936](https://github.com/mento-protocol/monitoring-monorepo/issues/1936)
  — the alert-state history analysis and the two-PR plan.
- PR [#1937](https://github.com/mento-protocol/monitoring-monorepo/pull/1937)
  — Part 1, noise mechanics (`keep_firing_for`, 12h repeat, incident grouping).
- Enforcing files: `alerts/rules/rules-fpmms.tf` (the two depletion rules and
  the threshold-mirror banner), `alerts/rules/main.tf` (the min-side-share
  locals and the un-suppressed warning expressions),
  `alerts/rules/contact-points.tf` (`grafana_contact_point.pool_page`,
  `notify_page_pool`), `shared-config/src/thresholds.ts` (the constants and
  which of them Terraform mirrors),
  `scripts/alerts/check-deviation-threshold-drift.mjs` (the mirror check), and
  `scripts/alerts/alert-rules-lint.test.mjs` (the routing and repeat-cadence
  invariants).
- Related decisions: [ADR 0004](0004-two-alert-planes.md) for the two alert
  planes this rule set lives in, [ADR 0027](0027-metrics-bridge-hasura-to-prometheus.md)
  for the gauges the depletion query reads, and
  [ADR 0046](0046-event-sourced-oracle-freshness.md) as the closest
  precedent for redefining what an existing signal means without rewriting its
  persisted history.
