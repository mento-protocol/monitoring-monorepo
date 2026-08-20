---
title: Pool criticality is depletion risk, not deviation magnitude
status: active
owner: eng
canonical: true
last_verified: 2026-08-20
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
  `alerts/rules/rules-fpmms.tf` read `min(side share)` **measured by value**,
  from the `mento_pool_reserve_value_share_token{0,1}` gauges:
  - `Pool Depletion Risk` — min value share in `[10%, 20%)`, sustained 15m,
    `severity = critical`, twice-daily repeat via `notify_critical_pool_slow`.
  - `Pool Nearly One-Sided` — min value share below 10% for 1m,
    `severity = page`. Below 10% the pool is minutes from rejecting one swap
    direction outright.

  PR #1940 shipped this reading the raw token-count gauges
  (`mento_pool_reserve_share_token{0,1}`) instead, which is wrong on any pair
  that does not trade near parity; PR #1944 corrected it before the production
  apply. See the reversed alternative below.

  The bands partition the range at the page share with no gap and no overlap,
  so one depleting pool produces exactly one notification. Neither rule carries
  the `keep_firing_for` hold that PR #1937 added to the other flap-prone pool
  criticals: on adjacent bands a hold is what creates a double notification,
  because the held band keeps firing while the pool crosses into its
  neighbour — in both directions. The 15m dwell and the 10-percentage-point
  gap between the bands absorb churn instead. Neither rule is FX-weekend
  gated: the quantity is on-chain balances weighted by the last median, and a
  market pause does not make it spurious — a rate that stopped updating on
  Friday still says whether the two legs are worth roughly the same. The
  weekend is exactly when nobody is watching a pool drain.

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
- **A new metrics-bridge gauge for side share** — rejected as unnecessary in
  PR #1940, **reversed in PR #1944**. The existing per-token reserve-share
  gauges do carry a number at the right pool fingerprint, but it is a token
  count, and token counts on the two sides of an off-parity pair are not
  comparable quantities. The correct comparison needs each leg priced through
  the pool's own oracle reference, which needs the per-pool `invertRateFeed`
  orientation — a value PromQL has no access to and cannot infer from the
  published series. `mento_pool_reserve_value_share_token{0,1}` therefore do
  the conversion in the bridge, where the flag is available, the arithmetic is
  unit-testable, and the alert expression stays a `min` over two gauges.
  Choosing an orientation heuristically in PromQL was also considered and
  rejected: every rule that guesses masks the catastrophic case, because a pool
  that is genuinely drained by the square of the exchange rate reads as
  perfectly balanced under the wrong orientation.

## Consequences

- Replaying the 2026-08-05 → 2026-08-19 window against these rules yields
  roughly 12–15 grouped critical notifications instead of hundreds. The
  CHFm/USDm breach that drove most of the noise bottomed at ~22% min side
  share, above both depletion bands, and would have been covered by
  `Rebalancer Stale` alone — which is the correct outcome.
- Pool health now has two independent ladders that must not be conflated:
  deviation ratio classifies drift for analytics, depletion value share
  measures user impact and decides paging. A future change to one is not a
  change to the other. They are related but not interchangeable — both derive
  from the same reserve/oracle state, so a pool below the depletion floors is
  necessarily far outside its rebalance band, while the converse does not hold.
- The depletion tiers now depend on a live oracle median and an on-chain-read
  feed orientation, which the count-share version did not. A pool missing
  either publishes no value share, and both tiers evaluate NoData → OK. The
  gate is `medianLive`, not a non-zero last price: a zero-median outage retains
  the previous price, so a price-only check would have kept pricing reserves
  off a rate the contract had stopped honouring. This matches
  `hasFreshLiveMedian`, which is how the indexer decides the same question.
- The Polygon `EURm/EUROP` pool is the one exception to that gate. No oracle
  network publishes a EUROP/EUR price, so the pair runs on a hardcoded `MANUAL`
  rate feed pinned to 1:1 ([ADR 0042](0042-metrics-bridge-external-price-poller.md))
  and has never landed a median. At a rate of exactly 1 the oracle reference is
  1 and the value share reduces to the token-count share, so the bridge
  publishes the count numbers into the value-share gauges for this pool
  (`countSharesStandInForValue` in `metrics-bridge/src/metrics.ts`) and both
  tiers cover it normally. A real value share always wins when one is available.
  Membership requires a rate pinned to 1 by construction; a pair that merely
  trades near parity does not qualify, because its rate can move and the count
  share would then stop answering the depletion question.
- That fallback is deliberately narrower than "the allowlisted pool published no
  value share". It applies only while `lastMedianPrice` is zero — the state of a
  feed that has never landed a median. It must not survive the pair acquiring a
  real feed, and the retained-price rule above is what enforces that: a median
  that once worked and went dark keeps its last non-zero value, so the fallback
  switches off and the pool fails closed like any other. Publishing a 1:1 count
  share during an oracle outage would replace a real valuation with a fabricated
  one at the exact moment the pool most needs the real number, reading as
  healthy while it drains.
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
- **Rollout order is a prerequisite, not a preference.** The depletion rules
  read gauges the bridge publishes, so metrics-bridge must be deployed and
  `mento_pool_reserve_value_share_token0` / `_token1` must be visible in
  Prometheus before the `production-infra` apply. Applying first is not
  dangerous but it is silent: with no series, both tiers sit at NoData → OK
  and the depletion ladder looks healthy because it is not measuring anything.
  Confirming the two gauges answer "is this actually watching the pools yet".
- **The page tier has an empty day-one firing set.** Replayed against
  production on 2026-08-19, the thinnest value side across all 18 live pools is
  26% (Monad `CHFm/USDm`, the pool furthest outside its rebalance band at
  1.29× threshold). Nothing sits in either the critical `[10%, 20%)` band or
  the page band below 10%, so approving the `production-infra` apply adds no
  immediate notification.
- **A count share is not a depletion signal, and the first version of this ADR
  said otherwise.** PR #1940 read the token-count gauges and claimed the two
  `JPYm/USDm` pools (0.42% and 0.67% "USDm") were day-one true positives that
  should be funded before the apply. They were not. Those readings are the
  JPY/USD rate: one JPY is worth ~0.0063 USD, so a JPYm/USDm pool holding equal
  value on both sides holds ~160× more JPYm tokens than USDm tokens. By value
  the Celo pool was 40.2% USDm / 59.8% JPYm and the Monad pool 48.2% / 51.8%,
  both inside tolerance (`deviation_ratio` 0.976 and 0.149) and both shown
  healthy on the dashboard, which has always converted through the oracle. Had
  the apply been approved, both pools would have paged Splunk On-Call
  indefinitely with no operator action that could clear them. The check that
  caught it was replaying the expression against live production data before
  the apply, not review of the expression itself — it reads plausibly.
- **The orientation is per pool, not per pair.** `invertRateFeed` compensates
  the pool's token ordering, which differs by chain: the Celo `JPYm/USDm` pool
  lists USDm as token0 and inverts its feed, the Monad one lists JPYm as token0
  and does not. Nine of the eighteen live pools invert. Any future consumer
  that converts a pool's reserves through `mento_pool_oracle_price` must carry
  that flag; assuming a single direction is confidently wrong on half the
  estate.

## Evidence

- Issue [#1936](https://github.com/mento-protocol/monitoring-monorepo/issues/1936)
  — the alert-state history analysis and the two-PR plan.
- PR [#1937](https://github.com/mento-protocol/monitoring-monorepo/pull/1937)
  — Part 1, noise mechanics (`keep_firing_for`, 12h repeat, incident grouping).
- PR [#1940](https://github.com/mento-protocol/monitoring-monorepo/pull/1940)
  — Part 2, the depletion rules, shipped reading token-count shares.
- PR [#1944](https://github.com/mento-protocol/monitoring-monorepo/pull/1944)
  — the value-weighting correction, with the 18-pool production replay. Each
  pool's value split reproduces the pool's own on-chain `priceDifference` to
  within 1 bps, which is what establishes the conversion is in the same frame
  the FPMM contract uses.
- Enforcing files: `alerts/rules/rules-fpmms.tf` (the two depletion rules and
  the threshold-mirror banner), `alerts/rules/main.tf` (the min-value-share
  locals, the V0/V1 annotation queries, and the un-suppressed warning
  expressions), `metrics-bridge/src/metrics.ts` (`reserveValueShares`, the two
  gauges it publishes, and `countSharesStandInForValue`),
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
