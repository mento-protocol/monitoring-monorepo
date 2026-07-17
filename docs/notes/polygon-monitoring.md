---
title: Polygon monitoring coverage and rollout
status: active
owner: eng
canonical: true
last_verified: 2026-07-17
---

# Polygon monitoring coverage and rollout

This note is the operator-facing inventory for Polygon support added in PR
#1292. It answers three separate questions:

1. Which Polygon contracts and state transitions are collected?
2. Where can an operator see that state?
3. Which conditions notify or page, and which gaps are deliberately tracked?

The deployment source of truth is
`@mento-protocol/contracts@0.9.0`, pinned exactly in `shared-config/` and
`indexer-envio/`. The production chain is Polygon mainnet (`137`, Wormhole
chain `5`). Polygon Amoy (`80002`) is wired into the testnet indexer and
dashboard behind the existing testnet endpoint environment variables; it is
not part of the production alert SLO.

## Production inventory

The Envio chain starts at block `90273661`, before the Polygon stable-token and
NTT helper deployments. The first three `FPMMDeployed` events are at block
`90348018`; the startup guard refuses an override that would skip them.

| Surface                    | Address or identity                                | Collection and presentation                                                                                   |
| -------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| FPMM factory               | `0xa849b475FE5a4B5C9C3280152c7a1945b907613b`       | Dynamic pool discovery, configuration, swaps, liquidity, limits, fees, oracle state, breakers, and rebalances |
| USDC / USDm                | `0x463c0d1F04bcd99A1efCF94AC2a75bc19Ea4A7E5`       | Pools table/detail, TVL, 24h volume, global volume, reserve strategy state                                    |
| EURm / USDm                | `0x93e15A22fDa39FEfcCCe82D387A09cCF030EAD61`       | Pools table/detail, TVL, 24h volume, global volume, reserve strategy state                                    |
| EURm / EUROP               | `0xCd8C6811d975981F57E7fB32e59f0BeE66aF3201`       | Pools table/detail, TVL, historical USD volume, open and reserve strategy state                               |
| Open liquidity strategy    | `0x54e2Ae8c8448912E17cE0b2453bAFB7B0D80E40f`       | Strategy registry plus OLS liquidity/lifecycle history                                                        |
| Reserve liquidity strategy | `0xa0fB8b16ce6AF3634fF9F3f4F40E49E1C1ae4f0B`       | Strategy registry and live rebalance probes                                                                   |
| ReserveV2                  | `0x4255Cf38e51516766180b33122029A88Cb853806`       | Aegis reserve balances and strategy reads                                                                     |
| EURm NTT                   | token `0x4D502d735B4C574B487Ed641ae87cEaE884731C7` | Burning-mode supply plus source/destination bridge progression                                                |
| USDm NTT                   | token `0xBC69212B8E4d445b2307C9D32dD68E2A4Df00115` | Burning-mode supply plus source/destination bridge progression                                                |
| Reserve Safe               | `0x87647780180B8f55980C7D3fFeFe08a9B29e9aE1`       | QuickNode event delivery to Slack after the alerts-infra rollout                                              |
| Migration multisig         | `0x58099B74F4ACd642Da77b4B7966b4138ec5Ba458`       | QuickNode event delivery to Slack after the alerts-infra rollout                                              |

`PoolLiquidityStrategy` is the canonical many-to-many registry. The legacy
single `Pool.rebalancerAddress` pointer remains populated for old readers, but
new consumers must read the registry. This matters on EURm/EUROP: the reserve
strategy was active at launch and the open strategy was registered later, so
the launch transaction alone is not the complete configuration.

## Data and dashboard coverage

| Operator question                        | Source                                                                   | Dashboard behavior                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Are all pools present and healthy?       | `Pool`, `PoolLiquidityStrategy`, `TradingLimit`, breaker/oracle entities | Home, `/pools`, and `/volume` expose URL-backed All/Celo/Monad/Polygon filters; pool detail renders every registered strategy                           |
| What is Polygon volume?                  | Pool and global volume snapshots                                         | 24h pool tiles/table, volume hero, time series, and flow insights can be isolated to Polygon                                                            |
| How is EURm/EUROP converted to USD?      | Historical same-chain EURm/USDm median                                   | Each swap uses the latest non-future rate within the freshness window; a missing/stale rate skips USD aggregation instead of inventing volume           |
| What stable supply exists?               | Polygon EURm/USDm NTT managers                                           | `/stables` includes both burning-mode spokes and keeps chain identity in aggregates                                                                     |
| Where are NTT transfers?                 | `BridgeTransfer`, Wormhole detail/attestation, daily and bridger rollups | `/bridge-flows` supports URL-backed Polygon source/destination/status filters, route-aware OG metadata, and Polygon manual-redeem handling              |
| Which external routes quote Mento pools? | Scheduled integration probes                                             | All nine configured adapters run Polygon probes with provider-specific chain identifiers; `/integrations` renders the resulting chain state dynamically |

Bridge status remains progression-based: `PENDING`, `SENT`, `ATTESTED`,
`QUEUED_INBOUND`, then a terminal state. The dashboard overlays `STUCK` when a
transfer remains `SENT` for 1 hour, `ATTESTED` for 15 minutes, or
`QUEUED_INBOUND` for 24 hours. Alert delivery for those ages is intentionally
tracked separately in #1362 because it requires a new bounded-cardinality
exporter and degraded-mode contract.

## Alert conditions

The ordinary v3 FPMM rule groups apply to Polygon automatically because the
metrics carry `chain_id="137"` and `chain_name="polygon"`. The source files in
`alerts/rules/rules-fpmms*.tf` remain the executable threshold authority. The
Polygon-specific coverage and delivery decisions are:

| Condition                                                                  | Hold                                         | Severity and route                                                | Why                                                                         |
| -------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Metrics bridge exports fewer than 3 Polygon FPMMs, including no series     | 10 minutes                                   | critical to `#alerts-critical`                                    | Prevents a healthy Celo/Monad fleet from hiding a missing Polygon chain     |
| Aegis has no successful Polygon production view call                       | 5-minute rule hold over a 10-minute lookback | page to `#alerts-critical` and Splunk On-Call                     | Detects a chain-specific RPC/config outage even while other chains poll     |
| More than 10 Polygon production view-call failures in 5 minutes            | 5 minutes                                    | page to `#alerts-critical` and Splunk On-Call                     | Detects sustained contract-read failure                                     |
| Polygon ReserveV2 USDC balance equals exactly zero                         | 5 minutes                                    | page to `#alerts-critical`, Splunk On-Call, and `#alerts-reserve` | USDC/USDm reserve expansion is unavailable                                  |
| Polygon ReserveV2 EUROP balance equals exactly zero                        | 5 minutes                                    | page to `#alerts-critical`, Splunk On-Call, and `#alerts-reserve` | EURm/EUROP reserve expansion is unavailable                                 |
| Reserve Safe or Migration multisig executes or changes ownership/threshold | event-driven                                 | Slack multisig channel                                            | Governance/treasury control-plane activity must not wait for a scrape cycle |

The reserve predicates are deliberately exact-zero only. Operational nonzero
floors need treasury-owned SLOs and are tracked in #1332; the monitoring stack
must not guess them. Stuck bridge-transfer paging is tracked in #1362.

## Rollout order and proof

The code being merged is configuration, not proof that production has already
cut over. Roll out in this order:

1. Merge and apply the alert Terraform plans through their normal protected
   production workflows. Never apply either stack from an agent session.
2. Deploy the multichain Envio configuration to the `envio` branch.
3. Wait for chain `137` to reach the hosted head and verify the three pools,
   two NTT tokens, strategy registry, and bridge handlers at the candidate
   deployment endpoint.
4. Promote the candidate to the static production endpoint.
5. Verify metrics-bridge exposes exactly three Polygon
   `mento_pool_health_status` series and successful strategy probes.
6. Verify the public dashboard in a browser: Polygon pool and volume filters,
   both NTT stable rows, bridge source/destination filters, pool detail for the
   dual-strategy EURm/EUROP pool, and integrations state.
7. Confirm the Polygon coverage and Aegis liveness rules are `Normal`, then
   exercise alert delivery only through the repository's documented safe test
   path.

Until steps 2-5 finish, `Configured` is the correct status; do not describe
Polygon as live at the static production endpoint.
