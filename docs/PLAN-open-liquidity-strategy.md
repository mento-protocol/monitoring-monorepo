# PLAN: Open Liquidity Strategy (OLS) Support

> Status: **Draft** — ready for implementation on Monad; Celo address TBD  
> Author: Giskard (Opus), reviewed against contract source  
> Created: 2026-03-25  
> Source: `mento-core/contracts/liquidityStrategies/OpenLiquidityStrategy.sol`

---

## 1. What Is OLS?

`OpenLiquidityStrategy` is a Mento v3 contract that manages automated liquidity rebalancing for FPMM pools. It is a **separate strategy contract** layered on top of existing FPMM pools — anyone can call `rebalance(pool)`, and the caller provides tokens directly (hence "open").

OLS pools still emit existing FPMM events (Swap, Mint, Burn, UpdateReserves). The OLS contract emits _additional_ events about liquidity rebalancing. The same pool address is used — OLS is an **additive overlay**.

---

## 2. Contract Interface (verified from source)

### Events

```solidity
// LiquidityStrategyTypes.Direction is an enum:
//   0 = Expand  (pool price > oracle → add debt token, take collateral)
//   1 = Contract (pool price < oracle → add collateral, take debt token)

event LiquidityMoved(
    address indexed pool,
    Direction indexed direction,    // uint8: 0=Expand, 1=Contract
    address tokenGivenToPool,
    uint256 amountGivenToPool,
    address tokenTakenFromPool,
    uint256 amountTakenFromPool
);

event PoolAdded(
    address indexed pool,
    AddPoolParams params            // tuple (see below)
);

event PoolRemoved(address indexed pool);

event RebalanceCooldownSet(address indexed pool, uint32 cooldown);
```

### AddPoolParams struct (emitted in PoolAdded)

```solidity
struct AddPoolParams {
    address pool;
    address debtToken;              // NOT isToken0Debt — handler must derive
    uint32  cooldown;
    address protocolFeeRecipient;
    uint64  liquiditySourceIncentiveExpansion;
    uint64  protocolIncentiveExpansion;
    uint64  liquiditySourceIncentiveContraction;
    uint64  protocolIncentiveContraction;
}
```

Note: `isToken0Debt` is NOT in the event params. It's computed by the contract as `debtToken == pool.token0()`. The handler must either:

- Store `debtToken` directly and resolve at query time, or
- Make an RPC call to determine `token0` and derive `isToken0Debt`

**Decision: store `debtToken` address directly.** The UI can compare against `Pool.token0` to derive `isToken0Debt` client-side. No RPC needed.

### PoolConfig (storage, read via `poolConfigs(pool)`)

```solidity
struct PoolConfig {
    bool    isToken0Debt;
    uint32  lastRebalance;          // ✅ CONFIRMED: Unix timestamp (block.timestamp)
    uint32  rebalanceCooldown;      // seconds
    address protocolFeeRecipient;
    uint64  liquiditySourceIncentiveExpansion;
    uint64  protocolIncentiveExpansion;
    uint64  liquiditySourceIncentiveContraction;
    uint64  protocolIncentiveContraction;
}
```

### Deployed Addresses

| Network           | Chain ID | Address                                      | Status          |
| ----------------- | -------- | -------------------------------------------- | --------------- |
| **Monad Mainnet** | 143      | `0x54e2Ae8c8448912E17cE0b2453bAFB7B0D80E40f` | ✅ Live         |
| Monad Testnet     | 10143    | `0xCCd2aD0603a08EBc14D223a983171ef18192e8c9` | ✅ Live         |
| Celo Mainnet      | 42220    | TBD                                          | ⏳ Not deployed |
| Celo Sepolia      | 44787    | TBD                                          | ⏳ Not deployed |

---

## 3. Resolved Open Questions

| #   | Question                                 | Answer                                                                  |
| --- | ---------------------------------------- | ----------------------------------------------------------------------- |
| 1   | `lastRebalance` — timestamp or block?    | **Unix timestamp.** Contract sets `uint32(block.timestamp)`             |
| 2   | `direction` encoding?                    | **Enum uint8:** `0 = Expand`, `1 = Contract` (NOT +1/-1)                |
| 3   | Which networks?                          | **Monad mainnet (143) and testnet (10143) already deployed.** Celo TBD. |
| 4   | Does `PoolAdded` include `isToken0Debt`? | **No.** Emits `AddPoolParams` which has `debtToken` address.            |
| 5   | `direction` indexed?                     | **Yes** — both `pool` and `direction` are indexed topics                |

### Remaining Open Question

- **Celo OLS contract address** — needed before Celo config can go live

---

## 4. Indexer Changes (`indexer-envio/`)

### 4.1 ABI File

Create `indexer-envio/abis/OpenLiquidityStrategy.json` — copy directly from:
`mento-deployments-v2/packages/contracts/abis/OpenLiquidityStrategy.json`

This is the canonical, compiler-generated ABI. **Do not hand-write it.**

### 4.2 Config YAML Changes

**Start with Monad mainnet** (address is known):

Add to `config.monad.mainnet.yaml`:

```yaml
- name: OpenLiquidityStrategy
  abi_file_path: abis/OpenLiquidityStrategy.json
  address:
    - 0x54e2Ae8c8448912E17cE0b2453bAFB7B0D80E40f
  handler: src/EventHandlers.ts
  events:
    - event: PoolAdded
    - event: PoolRemoved
    - event: RebalanceCooldownSet
    - event: LiquidityMoved
```

Add to `config.monad.testnet.yaml`:

```yaml
- name: OpenLiquidityStrategy
  abi_file_path: abis/OpenLiquidityStrategy.json
  address:
    - 0xCCd2aD0603a08EBc14D223a983171ef18192e8c9
  handler: src/EventHandlers.ts
  events:
    - event: PoolAdded
    - event: PoolRemoved
    - event: RebalanceCooldownSet
    - event: LiquidityMoved
```

For Celo configs — **add only after address is confirmed.** Do not use placeholder `0x000...` as it's cleaner to add when ready.

### 4.3 Schema Changes

Add to `indexer-envio/schema.graphql`:

```graphql
# ─── Open Liquidity Strategy ───────────────────────────────────

# Registered OLS pool config. One record per (pool, OLS contract).
# id = pool address (same as Pool.id) — OLS is an additive overlay.
type OlsPool {
  id: ID! # pool address (same as Pool.id)
  olsAddress: String! # OpenLiquidityStrategy contract address
  isActive: Boolean! # false after PoolRemoved
  debtToken: String! # address of debt token (from AddPoolParams)
  rebalanceCooldown: BigInt! # uint32 seconds
  lastRebalance: BigInt! # uint32 Unix timestamp (0 = never rebalanced)
  protocolFeeRecipient: String!
  liquiditySourceIncentiveExpansion: BigInt!
  liquiditySourceIncentiveContraction: BigInt!
  protocolIncentiveExpansion: BigInt!
  protocolIncentiveContraction: BigInt!
  olsRebalanceCount: Int! # count of LiquidityMoved events for this pool
  addedAtBlock: BigInt!
  addedAtTimestamp: BigInt!
  updatedAtBlock: BigInt!
  updatedAtTimestamp: BigInt!
}

# Individual LiquidityMoved events from OLS
type OlsLiquidityEvent @index(fields: ["poolId", "blockTimestamp"]) {
  id: ID!
  poolId: String! @index # pool address (FK to Pool.id)
  olsAddress: String!
  direction: Int! # 0 = Expand, 1 = Contract
  tokenGivenToPool: String!
  amountGivenToPool: BigInt!
  tokenTakenFromPool: String!
  amountTakenFromPool: BigInt!
  caller: String! # tx.from — the rebalancer EOA
  txHash: String!
  blockNumber: BigInt!
  blockTimestamp: BigInt! @index
}

# Lifecycle events: PoolAdded, PoolRemoved, RebalanceCooldownSet
type OlsLifecycleEvent {
  id: ID!
  poolId: String! @index
  olsAddress: String!
  action: String! # "POOL_ADDED" | "POOL_REMOVED" | "COOLDOWN_SET"
  cooldown: BigInt! # 0 for non-cooldown events; value for COOLDOWN_SET
  txHash: String!
  blockNumber: BigInt!
  blockTimestamp: BigInt!
}
```

**Key changes from v1 plan:**

- `debtToken: String!` replaces `isToken0Debt: Boolean!` — stores the raw address from the event, avoiding RPC calls
- `caller: String!` added to `OlsLiquidityEvent` — tracks who triggered the rebalance (useful for monitoring rebalancer bots)
- `olsRebalanceCount: Int!` on `OlsPool` — running counter, avoids counting queries
- `lastRebalance` initialized to `0` (not block timestamp) — matches contract behavior (`lastRebalance == 0` means never rebalanced)

### 4.4 Handler: `src/handlers/openLiquidityStrategy.ts`

```typescript
// ---------------------------------------------------------------------------
// OpenLiquidityStrategy event handlers
// ---------------------------------------------------------------------------

import {
  OpenLiquidityStrategy,
  type OlsPool,
  type OlsLiquidityEvent,
  type OlsLifecycleEvent,
} from "generated";
import { eventId, asAddress, asBigInt } from "../helpers";

// ---------------------------------------------------------------------------
// PoolAdded
// ---------------------------------------------------------------------------

OpenLiquidityStrategy.PoolAdded.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.params.pool);
  const p = event.params.params;
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const olsPool: OlsPool = {
    id: poolId,
    olsAddress: asAddress(event.srcAddress),
    isActive: true,
    debtToken: asAddress(p.debtToken),
    rebalanceCooldown: asBigInt(p.cooldown),
    lastRebalance: 0n,
    protocolFeeRecipient: asAddress(p.protocolFeeRecipient),
    liquiditySourceIncentiveExpansion: asBigInt(
      p.liquiditySourceIncentiveExpansion,
    ),
    liquiditySourceIncentiveContraction: asBigInt(
      p.liquiditySourceIncentiveContraction,
    ),
    protocolIncentiveExpansion: asBigInt(p.protocolIncentiveExpansion),
    protocolIncentiveContraction: asBigInt(p.protocolIncentiveContraction),
    olsRebalanceCount: 0,
    addedAtBlock: blockNumber,
    addedAtTimestamp: blockTimestamp,
    updatedAtBlock: blockNumber,
    updatedAtTimestamp: blockTimestamp,
  };

  context.OlsPool.set(olsPool);

  const lifecycle: OlsLifecycleEvent = {
    id,
    poolId,
    olsAddress: asAddress(event.srcAddress),
    action: "POOL_ADDED",
    cooldown: 0n,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.OlsLifecycleEvent.set(lifecycle);
});

// ---------------------------------------------------------------------------
// PoolRemoved
// ---------------------------------------------------------------------------

OpenLiquidityStrategy.PoolRemoved.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.params.pool);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  const existing = await context.OlsPool.get(poolId);
  if (existing) {
    context.OlsPool.set({
      ...existing,
      isActive: false,
      updatedAtBlock: blockNumber,
      updatedAtTimestamp: blockTimestamp,
    });
  }

  const lifecycle: OlsLifecycleEvent = {
    id,
    poolId,
    olsAddress: asAddress(event.srcAddress),
    action: "POOL_REMOVED",
    cooldown: 0n,
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.OlsLifecycleEvent.set(lifecycle);
});

// ---------------------------------------------------------------------------
// RebalanceCooldownSet
// ---------------------------------------------------------------------------

OpenLiquidityStrategy.RebalanceCooldownSet.handler(
  async ({ event, context }) => {
    const id = eventId(event.chainId, event.block.number, event.logIndex);
    const poolId = asAddress(event.params.pool);
    const cooldown = asBigInt(event.params.cooldown);
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);

    const existing = await context.OlsPool.get(poolId);
    if (existing) {
      context.OlsPool.set({
        ...existing,
        rebalanceCooldown: cooldown,
        updatedAtBlock: blockNumber,
        updatedAtTimestamp: blockTimestamp,
      });
    }

    const lifecycle: OlsLifecycleEvent = {
      id,
      poolId,
      olsAddress: asAddress(event.srcAddress),
      action: "COOLDOWN_SET",
      cooldown,
      txHash: event.transaction.hash,
      blockNumber,
      blockTimestamp,
    };

    context.OlsLifecycleEvent.set(lifecycle);
  },
);

// ---------------------------------------------------------------------------
// LiquidityMoved
// ---------------------------------------------------------------------------

OpenLiquidityStrategy.LiquidityMoved.handler(async ({ event, context }) => {
  const id = eventId(event.chainId, event.block.number, event.logIndex);
  const poolId = asAddress(event.params.pool);
  const blockNumber = asBigInt(event.block.number);
  const blockTimestamp = asBigInt(event.block.timestamp);

  // Update lastRebalance + counter on OlsPool
  const existing = await context.OlsPool.get(poolId);
  if (existing) {
    context.OlsPool.set({
      ...existing,
      lastRebalance: blockTimestamp,
      olsRebalanceCount: existing.olsRebalanceCount + 1,
      updatedAtBlock: blockNumber,
      updatedAtTimestamp: blockTimestamp,
    });
  }

  const olsEvent: OlsLiquidityEvent = {
    id,
    poolId,
    olsAddress: asAddress(event.srcAddress),
    direction: Number(event.params.direction), // 0=Expand, 1=Contract
    tokenGivenToPool: asAddress(event.params.tokenGivenToPool),
    amountGivenToPool: event.params.amountGivenToPool,
    tokenTakenFromPool: asAddress(event.params.tokenTakenFromPool),
    amountTakenFromPool: event.params.amountTakenFromPool,
    caller: event.transaction.from ?? "",
    txHash: event.transaction.hash,
    blockNumber,
    blockTimestamp,
  };

  context.OlsLiquidityEvent.set(olsEvent);
});
```

### 4.5 EventHandlers.ts

Add import:

```typescript
import "./handlers/openLiquidityStrategy";
```

---

## 5. UI Dashboard Changes (`ui-dashboard/`)

### 5.1 New Queries (`lib/queries.ts`)

```typescript
export const OLS_POOL = `
  query OlsPool($poolId: String!) {
    OlsPool(where: { id: { _eq: $poolId } }) {
      id olsAddress isActive debtToken
      rebalanceCooldown lastRebalance
      protocolFeeRecipient
      liquiditySourceIncentiveExpansion
      liquiditySourceIncentiveContraction
      protocolIncentiveExpansion
      protocolIncentiveContraction
      olsRebalanceCount
      addedAtBlock addedAtTimestamp
      updatedAtBlock updatedAtTimestamp
    }
  }
`;

export const OLS_LIQUIDITY_EVENTS = `
  query OlsLiquidityEvents($poolId: String!, $limit: Int!) {
    OlsLiquidityEvent(
      where: { poolId: { _eq: $poolId } }
      order_by: { blockTimestamp: desc }
      limit: $limit
    ) {
      id direction caller
      tokenGivenToPool amountGivenToPool
      tokenTakenFromPool amountTakenFromPool
      txHash blockNumber blockTimestamp
    }
  }
`;

export const ALL_OLS_POOLS = `
  query AllOlsPools {
    OlsPool(where: { isActive: { _eq: true } }) {
      id
      olsRebalanceCount
      lastRebalance
    }
  }
`;
```

### 5.2 Pool Detail Page: New "OLS" Tab

Add `"ols"` to `TABS` array in `ui-dashboard/src/app/pool/[poolId]/page.tsx`:

```typescript
const TABS = [
  "swaps",
  "reserves",
  "rebalances",
  "liquidity",
  "oracle",
  "ols",
] as const;
```

Guard: show tab for all pool types (FPMM and VirtualPool) since OLS can register any pool. The tab content handles the "not registered" case gracefully.

### 5.3 OlsTab Component

Add to `page.tsx` (following existing pattern of co-locating tab components):

**`OlsStatusPanel`** — config card:

- Registration badge: "✅ Active" / "❌ Removed" / "Not registered"
- Debt token: show symbol (resolve via `lib/tokens.ts`)
- Cooldown: human-readable (e.g. "4h 0m")
- Cooldown status: progress bar showing `(now - lastRebalance) / rebalanceCooldown`
  - `lastRebalance == 0` → "Never rebalanced"
  - Elapsed ≥ cooldown → "🟢 Ready to rebalance"
  - Elapsed < cooldown → "🟡 Cooling down (Xh Ym left)"
- Total OLS rebalances: `olsRebalanceCount`
- Protocol fee recipient (truncated address + block explorer link)
- Incentive params as basis points (divide by `FEE_DENOMINATOR = 1e18`)

**`OlsLiquidityTable`** — paginated event table:

| Column          | Value                                      |
| --------------- | ------------------------------------------ |
| Time            | Relative ("2h ago") + absolute tooltip     |
| Direction       | Badge: `EXPAND 🟢` (0) / `CONTRACT 🔴` (1) |
| Given to Pool   | Token symbol + formatted amount            |
| Taken from Pool | Token symbol + formatted amount            |
| Caller          | Truncated address (rebalancer bot)         |
| Tx              | Truncated hash + block explorer link       |

### 5.4 Pools List: OLS Badge

In the pools table, add an "OLS" indicator column:

- Fetch `ALL_OLS_POOLS` alongside existing pool queries
- Client-side join on pool address
- Show purple "OLS" pill badge + rebalance count for registered pools
- Show nothing for non-OLS pools

---

## 6. SPEC.md Updates

Add:

1. **Section 4 (Contracts):**
   - `OpenLiquidityStrategy` with Monad address `0x54e2Ae8c8448912E17cE0b2453bAFB7B0D80E40f`
   - Celo address TBD

2. **New entities:** `OlsPool`, `OlsLiquidityEvent`, `OlsLifecycleEvent`

3. **New KPIs:**
   - **Cooldown Pressure** = `(now - lastRebalance) / rebalanceCooldown` — 0% just rebalanced, 100%+ ready
   - **OLS Rebalance Frequency** = `olsRebalanceCount` / time since first rebalance
   - **Expansion vs Contraction Ratio** = count of direction=0 vs direction=1 events

---

## 7. Implementation Phases

### Phase 1 — Indexer + basic UI (~1 day)

**Indexer:**

- [ ] Copy ABI from `mento-deployments-v2/packages/contracts/abis/OpenLiquidityStrategy.json`
- [ ] Add OLS contract to `config.monad.mainnet.yaml` and `config.monad.testnet.yaml`
- [ ] Add 3 new entities to `schema.graphql`
- [ ] Create `src/handlers/openLiquidityStrategy.ts`
- [ ] Add import in `src/EventHandlers.ts`
- [ ] `pnpm build` — verify compilation
- [ ] Deploy to Envio, verify events flow on Monad

**UI:**

- [ ] Add 3 queries to `lib/queries.ts`
- [ ] Add `"ols"` to `TABS`
- [ ] `OlsTab` with status panel + events table
- [ ] OLS badge in pools list

### Phase 2 — Analytics + Celo (~0.5 day, after Phase 1 has data)

- [ ] Cooldown pressure progress bar in status panel
- [ ] Rebalance frequency chart (time series with expand/contract breakdown)
- [ ] OLS lifecycle history (PoolAdded, PoolRemoved, cooldown changes)
- [ ] Add Celo config when address is confirmed
- [ ] SPEC.md updates

---

## 8. File Change Summary

| File                                                  | Change                                                  |
| ----------------------------------------------------- | ------------------------------------------------------- |
| `indexer-envio/abis/OpenLiquidityStrategy.json`       | **NEW** — copy from mento-deployments-v2                |
| `indexer-envio/config.monad.mainnet.yaml`             | Add OLS contract block                                  |
| `indexer-envio/config.monad.testnet.yaml`             | Add OLS contract block                                  |
| `indexer-envio/schema.graphql`                        | Add `OlsPool`, `OlsLiquidityEvent`, `OlsLifecycleEvent` |
| `indexer-envio/src/handlers/openLiquidityStrategy.ts` | **NEW** — 4 event handlers                              |
| `indexer-envio/src/EventHandlers.ts`                  | Add handler import                                      |
| `ui-dashboard/src/lib/queries.ts`                     | Add `OLS_POOL`, `OLS_LIQUIDITY_EVENTS`, `ALL_OLS_POOLS` |
| `ui-dashboard/src/app/pool/[poolId]/page.tsx`         | Add `"ols"` tab + `OlsTab` component                    |
| `ui-dashboard/src/app/pools/page.tsx`                 | OLS badge in pools list                                 |
| `SPEC.md`                                             | Contract + schema + KPI additions                       |

---

## 9. Implementation Notes

1. **ABI source:** Use the compiled ABI from `mento-deployments-v2`, not hand-written. It has the exact tuple component definitions Envio needs.

2. **Direction is `uint8`, not `int8`.** Enum: `0 = Expand`, `1 = Contract`. The schema stores as `Int!`. UI maps: `0 → "EXPAND 🟢"`, `1 → "CONTRACT 🔴"`.

3. **`debtToken` vs `isToken0Debt`.** The `PoolAdded` event emits `debtToken` (address), NOT `isToken0Debt` (bool). The handler stores the address. The UI compares `debtToken === Pool.token0` to derive which token is debt.

4. **`lastRebalance` is confirmed Unix timestamp** (`uint32(block.timestamp)`). Handler updates it from `block.timestamp` on each `LiquidityMoved`. Initial value is `0` (never rebalanced).

5. **Caller tracking.** `event.transaction.from` captures the EOA that triggered `rebalance()` — useful for monitoring which bots are active.

6. **No RPC calls in handlers.** Pure event indexing. `determineAction()` is a view function useful for Phase 2 UI to show real-time state via `rpc-client.ts`, but not needed for indexing.

7. **Block explorer links.** Use `network.explorerBaseUrl` from `lib/networks.ts` — already handles Monad and Celo.

8. **Query pattern.** Use `where: { id: { _eq: $id } }` not `_by_pk()` — codebase convention avoids `_by_pk`.

9. **Nullable fields.** Current schema uses `!` (required) on every field. `OlsLifecycleEvent.cooldown` uses `BigInt!` with `0n` default for non-cooldown events. No nullable fields.

10. **Tuple event params.** `PoolAdded` emits `AddPoolParams` as a tuple. Access as `event.params.params.debtToken` etc. No existing events use tuples — verify with `pnpm build` early.

11. **PoolsTable component.** OLS badge goes in `@/components/pools-table` (not `pools/page.tsx`). Check component source before implementation.

12. **Incentive values.** Stored as raw `uint64` from the contract. `FEE_DENOMINATOR` in the contract is `1e18`. To show as percentage: `value / 1e18 * 100`. To show as basis points: `value / 1e14`.
