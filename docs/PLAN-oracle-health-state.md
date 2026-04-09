# Plan: Oracle & Health State in the Indexer + Dashboard

## Goal

Transform the monitoring dashboard from a swap log into an operational health tool. Add the core signals the ops team needs at a glance: **oracle liveness**, **deviation ratio**, **rebalancer health**, and **trading limit pressure**.

## Context

### What we have today

- Pool entity with reserves, swap counts, cumulative volumes
- PoolSnapshot hourly aggregation
- SwapEvent, LiquidityEvent, RebalanceEvent, ReserveUpdate entities
- Dashboard: pool list table, pool detail page with reserve chart

### What's missing

The dashboard shows _what happened_ but not _is everything healthy right now_. Roman's monitoring spec defines 5 KPIs — none are in the schema yet.

### On-chain data sources (verified on mainnet)

Each FPMM/VirtualPool has:

| Function                | Returns                                                                                                                                               | Notes                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `getRebalancingState()` | `oraclePriceNum`, `oraclePriceDenom`, `reservePriceNum`, `reservePriceDenom`, `reservePriceAboveOraclePrice`, `rebalanceThreshold`, `priceDifference` | Single call gets oracle + deviation state |
| `oracleAdapter()`       | `address`                                                                                                                                             | Points to shared OracleAdapter proxy      |
| `referenceRateFeedID()` | `address`                                                                                                                                             | Rate feed identifier for this pool        |

OracleAdapter (`0xa472fBBF4b890A54381977ac392BdF82EeC4383a`):

| Function                     | Returns                    | Notes                                    |
| ---------------------------- | -------------------------- | ---------------------------------------- |
| `hasRecentRate(rateFeedID)`  | `bool`                     | Is oracle data fresh?                    |
| `getTradingMode(rateFeedID)` | `uint8`                    | 0=bidirectional, >0=restricted           |
| `getRateIfValid(rateFeedID)` | `numerator`, `denominator` | Current oracle rate (reverts if invalid) |
| `isFXMarketOpen()`           | `bool`                     | Global FX market hours check             |
| `sortedOracles()`            | `address`                  | → SortedOracles contract                 |

SortedOracles (`0xefB84935239dAcdecF7c5bA76d8dE40b077B7b33`):

| Function                                  | Returns                    | Notes                                       |
| ----------------------------------------- | -------------------------- | ------------------------------------------- |
| `medianRate(rateFeedID)`                  | `numerator`, `denominator` | Current oracle price (24 decimal precision) |
| `medianTimestamp(rateFeedID)`             | `uint256`                  | When the oracle price was last updated      |
| `getTokenReportExpirySeconds(rateFeedID)` | `uint256`                  | How long before a report goes stale         |
| `isOldestReportExpired(rateFeedID)`       | `bool`, `address`          | Is the oldest report expired?               |
| `numRates(rateFeedID)`                    | `uint256`                  | Number of active oracle reports             |

**Real mainnet values (pool 0x8c00...cb56, USDm/GBPm):**

- Oracle rate: 1.33386 (GBP/USD)
- Reserve price ratio: 8977/8032 ≈ 1.1176
- Rebalance threshold: 5000 (50 bps)
- Price difference: 4912
- Oracle timestamp: 1772697426 (fresh)
- Report expiry: 360 seconds
- Number of oracle reporters: 1
- FX market: open

### Key insight: Event-driven vs RPC-polled state

**Problem:** Oracle state (liveness, price, timestamp) doesn't change via indexable events. The `OracleReported` event is on SortedOracles, not on the pools we index. And the critical `hasRecentRate` check is a pure view function that computes freshness at call time.

**Options:**

| Approach                                                | Pros                                                                | Cons                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| A. Index SortedOracles.OracleReported                   | Event-driven, pure Envio                                            | Need to map rateFeedID → pool; miss expired-without-new-report transitions       |
| B. RPC calls in Envio handlers                          | Gets live state on every swap/rebalance                             | Envio supports `eth_call` in handlers; state only updates when pool has activity |
| C. Aegis/external poller                                | Independent of Envio; purpose-built for monitoring                  | Extra service to deploy; duplicates some data                                    |
| D. Hybrid: Index OracleReported + RPC on UpdateReserves | Best of A+B; catches oracle updates AND refreshes state on activity | More complex handlers                                                            |

**Recommendation: Approach D (Hybrid)** — index `SortedOracles.OracleReported` events for the oracle price timeline, AND do an `eth_call` to `getRebalancingState()` inside the `UpdateReserves`/`Rebalanced` handler to capture the pool's view of oracle health at the time of activity. This gives us:

- Historical oracle price data (from events)
- Fresh pool-level health state (from RPC calls on activity)
- No extra services to deploy

For truly real-time oracle monitoring (detecting staleness when NO activity happens), we'll need Aegis later. But this gives us 90% of the value now.

---

## Schema Changes

### Pool entity — new fields

```graphql
type Pool {
  # ... existing fields ...

  # Oracle state (updated on UpdateReserves / Rebalanced / OracleReported)
  oracleOk: Boolean! # hasRecentRate && tradingMode == 0
  oraclePrice: BigInt! # numerator from medianRate (24 decimals)
  oraclePriceDenom: BigInt! # denominator (24 decimals)
  oracleTimestamp: BigInt! # when oracle was last updated
  oracleExpiry: BigInt! # report expiry seconds for this rate feed
  oracleNumReporters: Int! # number of active oracle reporters
  referenceRateFeedID: String! # the rate feed address for this pool
  # Deviation / rebalance state (updated on Rebalanced / UpdateReserves)
  priceDifference: BigInt! # from getRebalancingState
  rebalanceThreshold: Int! # in bps (e.g. 5000 = 50 bps)
  lastRebalancedAt: BigInt! # timestamp of last Rebalanced event
  # Computed health status
  healthStatus: String! # "OK" | "WARN" | "CRITICAL"
}
```

### New entity: OracleSnapshot

```graphql
type OracleSnapshot @index(fields: ["poolId", "timestamp"]) {
  id: ID!
  poolId: String! @index
  timestamp: BigInt! @index

  # Oracle state at this point in time
  oraclePrice: BigInt!
  oraclePriceDenom: BigInt!
  oracleOk: Boolean!
  numReporters: Int!

  # Deviation state
  priceDifference: BigInt!
  rebalanceThreshold: Int!

  # Source event
  source: String! # "oracle_reported" | "update_reserves" | "rebalanced"
  blockNumber: BigInt!
}
```

### New entity: TradingLimitState

Not in this slice — requires deeper investigation of the `getTradingLimits()` return type (complex nested tuple). Defer to a follow-up.

---

## Implementation Steps

### Phase 1: SortedOracles indexing (indexer)

**1.1 Add SortedOracles ABI**

- Extract from `mento-core/out/SortedOracles.sol/SortedOracles.json`
- Copy to `indexer-envio/abis/SortedOracles.json`
- We only need: `OracleReported`, `MedianUpdated`

**1.2 Add SortedOracles to config files**

All three configs (`devnet`, `sepolia`, `mainnet`) need:

```yaml
- name: SortedOracles
  abi_file_path: abis/SortedOracles.json
  address:
    - <SortedOracles address per network>
  handler: src/EventHandlers.ts
  events:
    - event: OracleReported
    - event: MedianUpdated
```

Mainnet SortedOracles: `0xefB84935239dAcdecF7c5bA76d8dE40b077B7b33`
Sepolia + DevNet: TBD (query `OracleAdapter.sortedOracles()` on those networks)

**1.3 Map rateFeedID → poolId**

Build a lookup from `referenceRateFeedID` → pool address. Two approaches:

- **Static:** Query `referenceRateFeedID()` for all known pools at startup and hardcode in the handler
- **Dynamic:** On pool creation (FPMMDeployed/VirtualPoolDeployed), do an `eth_call` to `referenceRateFeedID()` and store in Pool entity

Recommendation: Dynamic. Add `referenceRateFeedID` field to Pool on creation.

### Phase 2: Pool health fields (indexer)

**2.1 Initialize oracle fields on Pool creation**

In the `FPMMDeployed` / `VirtualPoolDeployed` handlers, after creating the Pool entity:

- `eth_call` to `referenceRateFeedID()` → store on Pool
- `eth_call` to `getRebalancingState()` → populate initial oracle/deviation fields
- `eth_call` to SortedOracles `getTokenReportExpirySeconds(rateFeedID)` → store `oracleExpiry`

**2.2 Update oracle state on UpdateReserves**

In the existing `FPMM.UpdateReserves` handler, add:

- `eth_call` to `getRebalancingState()` on the pool
- Update Pool fields: `priceDifference`, `rebalanceThreshold`, `oraclePrice`, `oraclePriceDenom`
- `eth_call` to OracleAdapter `hasRecentRate(rateFeedID)` → update `oracleOk`
- Create `OracleSnapshot` entity

**2.3 Update on Rebalanced events**

In the existing `FPMM.Rebalanced` handler, add:

- Same `eth_call`s as 2.2
- Update `lastRebalancedAt` on Pool
- Compute `healthStatus`:
  ```
  if (!oracleOk) → "CRITICAL"
  else if (priceDifference > rebalanceThreshold * 0.8) → "WARN"
  else → "OK"
  ```

**2.4 Handle SortedOracles.OracleReported events**

New handler:

- Look up which pool(s) use this rateFeedID
- Update Pool oracle fields
- Create OracleSnapshot

**2.5 Handle SortedOracles.MedianUpdated events**

New handler:

- Update Pool `oraclePrice` / `oraclePriceDenom`
- Create OracleSnapshot

### Phase 3: Dashboard health indicators (UI)

**3.1 Pool list: health badge**

Add a "Status" column to the pool list table:

- 🟢 **OK** — oracle fresh, deviation within threshold
- 🟡 **WARN** — oracle fresh but deviation > 80% of threshold
- 🔴 **CRITICAL** — oracle stale or deviation > threshold

Color the entire row subtly (green/yellow/red background).

**3.2 Pool detail: health panel**

Add a health panel above the existing reserve chart:

- **Oracle Status:** OK / Stale + last update time (relative: "2 min ago")
- **Oracle Price:** formatted rate (e.g. "1 GBPm = 1.3339 USDm")
- **Deviation:** percentage + threshold (e.g. "4.9 bps / 50 bps threshold")
- **Last Rebalance:** relative time
- **Reporters:** count

**3.3 Oracle price chart**

New Plotly chart on pool detail: oracle price over time (from OracleSnapshot entity).

---

## Envio `eth_call` in Handlers

Envio supports contract calls via the `client` object in handlers. Example pattern:

```typescript
import { createPublicClient, http } from "viem";

const client = createPublicClient({
  transport: http(
    process.env.ENVIO_RPC_URL || "https://42220.rpc.hypersync.xyz",
  ),
});

// In handler:
const [
  oraclePriceNum,
  oraclePriceDenom,
  reservePriceNum,
  reservePriceDenom,
  above,
  threshold,
  priceDiff,
] = await client.readContract({
  address: poolAddress,
  abi: fpmmAbi,
  functionName: "getRebalancingState",
});
```

**⚠️ Important:** Check Envio docs for the exact pattern — they may have their own RPC client or restrictions on async calls in handlers. If `eth_call` is not supported in Envio handlers, fall back to Approach A (event-only indexing) and defer RPC-polled state to Aegis.

---

## Risks & Unknowns

1. **Envio handler RPC calls:** Need to verify that Envio hosted supports arbitrary `eth_call` in handlers. If not, we can only use event-driven oracle data (SortedOracles.OracleReported) and won't have real-time `hasRecentRate` checks.

2. **SortedOracles address per network:** DevNet and Sepolia may have different SortedOracles addresses. Need to query `OracleAdapter.sortedOracles()` on each network.

3. **Rate feed mapping complexity:** Multiple pools can share the same rateFeedID (if they trade the same pair). The rateFeedID → pool mapping is one-to-many.

4. **Oracle report expiry is per-token:** Different rate feeds may have different expiry times. Currently mainnet GBP/USD uses 360 seconds.

5. **VirtualPools may not have all the same functions:** Need to verify `getRebalancingState()`, `referenceRateFeedID()`, `oracleAdapter()` exist on VirtualPool contracts (they likely do since they share the same ABI).

---

## Testing Strategy

1. **Mainnet data validation:** Query `getRebalancingState()` on all 16 mainnet pools; verify the indexed data matches
2. **Oracle timestamp freshness:** Compare `medianTimestamp` with current time; verify the health status computation is correct
3. **Unit tests:** Add tests for health status computation logic (threshold calculations)
4. **Dashboard visual QA:** Verify badges show correctly for OK/WARN/CRITICAL states

---

## Estimated Effort

| Phase     | Task                                                  | Time          |
| --------- | ----------------------------------------------------- | ------------- |
| 1         | SortedOracles ABI + config + rateFeedID mapping       | 1-2 hours     |
| 2         | Pool health fields + handler updates + OracleSnapshot | 3-4 hours     |
| 3         | Dashboard health badge + health panel + oracle chart  | 2-3 hours     |
| **Total** |                                                       | **6-9 hours** |

---

## Out of Scope (follow-up slices)

- **Trading limit pressure:** Complex tuple return type needs investigation; separate slice
- **Aegis integration:** Real-time polling for staleness detection when no events fire
- **Grafana alerts:** Alert rules on health status transitions
- **Liquity v2 CDP health:** Separate entity set (TroveManager, StabilityPool)
- **Multi-chain oracle differences:** Monad may use different oracle infra

---

## Definition of Done

- [ ] Pool entity has oracle + deviation fields populated from mainnet data
- [ ] OracleSnapshot entity records oracle price history
- [ ] SortedOracles events indexed on mainnet
- [ ] Pool list shows health badge (OK/WARN/CRITICAL)
- [ ] Pool detail page shows health panel with oracle status, price, deviation, last rebalance
- [ ] Oracle price chart renders on pool detail page
- [ ] All tests pass, dashboard builds, deployed to Vercel
