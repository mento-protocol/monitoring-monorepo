<!-- agent-context: title="Mento v3 Envio HyperIndex Indexer" status=active owner=eng canonical=true last_verified=2026-07-22 doc_type=reference scope=indexer-envio review_interval_days=90 garden_lane=package-readmes-reference -->

# Mento v3 Envio HyperIndex Indexer

Multichain Envio HyperIndex indexer for Mento v3 — Ethereum reserve-yield (1),
Celo Mainnet (42220), Monad Mainnet (143), and Polygon Mainnet (137). Tracks FPMM pool activity,
oracle health, trading limits, rebalancer liveness, event-driven sUSDS reserve
yield, and stETH reserve yield with a sub-daily wallet balance sampler that
writes daily snapshots. The historical sUSDS `onBlock` heartbeat is
intentionally excluded from the hosted path.

## What It Does

Listens to on-chain events from Mento v3 contracts and writes structured entities to Postgres, exposed via Hasura GraphQL.

### Selected Events Indexed

The production config is the source of truth for the complete contract and
event list; the table highlights the main monitoring surfaces.

| Contract              | Events                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Broker                | `Swap` (legacy v2 settlement layer; Celo only - no Broker on Monad or Polygon)                                                                                                                                           |
| FPMMFactory           | `FPMMDeployed`                                                                                                                                                                                                           |
| FPMM (pool)           | `Swap`, `Mint`, `Burn`, `Transfer`, `UpdateReserves`, `Rebalanced`, `TradingLimitConfigured`, `LiquidityStrategyUpdated`, `LPFeeUpdated`, `ProtocolFeeUpdated`, `RebalanceIncentiveUpdated`, `RebalanceThresholdUpdated` |
| VirtualPool           | `Swap`, `Mint`, `Burn`, `UpdateReserves`, `Rebalanced`                                                                                                                                                                   |
| VirtualPoolFactory    | `VirtualPoolDeployed`, `PoolDeprecated`                                                                                                                                                                                  |
| SortedOracles         | `OracleAdded`, `OracleRemoved`, `OracleReported`, `OracleReportRemoved`, `MedianUpdated`, `ReportExpirySet`, `TokenReportExpirySet`                                                                                      |
| BiPoolManager         | `ExchangeCreated`, `ExchangeDestroyed`, `BucketsUpdated`, `SpreadUpdated`                                                                                                                                                |
| OpenLiquidityStrategy | `PoolAdded`, `PoolRemoved`, `LiquidityMoved`, `RebalanceCooldownSet`                                                                                                                                                     |
| ERC20FeeToken         | `Transfer` (dynamically registered from FPMMDeployed events)                                                                                                                                                             |
| BreakerBox            | `BreakerAdded`, `BreakerRemoved`, `BreakerStatusUpdated`, `RateFeedAdded`, `RateFeedRemoved`, `RateFeedDependenciesSet`, `BreakerTripped`, `ResetSuccessful`, `TradingModeUpdated`                                       |
| MedianDeltaBreaker    | `DefaultCooldownTimeUpdated`, `RateFeedCooldownTimeUpdated`, `DefaultRateChangeThresholdUpdated`, `RateChangeThresholdUpdated`, `SmoothingFactorSet`, `MedianRateEMAReset`                                               |
| ValueDeltaBreaker     | `DefaultCooldownTimeUpdated`, `RateFeedCooldownTimeUpdated`, `DefaultRateChangeThresholdUpdated`, `RateChangeThresholdUpdated`, `ReferenceValueUpdated`                                                                  |
| WormholeNttManager    | `TransferSent`, `TransferRedeemed`, `MessageAttestedTo`, `InboundTransferQueued`                                                                                                                                         |
| WormholeTransceiver   | `ReceivedMessage`                                                                                                                                                                                                        |

### Entities Written

| Entity group            | Description                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pool state              | `Pool`, `DeviationThresholdBreach`, `OracleSnapshot`, `OracleFeedState`, `OracleExpiryState`, `TradingLimit`                                                                    |
| Pool strategies         | `PoolLiquidityStrategy` (authoritative active many-to-many registry; `Pool.rebalancerAddress` is compatibility-only)                                                            |
| Pool activity           | `SwapEvent`, `LiquidityEvent`, `ReserveUpdate`, `RebalanceEvent`, `LiquidityPosition`, `FactoryDeployment`                                                                      |
| Pool rollups            | `PoolSnapshot`, `PoolDailySnapshot`, `PoolDailyVolumeSnapshot`, `PoolDailyFeeSnapshot`                                                                                          |
| Protocol fees           | `ProtocolFeeTransfer`                                                                                                                                                           |
| Legacy v2 / Broker      | `BrokerSwapEvent`, `BrokerDailySnapshot`, `BrokerExchangeDailySnapshot`, `BrokerTraderDailySnapshot`                                                                            |
| Broker aggregators      | `BrokerAggregatorDailySnapshot`, `BrokerAggregatorTraderDayMarker`, `BrokerVolumeWindowSnapshot`                                                                                |
| BiPoolManager           | `BiPoolExchange`, `BucketUpdate`                                                                                                                                                |
| VirtualPools            | `VirtualPoolLifecycle`                                                                                                                                                          |
| Open Liquidity Strategy | `OlsPool`, `OlsLiquidityEvent`, `OlsLifecycleEvent`                                                                                                                             |
| Circuit breakers        | `Breaker`, `BreakerConfig`, `BreakerTripEvent`, `RateFeedDependency`                                                                                                            |
| Bridge flows            | `BridgeTransfer`, `BridgeAttestation`, `BridgeDailySnapshot`, `BridgeBridger`, `WormholeNttManager`, `WormholeTransferDetail`, `WormholeDestPending`, `WormholeTransferPending` |
| Volume and participants | `TraderDailySnapshot`, `TraderPoolDailySnapshot`, `AggregatorDailySnapshot`, `VolumeWindowSnapshot`                                                                             |
| Reserve yield           | Ethereum sUSDS/stETH movement, cost-basis, position, summary, and daily-snapshot entities; stETH also records `StethWalletLaunchBaseline` for the balance sampler               |

### Pool ID Format

All entity IDs are namespaced by chain: `{chainId}-{address}` (e.g. `42220-0x02fa...`, `143-0xd0e9...`).
This prevents collisions when the same contract address is deployed on multiple chains.

## Configuration

| File                                 | Networks                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `config.multichain.mainnet.yaml`     | Ethereum reserve-yield + Celo + Monad + Polygon mainnets (default/production) |
| `config.multichain.testnet.yaml`     | Celo Sepolia + Monad Testnet + Polygon Amoy                                   |
| `config.multichain.bridge-only.yaml` | Local Celo + Monad + Polygon bridge-flow validation harness                   |

`config/protocolActors.json` contains manual protocol-controlled caller and
entry-point overrides for the dashboard volume filter. Pool liquidity-strategy
cardinality comes from `PoolLiquidityStrategy`. The populated
`Pool.rebalancerAddress` compatibility pointer remains the swap-time fast path
for dynamic strategies, while named strategies are also discovered from the
contracts manifest. Add manual entries only for protocol actors that cannot be
derived from those sources or normal NTT address metadata.

Deploy branch: `envio` → triggers hosted reindex on push.

## Local Development

### Prerequisites

- Node.js 24 LTS
- pnpm 11.x
- Docker Desktop (runs Postgres + Hasura locally)

### Setup

```bash
cp indexer-envio/.env.example indexer-envio/.env
# Mainnet defaults (forno, rpc2.monad.xyz, polygon.drpc.org) work out of the box.
# dRPC transports are capped at three calls per JSON-RPC batch for replay safety.
# For testnet, set ENVIO_API_TOKEN or override ENVIO_RPC_URL_10143.
# For a custom Celo Sepolia provider, set ENVIO_RPC_URL_CELO_SEPOLIA for event
# sync and ENVIO_RPC_URL_11142220 for handler eth_call reads.
# For reserve-yield, set ENVIO_RPC_URL_1 to an archive-capable Ethereum RPC
# before replaying old sUSDS/stETH events locally.

# Generate types + start multichain indexer
pnpm indexer:codegen && pnpm indexer:dev
```

Hasura console: `http://localhost:8080` (admin secret: `testing`)
GraphQL endpoint: `http://localhost:8080/v1/graphql`

### Local stack invariants

- The wrapper reads `indexer-envio/.env`; `.env.example` is the current variable
  reference. Do not set generic `ENVIO_RPC_URL` in multichain mode because it
  routes chain-specific reads to one endpoint. Per-chain fallback RPCs must
  cover the full replay/archive window as well as rate-limit failover. Celo
  Sepolia event sync uses `ENVIO_RPC_URL_CELO_SEPOLIA`; handler contract reads
  use `ENVIO_RPC_URL_11142220`, so a full provider override sets both.
- Polygon dRPC transports retain batching with a three-call cap. Transient
  rate-limit and HTTP 5xx errors retry and use a same-block fallback when one is
  configured. A tracked feed bootstraps timestamps plus raw expiry at the parent
  block when existing pool state predates the event, or at block close otherwise.
  Missing or malformed data fail before writes. Later events update
  `OracleFeedState` and `OracleExpiryState` in log order; zero token expiry uses
  the persisted global fallback. This removes per-event archive reads.
- Hasura must use port 8080. Envio's startup liveness URL is hard-coded to that
  port, so a different `HASURA_EXTERNAL_PORT` stalls startup. All configs also
  share Docker project `generated`; run only one local indexer at a time.
- Run codegen through the package scripts, not `envio codegen` directly. The
  wrapper patches the generated Postgres service with the `pg_isready`
  healthcheck that Envio's dev loop requires.
- Every config points at `src/EventHandlers.ts`. New handler modules must be
  side-effect imported there, followed by `pnpm indexer:codegen`, or Envio will
  not register them.

### Available Commands (from repo root)

```bash
pnpm indexer:codegen                # Generate types (multichain mainnet — Ethereum reserve-yield + Celo + Monad + Polygon)
pnpm indexer:dev                    # Start local multichain mainnet indexer
pnpm indexer:testnet:codegen        # Generate types (multichain testnet — Celo Sepolia + Monad testnet + Polygon Amoy)
pnpm indexer:testnet:dev            # Start local multichain testnet indexer
pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:test     # Codegen mainnet config, run sUSDS/stETH tests, restore mainnet codegen
pnpm deploy:indexer                 # Push to envio branch → triggers hosted reindex
pnpm deploy:indexer:status <commit> --watch --compact  # Low-noise wait for registration + sync
pnpm deploy:indexer:logs <commit> --build    # Show build logs for a deployment
pnpm deploy:indexer:logs <commit> --level error,warn --since 2h  # Show runtime issues
pnpm deploy:indexer:metrics <commit>         # Show per-chain indexing progress
pnpm deploy:indexer:info <commit>            # Show deployment info/cache state
pnpm deploy:indexer:perf <commit>            # Combined status/metrics/log snapshot for perf comparisons
pnpm deploy:indexer:verify <commit>          # Gate promotion on sync, core rows, and Polygon replay semantics
pnpm deploy:indexer:promote <commit>         # Promote a synced deployment to prod
```

### From `indexer-envio/` directory

```bash
pnpm codegen    # Generate types
pnpm dev        # Start indexer stack
pnpm start      # Start without codegen
pnpm stop       # Stop Docker containers
pnpm test:mutation     # Targeted StrykerJS pure-logic baseline
pnpm knip:report       # Report-only unused-file/export/dependency scan
```

### Promoting a new contracts deployment

When a new `@mento-protocol/contracts` version is published:

1. Update the version in `indexer-envio/package.json` and
   `ui-dashboard/package.json`.
2. Update the affected namespace in
   `shared-config/deployment-namespaces.json`.
3. Run `pnpm install` from the repository root.
4. From `indexer-envio/`, run `pnpm generate:abis` and commit any vendored ABI
   changes.
5. Run `pnpm check:yaml-addresses`, then run codegen and the dashboard and
   indexer typechecks selected by the root quality gate.

### Adding a contract to the index

1. If the ABI ships in `@mento-protocol/contracts`, add its filename to
   `scripts/generateAbis.mjs` and run `pnpm generate:abis`. Otherwise hand-vendor
   the minimal ABI under `abis/` and record the exclusion in that script's
   header.
2. Add the contract to every applicable `config.multichain.*.yaml`.
3. Add or update entities in `schema.graphql`.
4. Add the handler under `src/handlers/` and import a new handler module from
   `src/EventHandlers.ts`.
5. Run `pnpm codegen` and the cross-layer checklist in
   [`docs/pr-checklists/stateful-data-ui.md`](../docs/pr-checklists/stateful-data-ui.md).

### Performance Diagnostics

Enable opt-in sync profiling when comparing local replays or a hosted debug
deployment:

```bash
INDEXER_PERF=1 INDEXER_PERF_LOG_INTERVAL_EVENTS=10000 pnpm indexer:dev
```

The profiler logs the slowest handlers, effect request/execution counts
(`hit~` is request count minus effect handler executions, i.e. preload/cache
dedup), and entity get/set counters. It is disabled by default and has no
runtime effect unless `INDEXER_PERF` is truthy.

For hosted comparisons, use `pnpm deploy:indexer:perf <commit>` to capture the
deployment registry row, per-chain status/metrics, build highlights, and recent
warn/error logs in one snapshot. For local Envio CLI checks, `envio@3.2.1`
also includes `envio metrics runtime` and `envio tools search-docs` /
`envio tools fetch-docs`.

Before removing `schema.graphql` indexes, run the static usage audit:

```bash
node indexer-envio/scripts/auditSchemaIndexes.mjs
```

The audit maps `@index` directives to handler `getWhere` calls and
dashboard/bridge GraphQL `where`, `order_by`, and `distinct_on` usage, including
known dynamic discovery queries. Treat the output as a review aid, not an
automatic deletion list.

## Schema

See [`schema.graphql`](./schema.graphql) for the full entity model.

Key design decisions:

- `PoolSnapshot` uses hourly buckets (forward-fill for charts is done in the dashboard)
- `TradingLimit` has composite ID: `{poolId}-{tokenAddress}`
- All BigInt fields use string representation in GraphQL responses

## Example Queries

**Recent swaps:**

```graphql
query RecentSwaps {
  SwapEvent(limit: 20, order_by: { blockTimestamp: desc }) {
    id
    chainId
    poolId
    amount0In
    amount1In
    amount0Out
    amount1Out
    txHash
    blockTimestamp
  }
}
```

**Pool health state:**

```graphql
query PoolHealth {
  Pool {
    id
    chainId
    token0
    token1
    healthStatus
    oracleOk
    priceDifference
    rebalanceThreshold
    limitStatus
    limitPressure0
    limitPressure1
    rebalanceLivenessStatus
  }
}
```

## Deployment

Push to the `envio` branch to trigger a hosted reindex:

```bash
COMMIT=$(git rev-parse HEAD)
pnpm deploy:indexer
pnpm deploy:indexer:status "$COMMIT" --watch --compact
pnpm deploy:indexer:logs "$COMMIT" --build
pnpm deploy:indexer:logs "$COMMIT" --level error,warn --since 2h
pnpm deploy:indexer:perf "$COMMIT"
pnpm deploy:indexer:verify "$COMMIT"
pnpm deploy:indexer:promote "$COMMIT"
```

A caught-up watcher exit is `SYNCED_PENDING_DATA_VERIFY`, not promotion
readiness. The verifier must pass the canonical Polygon FPMM feed/expiry,
oracle-anchor, snapshot-cursor, and health-counter checks before promotion.
It also reads `config/replay-integrity.json` from the deployed commit. That
versioned marker is the commit-scoped proof that the candidate was replayed by
code enforcing the current oracle-freshness invariant; a candidate whose
commit lacks the required version is never promotion-compatible even if later
rows look healthy. Bump a marker only in the same change as the new replay
invariant and its handler-level regression tests.

Replay-integrity v3 replaces traffic-scaled exact `medianTimestamp` reads with
a persisted, event-sourced `OracleFeedState`. On the first tracked
`OracleReported` or `OracleReportRemoved`, processing performs one
exact-boundary `getTimestamps` bootstrap and obtains raw/effective expiry
configuration from that same boundary. It validates the
reporter/timestamp arrays, computes SortedOracles' upper median, then applies
`OracleReported` upserts and `OracleReportRemoved` deletions in block/log order.
`MedianUpdated` consumes that state but does not renew freshness itself. When
no currently referencing pool row predates the initialization block, exact
block-close state absorbs that block's logs so a report before deployment or
feed self-heal cannot be stranded outside a parent snapshot; later blocks use
log order. `OracleExpiryState` stores raw global/token and effective expiry at
the same bootstrap boundary, then applies both expiry events by block/log
cursor. A zero token value derives the persisted global fallback without a
block-close RPC inside the event, and never-tracked feeds create no state.
Missing or malformed bootstrap data fails before entity writes. This is a
full-replay boundary: v1 and v2 candidates are incompatible with v3 even when
their final pool rows happen to look healthy.

The inherited replay-integrity v2 requirement still applies: effect eligibility
must be derived independently in both Envio passes. Never carry preload
decisions in any module-scoped mutable marker because hosted preload and
processing workers, and restarted processes, do not share that memory. The
code-health invariant follows every `onEvent`, `onBlock`, and
`contractRegister` callback plus imported helpers. It rejects direct and
symbol-propagated assignment, update, deletion, object/record write, and native
collection/array mutator forms for top-level bindings, including primitive,
object, array, native-collection, and factory-result state. Returned module-
state aliases and custom receiver methods that mutate through `this` remain a
manual-review requirement tracked in
[#1462](https://github.com/mento-protocol/monitoring-monorepo/issues/1462).
Narrow processing-only exceptions require an adjacent `phase-state-exempt`
reason and tracking issue at each mutation. Rebuildable optimization caches
whose loss can only repeat authoritative/idempotent work use an adjacent
`phase-state-cache` reason at each write.

The `mento` project on Envio Cloud watches this branch. Envio registers
deployments under the short commit hash, and the registration can lag the Git
push by several minutes. Use the explicit commit form above while babysitting a
new deploy; the no-commit logs/promote helpers intentionally operate on the
latest deployment currently visible to Envio, which may still be the old prod
deployment during registration lag. Promote the caught-up deployment before
treating it as live. The static production endpoint never changes on redeploy:

```
https://indexer.hyperindex.xyz/2f3dd15/v1/graphql
```

See [`STATUS.md`](./STATUS.md) for the static endpoint and deployment reference.

## Key Files

| File                                | Purpose                                                 |
| ----------------------------------- | ------------------------------------------------------- |
| `schema.graphql`                    | Entity model                                            |
| `src/EventHandlers.ts`              | Event → entity mapping                                  |
| `src/oracleFeedState.ts`            | Pure event-sourced oracle timestamp-list transitions    |
| `src/handlers/oracleFeedState.ts`   | Feed bootstrap, removal handling, and pool propagation  |
| `src/helpers.ts`                    | `makePoolId`, `poolIdToAddress` utilities               |
| `src/rpc.ts` + `src/rpc/`           | RPC read helpers (per-chain clients, effects, fallback) |
| `config.multichain.mainnet.yaml`    | Production config (Ethereum + Celo + Monad + Polygon)   |
| `config/deployment-namespaces.json` | Vendored namespace map for hosted builds                |
| `abis/`                             | Vendored contract ABI subsets                           |
