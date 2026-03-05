# Plan: Trading Limit Tracking

**Feature:** Index trading limit state, compute `limitPressure`, display warn/crit badges per Roman's spec

---

## Context

Each FPMM has per-token trading limits enforced by `getTradingLimits(address)`:
- `config.limit0` — max allowed netflow for token0 (e.g. 500 USDm)
- `config.limit1` — max allowed netflow for token1 (e.g. 1000 USDC)
- `state.netflow0 / netflow1` — running net flow since last reset (`lastUpdated` timestamp)

`limitPressure = |netflow| / limit` per token, per window.

**Live probe (USDC/USDm pool, 2026-03-05):**
- `limit0`: 500 USDm, `limit1`: 1000 USDC
- Current `netflow0`: 5 USDm → `pressure0 = 0.010` (OK)
- Current `netflow1`: -5 USDC → `pressure1 = 0.005` (OK)

**Thresholds (Roman's spec):**
- WARN: `limitPressure > 0.8`
- CRITICAL: `limitPressure ≥ 1.0`

The `TradingLimitConfigured` event fires when limits are changed (`configureTradingLimit` call).
There is **no on-chain event for netflow state changes** — it's derived from Swap amounts.

**Strategy:** Index `TradingLimitConfigured` for limit config, then compute current `netflow` state via RPC call (`getTradingLimits`) on each `Swap` event, same pattern as oracle health.

---

## Tasks

### Indexer

#### 1. Add `TradingLimit` entity to schema

```graphql
type TradingLimit @index(fields: ["poolId"]) {
  id: ID!           # poolId-tokenAddress
  poolId: String!   @index
  token: String!
  limit0: BigInt!   # max netflow window 0 (raw, token decimals)
  limit1: BigInt!   # max netflow window 1
  decimals: Int!
  netflow0: BigInt! # current netflow window 0 (raw)
  netflow1: BigInt! # current netflow window 1
  lastUpdated0: BigInt!
  lastUpdated1: BigInt!
  limitPressure0: String!  # 0.000–1.000+ (stored as string for precision)
  limitPressure1: String!
  limitStatus: String!     # "OK" | "WARN" | "CRITICAL" (worst of both)
  updatedAtBlock: BigInt!
  updatedAtTimestamp: BigInt!
}
```

#### 2. Add `TradingLimitConfigured` event handler

In `EventHandlers.ts`:
- On `TradingLimitConfigured(token, config)`:
  - Upsert `TradingLimit` entity with new `limit0`, `limit1`, `decimals`
  - RPC call `getTradingLimits(token)` to get current `state` (same viem pattern as oracle health)
  - Compute `limitPressure0 = |netflow0| / limit0`, `limitPressure1 = |netflow1| / limit1`
  - Set `limitStatus = computeLimitStatus(pressure0, pressure1)`

#### 3. Update `Swap` event handler

On every `Swap`, update the `TradingLimit` entity:
- RPC call `getTradingLimits(token0)` and `getTradingLimits(token1)`
- Recompute `netflow0`, `netflow1`, `limitPressure0`, `limitPressure1`, `limitStatus`
- This is the same pattern used for oracle health on `Swap` events

#### 4. Add `limitStatus` to `Pool` entity (denormalised for fast badge queries)

```graphql
# In Pool type
limitStatus: String!   # "OK" | "WARN" | "CRITICAL" | "N/A"
limitPressure0: String!
limitPressure1: String!
```

Update on every Swap handler after computing TradingLimit.

#### 5. Status computation helper

```ts
function computeLimitStatus(p0: number, p1: number): string {
  const worst = Math.max(p0, p1);
  if (worst >= 1.0) return "CRITICAL";
  if (worst > 0.8)  return "WARN";
  return "OK";
}
```

---

### Dashboard

#### 6. Add `limitStatus` to `ALL_POOLS_WITH_HEALTH` query

Fetch `limitStatus`, `limitPressure0`, `limitPressure1` on every pool query.

#### 7. `LimitBadge` component

Same pattern as `HealthBadge`:
```
OK      → 🟢
WARN    → 🟡  (e.g. "85% full")
CRITICAL → 🔴  (e.g. "103% — CRITICAL")
N/A     → ⚪  (VirtualPools)
```

#### 8. Pool list: add `Limit` column

Add `LimitBadge` column to `PoolsTable` alongside existing `HealthBadge`.

#### 9. Pool detail: `LimitPanel` in Overview tab

Expandable panel (same pattern as `HealthPanel`) showing:
- Token 0: `netflow0 / limit0` with percentage bar
- Token 1: `netflow1 / limit1` with percentage bar
- `lastUpdated` timestamp per window

#### 10. Unit tests

```
computeLimitStatus(0.5, 0.5)  → "OK"
computeLimitStatus(0.85, 0.3) → "WARN"
computeLimitStatus(1.1, 0.2)  → "CRITICAL"
computeLimitStatus(0, 0)      → "OK"
```

---

## Definition of Done

- [ ] `TradingLimit` entity in schema with all fields
- [ ] `TradingLimitConfigured` event handler creates/updates entity
- [ ] `Swap` handler updates `TradingLimit` state via RPC
- [ ] `Pool.limitStatus`, `limitPressure0`, `limitPressure1` denormalised fields updated on Swap
- [ ] `LimitBadge` component with OK/WARN/CRITICAL/N/A states
- [ ] `LimitBadge` column in `PoolsTable`
- [ ] `LimitPanel` on pool detail Overview tab
- [ ] Unit tests for `computeLimitStatus` (4 cases minimum)
- [ ] New indexer deployed + Vercel endpoint updated
- [ ] Build ✅, lint ✅, all tests ✅

---

## End-to-End Testing Criteria

1. **Pool list** shows `Limit` column alongside `Health` — all 4 FPMM pools show a badge, all 12 VirtualPools show ⚪
2. **FPMM pool detail** → Overview tab → `LimitPanel` shows two progress bars (token0 / token1)
3. **Simulate near-limit:** Wait for a high-volume period or test manually with a simulated high-netflow state — badge should flip to WARN at >80%
4. **`TradingLimitConfigured` event:** If a limit is reconfigured on-chain, the badge updates on next indexer sync
5. **No crashes on VirtualPools** — `getTradingLimits` will revert; handler must guard FPMM-only
6. **`limitPressure` in Hasura:** Query `TradingLimit` table directly, verify `limitPressure0 + limitPressure1` match manual calculation from `getTradingLimits` RPC call

---

## Estimated Effort

~5h (indexer schema migration + RPC calls + 2 dashboard components)

## Notes

- RPC calls on every `Swap` event adds latency to indexer processing. Monitor Envio sync speed — if it becomes a bottleneck, consider sampling (every Nth swap instead of every swap)
- Windows reset when `block.timestamp - lastUpdated > windowDuration`. Pressure drops to 0 naturally — no special handling needed
- VirtualPools: `getTradingLimits` will likely revert. Guard: `if (!isFpmm) return` before RPC call
