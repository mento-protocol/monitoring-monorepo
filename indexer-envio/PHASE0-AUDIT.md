# Phase 0 Audit — Envio Multichain Indexer Refactor

**Date:** 2026-03-26  
**Scope:** `indexer-envio/` — schema, handlers, config files  
**Purpose:** Pre-refactor audit before adding multichain support (Celo + Monad in a single indexer)

---

## 1. Entity Audit Table

| Entity                   | Current ID Shape                                                                   | Address-derived?                             | Has chainId?                | Referenced by (poolId FK)                                                                                                                                                                                       | Collision Risk (2 chains, same address)                                       |
| ------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Pool**                 | Pool contract address (lowercased)                                                 | ✅ Yes — `event.srcAddress` or factory param | ❌ No                       | OracleSnapshot, PoolSnapshot, SwapEvent, LiquidityEvent, ReserveUpdate, RebalanceEvent, TradingLimit, LiquidityPosition, OlsPool, OlsLiquidityEvent, OlsLifecycleEvent, FactoryDeployment, VirtualPoolLifecycle | 🔴 **HIGH** — same pool address on Celo and Monad would be the same DB record |
| **OracleSnapshot**       | `{chainId}_{blockNumber}_{logIndex}` (via `eventId`) + optional `-{poolId}` suffix | Partial — logIndex makes it unique per event | ✅ Yes (baked into eventId) | —                                                                                                                                                                                                               | ✅ Safe (eventId includes chainId)                                            |
| **PoolSnapshot**         | `{poolId}-{hourTimestamp}` (via `snapshotId`)                                      | ✅ Yes (poolId part)                         | ❌ No                       | —                                                                                                                                                                                                               | 🔴 **HIGH** — same pool address + same hour = same key across chains          |
| **FactoryDeployment**    | `{chainId}_{blockNumber}_{logIndex}`                                               | No — event-derived                           | ✅ Yes                      | —                                                                                                                                                                                                               | ✅ Safe                                                                       |
| **SwapEvent**            | `{chainId}_{blockNumber}_{logIndex}`                                               | No — event-derived                           | ✅ Yes                      | Pool (poolId field)                                                                                                                                                                                             | ✅ Safe (but poolId FK unscoped)                                              |
| **LiquidityEvent**       | `{chainId}_{blockNumber}_{logIndex}`                                               | No — event-derived                           | ✅ Yes                      | Pool (poolId field)                                                                                                                                                                                             | ✅ Safe (but poolId FK unscoped)                                              |
| **ReserveUpdate**        | `{chainId}_{blockNumber}_{logIndex}`                                               | No — event-derived                           | ✅ Yes                      | Pool (poolId field)                                                                                                                                                                                             | ✅ Safe (but poolId FK unscoped)                                              |
| **RebalanceEvent**       | `{chainId}_{blockNumber}_{logIndex}`                                               | No — event-derived                           | ✅ Yes                      | Pool (poolId field)                                                                                                                                                                                             | ✅ Safe (but poolId FK unscoped)                                              |
| **TradingLimit**         | `{poolId}-{tokenAddress}`                                                          | ✅ Yes (both parts)                          | ❌ No                       | Pool (poolId field)                                                                                                                                                                                             | 🔴 **HIGH** — same pool+token on two chains = same key                        |
| **VirtualPoolLifecycle** | `{chainId}_{blockNumber}_{logIndex}`                                               | No — event-derived                           | ✅ Yes                      | Pool (poolId field)                                                                                                                                                                                             | ✅ Safe (but poolId FK unscoped)                                              |
| **LiquidityPosition**    | `{poolId}-{address}`                                                               | ✅ Yes (both parts)                          | ❌ No                       | Pool (poolId field)                                                                                                                                                                                             | 🔴 **HIGH** — same pool+LP address on two chains = same key                   |
| **ProtocolFeeTransfer**  | `{chainId}_{blockNumber}_{logIndex}`                                               | No — event-derived                           | ✅ Yes                      | — (token field, not Pool FK)                                                                                                                                                                                    | ✅ Safe                                                                       |
| **OlsPool**              | `{poolAddress}-{olsAddress}`                                                       | ✅ Yes (both parts)                          | ❌ No                       | Pool (poolId field)                                                                                                                                                                                             | 🔴 **HIGH** — same addresses on two chains = collision                        |
| **OlsLiquidityEvent**    | `{chainId}_{blockNumber}_{logIndex}`                                               | No — event-derived                           | ✅ Yes                      | Pool (poolId field)                                                                                                                                                                                             | ✅ Safe (but poolId FK unscoped)                                              |
| **OlsLifecycleEvent**    | `{chainId}_{blockNumber}_{logIndex}`                                               | No — event-derived                           | ✅ Yes                      | Pool (poolId field)                                                                                                                                                                                             | ✅ Safe (but poolId FK unscoped)                                              |

### Summary of Collision-Prone Entities (need ID fix for multichain)

1. **Pool** — primary root entity; all others hang off `poolId` FK. This is the critical one.
2. **PoolSnapshot** — `{poolId}-{hourTs}` will collide if pool addresses match across chains.
3. **TradingLimit** — `{poolId}-{tokenAddress}` composite, no chain scope.
4. **LiquidityPosition** — `{poolId}-{address}` composite, no chain scope.
5. **OlsPool** — `{poolAddress}-{olsAddress}` composite, no chain scope.

**Note on FK pollution:** Even "safe" entities (event-log IDs already include chainId) store `poolId` as a plain address string. If `Pool.id` becomes `{chainId}-{address}`, all FK references must also be updated to `{chainId}-{address}` format. This is a broad but mechanical change.

---

## 2. Dynamic Contract Discovery

### 2.1 Are child contracts discovered dynamically or statically listed?

**Both patterns are in use:**

- **FPMM pools** — Listed **statically** in config YAML under the `FPMM` contract block (explicit addresses per chain).
- **VirtualPools** — Listed **statically** in `config.celo.mainnet.yaml`. Empty (`address: []`) in `config.monad.testnet.yaml` where factory isn't yet deployed.
- **ERC20FeeToken** — ✅ **Dynamically registered** via `contractRegister`. The `FPMMFactory.FPMMDeployed.contractRegister` callback calls `context.addERC20FeeToken(token0)` and `context.addERC20FeeToken(token1)` to register pool token addresses for ERC20 Transfer event indexing.

```typescript
// fpmm.ts — dynamic registration
FPMMFactory.FPMMDeployed.contractRegister(({ event, context }) => {
  context.addERC20FeeToken(event.params.token0);
  context.addERC20FeeToken(event.params.token1);
});
```

### 2.2 Does the config use `addDynamicContracts`?

Yes — `ERC20FeeToken` uses Envio's dynamic contract registration via `contractRegister`. The config marks this contract's address list as empty (`address: []`) with a comment: _"Dynamically registered from FPMMDeployed events"_.

`VirtualPool` pools are **not** dynamically registered — they are pre-listed statically (or empty on testnet). There's a `VirtualPoolFactory` that emits `VirtualPoolDeployed`/`PoolDeprecated` events, but the VirtualPool contract addresses themselves are pre-seeded in the config, not registered at runtime via `contractRegister`.

### 2.3 Will Envio's multichain config support the same dynamic discovery pattern?

**Yes, with one caveat.** Envio's multichain mode supports `contractRegister` / dynamic contract addition per-chain. The `context.addERC20FeeToken(...)` pattern works in multichain mode — Envio scopes dynamic additions to the chain where the triggering event occurred.

The current VirtualPool static listing approach also translates cleanly to multichain — each chain block in the YAML lists its own addresses.

**The caveat:** With `unordered_multichain_mode: true` already set in all configs, Envio processes events across chains concurrently without strict ordering guarantees. This is already the current setting, so no behavioral change is introduced by going multichain.

---

## 3. GO / NO-GO Gate for Phase 1

### Verdict: ✅ GO — with mandatory ID migration

**All blockers are known and mechanical.** No architectural unknowns.

### Entities requiring ID changes before multichain can be enabled:

| Entity              | Current ID                   | Required multichain ID                 | Scope of FK updates                  |
| ------------------- | ---------------------------- | -------------------------------------- | ------------------------------------ |
| `Pool`              | `{address}`                  | `{chainId}-{address}`                  | ALL other entities' `poolId` field   |
| `PoolSnapshot`      | `{poolId}-{hourTs}`          | `{chainId}-{address}-{hourTs}`         | Self + pool.ts `snapshotId()` helper |
| `TradingLimit`      | `{poolId}-{token}`           | `{chainId}-{address}-{token}`          | fpmm.ts                              |
| `LiquidityPosition` | `{poolId}-{address}`         | `{chainId}-{address}-{lpAddress}`      | fpmm.ts                              |
| `OlsPool`           | `{poolAddress}-{olsAddress}` | `{chainId}-{poolAddress}-{olsAddress}` | openLiquidityStrategy.ts             |

### Key implementation notes for Phase 1:

1. **`eventId()` is already chain-safe** — no change needed to event-log-derived IDs.
2. **All handlers receive `event.chainId`** — already passed to `upsertPool()`. The plumbing is there.
3. **`upsertPool()` in `pool.ts`** — this is the central write point for `Pool.id`. Change it here and all FPMM/VirtualPool handlers benefit automatically.
4. **`snapshotId()` in `helpers.ts`** — needs to incorporate `chainId`.
5. **SortedOracles handlers** use `getPoolsByFeed()` / `getPoolsWithReferenceFeed()` from `rpc.ts` to look up pools by `referenceRateFeedID`. These must query by `{chainId}-prefixed poolId` or be chain-scoped to avoid cross-chain oracle bleed.
6. **`ERC20FeeToken` handler** does `context.Pool.get(sender)` where `sender` is a pool address — this lookup must become `context.Pool.get(\`${chainId}-${sender}\`)`.
7. **`feeToken.ts` / `selectStaleTransfers`** — `ProtocolFeeTransfer` IDs are already chain-safe, but any Pool FK lookups need updating.
8. **Schema `@index` fields** — `poolId` indexes are string-based and will continue to work correctly once the value format changes (no schema DDL change required, just value format).

### No blockers that prevent proceeding:

- Dynamic contract discovery (`ERC20FeeToken`) is multichain-compatible ✅
- `unordered_multichain_mode: true` already set ✅
- `event.chainId` already available in all handlers ✅
- ID fix scope is well-bounded and mechanical ✅
