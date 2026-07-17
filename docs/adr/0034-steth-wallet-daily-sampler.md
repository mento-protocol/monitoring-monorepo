---
title: stETH actuals use a launch-aligned sub-daily wallet balance sampler
status: active
owner: eng
canonical: true
last_verified: 2026-07-07
scope: indexer-envio
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0034 — stETH actuals use a launch-aligned sub-daily wallet balance sampler

**Status:** Accepted (Jul 2026), in force.
**Scope:** indexer-envio (constrains ui-dashboard reserve-yield reads)

## Context

stETH rewards accrue through Lido rebases. Transfer logs show wallet movements
but do not emit the quiet-period balance growth that turns into earned reserve
yield. The dashboard needs launch-aligned actuals from the v3 revenue start
date, not lifetime stETH appreciation before the revenue dashboard existed.

## Decision

Keep reserve-yield in the single hosted Envio deployment from ADR 0012, but add
a bounded stETH sampler:

- Create one launch baseline per tracked wallet at Ethereum block `24573203`,
  the final block before `2026-03-03T00:00:00Z`.
- Poll tracked stETH wallet balances every 600 produced Ethereum blocks
  (roughly two hours) and persist wallet-level daily
  `StethYieldDailySnapshot` rows.
- Allocate future stETH earned yield to the wallet where it accrued, even when
  principal later moves between tracked reserve wallets.
- Leave sUSDS event-only and do not reintroduce the historical sUSDS heartbeat.

## Alternatives considered

- **Continue stETH forecast-only in the dashboard** — rejected: it hides actual
  earned reserve yield after launch and forces reviewers to accept a weaker
  canonical revenue story than sUSDS.
- **Treat transfer-ledger balance drift as yield without historical
  `balanceOf` reads** — rejected: stETH rebases happen without transfer logs, so
  transfer-only state undercounts quiet-period actuals.
- **Poll every Ethereum block** — rejected: daily reserve-yield actuals do not
  need block-level precision, and a high-cadence heartbeat would re-create the
  hosted replay risk that ADR 0012 avoided for sUSDS.

## Consequences

- stETH has launch-aligned actual snapshots, while sUSDS remains event-only.
- The dashboard reads stETH daily rows by `chainId:token:wallet` so it does not
  merge earnings from different reserve wallets into one token-level stream.
- If the launch-block stETH balance read is unavailable, the launch baseline
  handler fails so Envio retries the launch block before post-launch movements
  can mutate wallet positions. Later heartbeat samples require those baselines
  to already exist.
- If any later historical stETH balance read is unavailable, the sampler skips
  the affected snapshot batch instead of writing partial wallet actuals.
- Hosted deploy verification for reserve-yield changes should check both
  `SusdsYieldDailySnapshot` and `StethYieldDailySnapshot` rows.

## Evidence

- Ethereum launch boundary: block `24573203` has timestamp `1772495999`, and
  block `24573204` has timestamp `1772496011`.
- The writer tests in `indexer-envio/test/steth.test.ts` cover launch-baseline
  exclusion, wallet-level allocation after internal transfer, and degraded
  historical-balance reads.
