---
title: Polygon monitoring coverage and rollout
status: active
owner: eng
canonical: true
last_verified: 2026-07-22
doc_type: runbook
scope: repo-wide
review_interval_days: 90
garden_lane: operator-runbooks
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
| EURm / USDm                | `0x93e15A22fDa39FEfcCCe82D387A09cCF030EAD61`       | Pools table/detail, TVL, 24h volume, global volume, open strategy state                                       |
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
new consumers must read the registry. At launch, USDC/USDm and EURm/EUROP used
the reserve strategy while EURm/USDm used the open strategy. EURm/EUROP then
registered the open strategy later, so the launch transaction alone is not the
complete configuration.

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

### Oracle freshness semantics

FPMM freshness follows `OracleAdapter` exactly: a rate remains valid until the
SortedOracles median report timestamp plus that feed's configured expiry. Pool
events and RPC reconciliation timestamps are diagnostic observations; they do
not renew the feed TTL. This distinction matters for the sparse Polygon
EUROP/EUR feed, whose configured expiry is one year. The USDC/USD and EUR/USD
feeds remain at 150 seconds.

The indexer reads the median timestamp at the event block, stores it in
`Pool.lastOracleReportAt`, and uses the prior report timestamp and prior expiry
when closing each health-counter interval. The dashboard and metrics bridge use
that exact anchor for status, uptime tails, and `mento_pool_oracle_ok`.
`Pool.oracleTimestamp` and `mento_pool_oracle_timestamp` remain raw diagnostic
timestamps only.

Deploying a change to these semantics requires a full Envio resync before
promotion. Existing rows and cumulative health counters were derived with the
older bounded-carry approximation and cannot be repaired safely in place.
Verify a candidate only after replay has populated positive
`lastOracleReportAt` values for all FPMMs and EURm/EUROP stays healthy inside
its configured one-year window. Tracked `OracleReported` and `MedianUpdated`
events now reject a missing exact-block median timestamp, and dRPC batches are
capped at three calls. A historical `[RPC_FAILURE] chainId=137
fn=medianTimestamp` on an older candidate makes that replay tainted even if its
hosted status later reaches head; deploy a fresh commit and replay cleanly.
The promotion verifier additionally reads the versioned
`indexer-envio/config/replay-integrity.json` marker from the deployed commit,
which prevents a pre-fix replay from passing solely because a later event made
the final pool row look current.

Version 2 also records the hosted-worker boundary discovered during the first
fail-closed replay: preload and processing must independently derive whether an
effect is needed. Module-local collections cannot bridge those passes because
Envio may place them in different workers or restart the process. The v1
candidate therefore remains incompatible even if it later appears caught up.

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
cut over. The `Polygon Pool Coverage Incomplete` rule intentionally treats no
data as alerting after 10 minutes, and the per-chain Aegis liveness rule does
the same after 5 minutes. The repository has no rollout mute for these rules;
the weekend mute timing is only for scheduled FX-market closure. Producer
telemetry must therefore be live before the protected `alerts-rules` apply is
approved.

Roll out in this order:

1. From the reviewed PR head, deploy the multichain Envio candidate to the
   `envio` branch without promoting it.
2. Wait for every chain to reach the hosted head; classify that state as
   `SYNCED_PENDING_DATA_VERIFY`. At the candidate endpoint,
   verify the three Polygon pools, two NTT tokens, bridge handlers, and exactly
   four active Polygon strategy rows: USDC/USDm Reserve, EURm/USDm Open, plus
   EURm/EUROP Reserve and Open. Then run the repository's commit-scoped
   deployment verifier. Only a passing semantic verifier makes the candidate
   ready to promote; `--allow-syncing` never waives Polygon integrity failures.
3. Merge the PR. This starts the metrics-bridge and Aegis production-service
   deploys and the protected Terraform workflows in parallel. Keep the
   `alerts-rules` `production-infra` approval pending.
4. With explicit human approval, promote the already caught-up candidate as
   soon as the PR lands, then wait for the static production endpoint to
   switch to it.
5. Wait for both service deploys to finish. Verify the static endpoint serves
   the Polygon rows, metrics-bridge exposes exactly three Polygon
   `mento_pool_health_status{chain_id="137"}` series plus successful strategy
   probes, and Aegis has recent successful
   `view_call_query_duration_count{chain="polygon",status="success"}` samples.
6. Only after those producer checks pass, approve the `alerts-rules` apply
   through its `production-infra` gate. Never apply the stack from an agent
   session. Other protected Polygon stacks still require their own reviewed
   plans and approvals, but they do not activate these no-data rules.
7. Verify the public dashboard in a browser: Polygon pool and volume filters,
   both NTT stable rows, bridge source/destination filters, pool detail for the
   dual-strategy EURm/EUROP pool, and integrations state.
8. Confirm the Polygon coverage and Aegis liveness rules are `Normal`, then
   exercise alert delivery only through the repository's documented safe test
   path.

Until the static endpoint and producer checks in steps 4-5 pass, `Configured`
is the correct status; do not describe Polygon as live.

### Rollback order

Rollback follows the dependency graph in reverse:

1. If the rollback target still publishes all required Polygon telemetry, use
   the normal commit-scoped Envio or service rollback and re-run the producer
   checks above.
2. If an Envio, metrics-bridge, or Aegis rollback would withdraw Polygon
   telemetry, first merge the corresponding Polygon alert-rule revert and wait
   for its protected `alerts-rules` apply to remove the dependent no-data rule.
   Confirm the rule is absent before rolling back the producer.
3. Roll back the producer, then verify the static endpoint, remaining metrics,
   and public dashboard. Do not use the FX-weekend mute timing as a deployment
   silence.
