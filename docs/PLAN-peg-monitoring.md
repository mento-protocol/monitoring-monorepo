---
title: Peg monitoring for oracle-less stablecoins (EUROP first)
status: active
owner: eng
canonical: false
doc_type: plan
scope: repo-wide
review_interval_days: 365
---

# Peg monitoring for oracle-less stablecoins (EUROP first)

> Non-canonical plan. The durable decisions live in ADRs
> [0042](adr/0042-metrics-bridge-external-price-poller.md),
> [0043](adr/0043-peg-registry-service-local.md),
> [0044](adr/0044-peg-thresholds-gated-rules-plane.md),
> [0045](adr/0045-peg-paging-semantics.md). Market figures below are a
> 2026-07-22 snapshot — re-verify before relying on them.

## Problem

EUROP (EURØP, Schuman Financial) trades in the Polygon EURm/EUROP FPMM
(`0xCd8C6811d975981F57E7fB32e59f0BeE66aF3201`) against a hardcoded
`EUROP/EUR = 1.0` `MANUAL` rate feed (`0xc22418…`, reporter: migration
multisig `0x58099B…`, ~one-year expiry). No oracle network publishes EUROP
(verified: Chainlink, Pyth, RedStone, Chronicle, Stork). If EUROP depegs,
arbitrage sells it into the pool at par and drains EURm/reserve; the defense
is a human multisig posting a >0.5% price to trip the ValueDeltaBreaker.
Nothing measures how far EUROP actually trades from 1.00 EUR — and more
oracle-less local-currency stablecoins are expected to onboard.

## Market structure evidence (live-verified 2026-07-22)

| Source                                | Reading                                                         | Assessment                                             |
| ------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------ |
| Bitvavo `EUROP-EUR`                   | mid ≈ 1.0002, spread 9 bps, ~€38–40k top-of-book/side, €36k/24h | deep venue; real price discovery                       |
| Kraken `EUROPEUR`                     | mid ≈ 1.0003, spread 22 bps, €16.5k bids within −0.5%, €93/24h  | thin; depth signal, capped at ref size                 |
| Kraken `EUROPUSD`/`EUROPUSDC`         | mid ≈ 1.1404 USD                                                | conversion leg required → display-only                 |
| Bit2Me `EUROP/EUR`                    | €0.9998                                                         | tiny, often stale                                      |
| CoinGecko `schuman-europ`             | €0.9997 (precision=6 works keyless)                             | aggregator; volume-weighted, poisonable → display-only |
| DefiLlama pegged asset 247            | $1.1406, confidence 0.99                                        | cross-check only                                       |
| EVM DEX pools (ETH/Polygon/Avalanche) | Curve EUROP/EURC ~$115k **zero volume**; rest dust/drained      | no price discovery; inadmissible                       |
| XRPL books                            | ~$54k/24h, XRP/EUROP + EUROP/RLUSD                              | outside indexer coverage; not used                     |

Issuer: 1:1 redemption (min €10k), ACPR-regulated, quarterly KPMG
attestation PDFs — no machine-readable API; runbook inputs only.

## Design

### Registry (ADR 0043)

Service-local `metrics-bridge/peg-registry.json` + schema + fixtures.
Slug-keyed assets; `tokenRefs` per chain (EVM chainId+address only until a
canonical non-EVM registry exists in shared-config; peg currency in the
registry, peg target/schedule in the gated policy artifact); `monitors[]`
per (chain, pool, feed) — breaker thresholds are never stored, read live
via the indexer's effective-threshold resolution (per-feed
`BreakerConfig.rateChangeThreshold`, falling back to
`Breaker.defaultRateChangeThreshold` when the per-feed field is the
inherit sentinel `0`); stable source ids decoupled from venue pair
spellings; roles `primary | secondary | display` (display has zero alert
authority); optional `convertVia` naming a rate-feed ID read via
`SortedOracles.medianRate` over existing bridge RPC (the
`oracle-reporters.json` identifiers are Mento rate-feed IDs, not Chainlink
aggregator contracts; declared error band widens that source's thresholds;
leg staleness — on-chain `medianTimestamp` + effective expiry resolved
token-first per the indexer's `fetchReportExpiry`, plus FX weekend
and reopen grace — demotes the source to display); `coverageClass` per
asset. Alert-affecting parameters —
per-source `refSize`, staleness gates, spread envelopes, and the
deep-venue designation — live in the gated thresholds JSON (ADR 0044),
not in the registry, so a bridge deploy cannot change page behavior
through registry data.
Referential-integrity script (asset- and source-level: threshold source
keys and the deep-venue designation must name registry source ids, and
alert-authoritative sources need complete policy) vs
`shared-config/oracle-reporters.json` and
token registry runs in the quality gate and CI; pool references are
resolved against Hasura at startup and re-validated continuously,
failing that asset's `indexed-pool` coverage path closed with a distinct
ops alert whenever resolution stops.

### Measurement (ADR 0045)

- Executable **sell** price at per-asset reference size — binding bound
  `min(FPMM per-window inflow limit, configured cap)`; the issuer
  redemption minimum is a default target only, the limit wins when lower
  (coverage recorded as degraded). Observation:
  `{vwap, filledFraction, capped, bid, ask, lastTradeAt, fetchedAt, venueState}`.
  Deviation is downside-only shortfall
  (`max(0, (target − executableSellPx)/target)` in bps); a sustained
  premium surfaces warn-tier only.
- `capped` observations never produce deviation — they feed depth-collapse
  stress. This is what keeps Kraken (16.5k near-par depth < ref size) from
  printing permanent phantom deviation while still contributing evidence.
  A capped deep venue also counts as blind (no usable primary price),
  keeping the blind-while-stressed critical path reachable during partial
  evacuation — but the stress leg must be independent of the capped
  condition (structural saturation, envelope-excess spread, or a
  partial-fill VWAP shortfall ≥ critical); capped-at-par depth thinning
  stays warn-tier.
- Venue states: `ok | wide | one_sided_bid | one_sided_ask | evacuated |
halted`. `wide` counts as stress only beyond the venue's observed diurnal
  spread envelope; thin-secondary book-shape states never escalate;
  `evacuated` requires the pair still present in the venue's live listing
  (else registry-rot, not stress).

### Structural signal (ADR 0042, 0045)

New bounded bridge companion queries on `SwapEvent`
(poolId+blockTimestamp index, `caller` identity; ≤1000-row page + explicit
saturation flag; no Hasura `_aggregate` per ADR 0014), already-polled
`reserves0/1`, and the indexed `TradingLimit` rows (`limit0`/`limit1`,
`netflow0`/`netflow1`, window update times) supplying the saturation
denominator. Token-native amounts (USD rollups are zero for EURm/EUROP).
Anomaly = net directional inflow vs trading-limit-implied max rate
(saturation fraction, per configured window on the monitored token's
inflow direction, max across active L0/L1 windows; the window-duration
source must be established in Phase 2 — the FPMM RPC surface exposes no
timesteps — and saturation fails closed until it is verified; lazy-reset
expiry applies; swap amounts normalized from raw token units into the
15-decimal TradingLimitsV2 scale before division). Counterparty diversity (`caller` = tx.from) is
dashboard-advisory only. Never pages alone; escalates price-based pages.

### Metrics (ADR 0042)

Own gauge module + reset lifecycle (CDP precedent), own loop from
`main.ts`, own error channels, never gates `/health`. Family:
`mento_peg_deviation_bps{asset,source}`, `mento_peg_executable_px`,
`mento_peg_filled_fraction`, `mento_peg_venue_state`,
`mento_peg_structural_saturation{asset}`, `mento_peg_source_healthy`,
`mento_peg_blind{asset}`, `mento_peg_observation_at{asset,source}`,
`mento_peg_last_poll{asset}`. All label values registry-bounded.

### Alerting (ADR 0044, 0045)

Thresholds in `alerts/rules/peg-thresholds.json`, read via
`jsondecode(file())` into `for_each`/`dynamic` rule generation; every
change passes the `production-infra` gate, and the gated apply also
publishes the same policy as an IaC-owned versioned runtime artifact
that the bridge polls (never baked into the image;
`mento_peg_policy_version` asserted by the rules with two-phase
rollover: previous + new version accepted until producer ack — never
expired by wall-clock alone — with a rollover-stuck alert when ack
exceeds the expected window; per-source poll cadences live in the same
artifact so coverage cannot be gamed by an ungated cadence change). Per-rule conventions: freshness
gate (`time() - mento_peg_observation_at`) on **every** peg rule;
`no_data_state = "Alerting"` (+~5 min grace, documented) on blindness and
heartbeat rules; duration-fraction sustain
(`quantile_over_time(0.2, deviation[W]) >= threshold`, W ≈ 20–30 min) so
one favorable sample cannot reset a real breach on a flapping thin book —
ANDed with a sample-coverage predicate — `increase` over a monotonic
`mento_peg_poll_success_total` vs expected cadence (timestamp-gauge
`changes` undercounts between scrapes; failed polls drop/stale the
series) — because range functions ignore gaps and a sparse post-outage
window must not read as sustained. `observation_at` advances only on an
authoritative venue-data timestamp/sequence, never on HTTP fetch success
alone; a frozen venue feed fails the source closed.

Ladder (EUROP initial values; per-asset data):

- **Critical (page, Splunk):** deep-venue uncapped deviation ≥ 50 bps
  sustained (duration-fraction). Pages alone; structural saturation or a
  second uncapped venue escalates priority. Also: blind-while-stressed.
- **Warn (Slack, repeat-suppressed):** uncapped deviation
  ≥ 25 bps sustained ≥ 10 min; deep-venue envelope-excess spread; structural
  saturation; blind ≥ M consecutive polls.
- **Ops-noise (Slack low-urgency):** source unhealthy (API errors, 429s);
  never pages. Distinct alerts: "source permanently dead" (N days),
  "critical path unreachable — re-onboard" (deep-venue loss, human ack).

### Onboarding playbook (runbook artifact per asset)

1. Census binds by contract address/issuer identity (never ticker):
   CoinGecko tickers → live order-book verification (executable depth at
   ref size, spread, freshness) → DexScreener/GeckoTerminal pool census →
   oracle-catalog sweep.
2. Classify sources into roles; write registry entry incl. rejected
   sources and why; declare `coverageClass`; onboarding fails if critical
   is unreachable or price/structural signals are circular (DEX-primary)
   without an explicit reviewed per-class policy.
3. Non-code gates: documented breaker-multisig signer SLA; verify pool
   trading limits bound drain to a survivable rate for that SLA.
4. Scheduled re-census diffs live venue listings vs registry (feeds the
   evacuation-vs-delisting discrimination and registry-rot alerts).

### EUROP instantiation

Primary: Bitvavo `EUROP-EUR` (deep venue). Secondary: Kraken `EUROPEUR`
(expected capped at ref size → depth/stress evidence). Display-only:
Kraken `EUROPUSD` (Chainlink EUR/USD conversion, ±15–30 bps band),
CoinGecko, DefiLlama. Excluded: Curve pool (dead), XRPL (no indexer
coverage), Bit2Me (stale). Structural: EURm/EUROP `SwapEvent` +
`reserves` saturation vs configured trading limits. Coverage class:
`cex-book+indexed-pool` (all paths reachable). Bridge egress must allow
`api.kraken.com`, `api.bitvavo.com` (+ aggregator hosts for display).

## Phasing

1. **PR 1 (this PR):** ADRs 0042–0045, this plan, docs catalog.
2. **PR 2:** bridge peg module — registry schema/fixtures, adapters
   (Kraken, Bitvavo), observation contract, structural queries, metrics,
   integrity script into gate/CI.
3. **PR 3:** alerts stack — `peg-thresholds.json`, rule group, routing,
   runbook note; gated apply after producer telemetry is live (follow the
   no-data rollout discipline from `docs/notes/polygon-monitoring.md`).
4. **PR 4:** dashboard decision-package panel + onboarding runbook doc +
   re-census job.

## Residual risks (accepted, documented)

- Books pinned at par + no pool flow + OTC-only discovery: undetectable by
  construction; mitigated only by issuer-relationship runbook inputs.
- Deep-venue push (~tens of k€ sustained) can force a page: accepted —
  page is human review, not automated action.
- Effective independent venue count for EUROP is ~1–2 (likely shared MM);
  quorum arithmetic is deliberately not load-bearing.

## Review history

- v1 reviewed by three adversarial lenses (ops reliability, repo fit,
  manipulation economics): killed mid-price measurement, silent gating,
  quorum fiction, thresholds-as-metrics, shared-config placement,
  in-bridge dwell, convertVia-in-composite.
- v2 re-attacked (system lens + feasibility verification): killed
  corroboration-required paging, undefined sub-refSize semantics,
  diversity as paging input, `min_over_time` dwell, warn-tier fatigue,
  delisting/evacuation conflation; verified structural-signal data
  availability (`SwapEvent`), gauge-lifecycle isolation (CDP precedent),
  RPC conversion reads, `jsondecode` + `for_each` precedents.
