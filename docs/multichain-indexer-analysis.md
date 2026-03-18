# Multichain Indexer Analysis: Merging Celo + Monad into One Envio Instance

**Date:** 2026-03-18
**Author:** Giskard (automated analysis)
**Status:** Draft — awaiting review

---

## 1. Executive Summary

**Recommendation: Yes, merge into a single multichain indexer. Do it now.**

The codebase is already 95% ready — both chain configs share identical handler code, ABIs, schema, and even both already set `unordered_multichain_mode: true`. The migration is a config-level change (merging two YAML files into one) plus adding chain ID prefixes to entity IDs to avoid collisions. Estimated effort: 1–2 days of engineering work including testing and redeployment.

---

## 2. Current Architecture

### Repo Structure

The indexer lives in `indexer-envio/` inside the `mento-monitoring-monorepo` pnpm workspace. Key layout:

```
indexer-envio/
├── config.celo.mainnet.yaml    # Celo Mainnet — separate Envio deployment
├── config.celo.sepolia.yaml    # Celo Sepolia testnet
├── config.celo.devnet.yaml     # Celo devnet
├── config.monad.mainnet.yaml   # Monad Mainnet — separate Envio deployment
├── config.monad.testnet.yaml   # Monad testnet
├── schema.graphql              # Single shared schema
├── src/
│   ├── EventHandlers.ts        # Entry point — imports all handler modules
│   └── handlers/
│       ├── fpmm.ts             # FPMM + FPMMFactory handlers
│       ├── sortedOracles.ts    # Oracle handlers
│       ├── virtualPool.ts      # VirtualPool + Factory handlers
│       └── feeToken.ts         # ERC20 fee token transfer handlers
├── abis/                       # Shared ABIs
└── config/
    └── deployment-namespaces.json  # Chain ID → namespace mapping
```

### Deployment Model

- **Separate Envio hosted instances per chain.** Each `config.*.yaml` is deployed independently to Envio's hosted service.
- Each deployment gets its own Postgres + Hasura endpoint.
- The dashboard (`ui-dashboard`) currently points to the Celo Mainnet endpoint only: `https://indexer.hyperindex.xyz/60ff18c/v1/graphql`
- Both Celo Mainnet and Monad Mainnet Envio hosted deployments are live. See: https://envio.dev/app/mento-protocol/mento-v3-monad-mainnet

### What's Shared vs. Separate

| Component               | Shared? | Notes                                      |
| ----------------------- | ------- | ------------------------------------------ |
| Handler code            | ✅ Yes  | Same `src/EventHandlers.ts` for all chains |
| ABIs                    | ✅ Yes  | Same contract interfaces across chains     |
| Schema                  | ✅ Yes  | Single `schema.graphql`                    |
| Config                  | ❌ No   | Separate YAML per chain×network            |
| Envio deployment        | ❌ No   | Separate hosted instance per config        |
| Hasura/GraphQL endpoint | ❌ No   | Different URL per deployment               |

---

## 3. Envio Multichain Capabilities

### How It Works

Envio HyperIndex natively supports multichain indexing by listing multiple networks in a single `config.yaml`. From [the docs](https://docs.envio.dev/docs/HyperIndex/multichain-indexing):

1. **Global contract definitions** — define contracts, ABIs, and events once at the top level
2. **Network-specific entries** — each network block specifies chain ID, start block, and contract addresses
3. **Same handlers** — handler functions are reused across all networks automatically

```yaml
contracts:
  - name: MyContract
    abi_file_path: ./abis/MyContract.json
    handler: ./src/EventHandlers.ts
    events:
      - event: MyEvent

networks:
  - id: 42220 # Celo
    start_block: 60664500
    contracts:
      - name: MyContract
        address: "0xCeloAddress..."
  - id: 143 # Monad
    start_block: 60730000
    contracts:
      - name: MyContract
        address: "0xMonadAddress..."
```

### Event Ordering Modes

- **`unordered_multichain_mode: true`** (recommended) — events processed per-chain in order, but cross-chain ordering is not guaranteed. Lower latency.
- **Ordered mode** — strict cross-chain timestamp ordering. Higher latency, only needed for cross-chain dependencies.

Both our existing configs already set `unordered_multichain_mode: true`, which is correct — our entities from Celo and Monad are independent (no cross-chain interactions).

### Key Constraint

> **Entity ID collisions:** When the same contract logic runs on multiple chains, entity IDs must be globally unique. Best practice: prefix IDs with chain ID (e.g., `42220-0xPoolAddress` instead of `0xPoolAddress`).

---

## 4. Pros of Merging

### 4.1 Single GraphQL Endpoint

Currently the dashboard would need to query N different Hasura endpoints (one per chain) and merge results client-side. With a multichain indexer, there's **one endpoint, one query** for all chains. This is a massive simplification for the dashboard.

### 4.2 Unified Schema & Data Model

All pools, swaps, oracle snapshots, and trading limits from all chains live in the same Postgres database. Cross-chain analytics (total TVL, total volume, protocol-wide health) become trivial SQL/GraphQL queries instead of client-side aggregation.

### 4.3 Simpler Deployment & Ops

- **One Envio deployment** instead of N (currently 2 mainnets, 2+ testnets)
- **One CI pipeline** for indexer deployment
- **One monitoring target** to watch for sync status
- No need to manage multiple Hasura endpoints in Vercel env vars

### 4.4 The Code Is Already There

The handler code is 100% chain-agnostic. Both configs reference the same:

- `handler: src/EventHandlers.ts`
- Same ABIs (`abis/FPMMFactory.json`, `abis/FPMM.json`, etc.)
- Same events (Swap, Mint, Burn, UpdateReserves, Rebalanced, etc.)
- Same `unordered_multichain_mode: true` setting

The `deployment-namespaces.json` already maps both chain IDs:

```json
{
  "42220": "mainnet",
  "11142220": "testnet-v2-rc5",
  "143": "mainnet",
  "10143": "testnet-v2-rc5"
}
```

### 4.5 Future Chain Expansion Is Trivial

Adding a third chain (e.g., Base, Arbitrum) = adding a network block to config. No new deployments, no new endpoints, no dashboard changes.

---

## 5. Cons / Risks

### 5.1 Reindex Time

Merging requires a full reindex of all chains from their start blocks. For Celo Mainnet starting at block ~60.6M, this could take 30–60 minutes on Envio's hosted service. Monad starts at ~60.7M. Not a showstopper but causes a brief data gap during migration.

### 5.2 Chain Isolation Loss

If the indexer crashes or encounters a bug on one chain's events, it affects all chains. With separate deployments, Celo continues running even if Monad has issues. **Mitigation:** Envio's hosted service is resilient, and `unordered_multichain_mode` means one chain's slowness doesn't block the other.

### 5.3 Entity ID Migration

Current entity IDs (e.g., pool IDs like `0x8c0014afe...`) don't include chain identifiers. After merge, IDs must be chain-prefixed to avoid collisions if the same address exists on multiple chains. This requires:

- Updating all `eventId()` and entity ID construction in handlers
- Updating dashboard queries that reference pool IDs
- Updating any hardcoded pool ID references

### 5.4 Dashboard Endpoint Change

The dashboard currently uses `NEXT_PUBLIC_HASURA_URL_CELO_MAINNET_HOSTED`. After merge, this becomes a single multichain URL. The Vercel env var needs updating, and any chain-specific filtering in the dashboard needs a `chainId` field on entities.

### 5.5 Envio Hosted Service Limits

Need to verify that the free tier supports multichain deployments. Based on the Uniswap V4 reference (10 chains), this should be fine.

---

## 6. Migration Effort

### 6.1 Config Changes (Small — ~1 hour)

Create a single `config.yaml` (or `config.multichain.mainnet.yaml`) that merges both:

```yaml
name: mento-v3-multichain
description: Mento v3 FPMM HyperIndex — Celo + Monad

contracts:
  - name: FPMMFactory
    abi_file_path: abis/FPMMFactory.json
    handler: src/EventHandlers.ts
    events:
      - event: FPMMDeployed
  - name: FPMM
    abi_file_path: abis/FPMM.json
    handler: src/EventHandlers.ts
    events:
      - event: Swap
      - event: Mint
      - event: Burn
      - event: UpdateReserves
      - event: Rebalanced
      - event: TradingLimitConfigured
      - event: LiquidityStrategyUpdated
  # ... (VirtualPool, VirtualPoolFactory, SortedOracles, ERC20FeeToken)

networks:
  - id: 42220 # Celo Mainnet
    start_block: 60664500
    contracts:
      - name: FPMMFactory
        address: ["0xa849b475FE5a4B5C9C3280152c7a1945b907613b"]
      - name: FPMM
        address:
          - "0x8c0014afe032e4574481d8934504100bf23fcb56"
          - "0xb285d4c7133d6f27bfb29224fb0d22e7ec3ddd2d"
          # ... rest of Celo pools
      # ... rest of Celo contracts
  - id: 143 # Monad Mainnet
    start_block: 60730000
    contracts:
      - name: FPMMFactory
        address: ["0xa849b475FE5a4B5C9C3280152c7a1945b907613b"]
      - name: FPMM
        address:
          - "0xd0e9c1a718d2a693d41eacd4b2696180403ce081"
          - "0x463c0d1f04bcd99a1efcf94ac2a75bc19ea4a7e5"
          - "0xb0a0264ce6847f101b76ba36a4a3083ba489f501"
      # ... rest of Monad contracts

unordered_multichain_mode: true
preload_handlers: true
field_selection:
  transaction_fields:
    - hash
    - from
```

### 6.2 Schema Changes (Small — ~30 minutes)

Add `chainId` field to all entities for filtering:

```graphql
type Pool {
  id: ID! # Now: "{chainId}-{address}"
  chainId: Int! @index # NEW — enables chain filtering
  # ... rest unchanged
}
```

Add `chainId` to: `Pool`, `OracleSnapshot`, `PoolSnapshot`, `FactoryDeployment`, `SwapEvent`, `LiquidityEvent`, `ReserveUpdate`, `RebalanceEvent`, `TradingLimit`, `VirtualPoolLifecycle`, `ProtocolFeeTransfer`.

### 6.3 Handler Changes (Medium — ~2–4 hours)

1. **Entity ID prefixing:** Update `eventId()` helper and all entity ID construction to include `event.chainId`:

   ```typescript
   // Before
   const id = `${event.transaction.hash}-${event.logIndex}`;
   // After
   const id = `${event.chainId}-${event.transaction.hash}-${event.logIndex}`;
   ```

2. **Pool ID prefixing:**

   ```typescript
   // Before
   const poolId = event.srcAddress;
   // After
   const poolId = `${event.chainId}-${event.srcAddress}`;
   ```

3. **Set `chainId` on all entities:**

   ```typescript
   entity.chainId = event.chainId;
   ```

4. **RPC calls:** Verify `viem` client creation handles multiple chain IDs (check if there's a chain-specific RPC URL resolution). The `run-envio-with-env.mjs` script may need updating if it sets chain-specific env vars.

### 6.4 Dashboard Changes (Medium — ~2–4 hours)

1. Update Hasura URL env var (single endpoint)
2. Add chain selector/filter to the dashboard UI
3. Update GraphQL queries to include `chainId` in where clauses or display it
4. Update any hardcoded pool ID references

### 6.5 Terraform Changes (Small — ~30 minutes)

If Terraform manages Envio deployments, update to deploy one multichain instance instead of separate per-chain ones.

### 6.6 Test Updates (Small — ~1 hour)

Update test fixtures and assertions to include chain ID in entity IDs. All existing tests should pass with minimal changes since they test handler logic, not config.

### Total Estimated Effort: **1–2 days**

---

## 7. Concrete Recommendation

**Merge now.** Specifically:

1. **For mainnet deployments** — create a unified `config.mainnet.yaml` combining Celo + Monad. Deploy as a single Envio hosted instance.
2. **For testnet deployments** — similarly merge into `config.testnet.yaml`.
3. **Keep per-chain devnet configs** — devnets are ephemeral and may need isolated testing. Keep `config.celo.devnet.yaml` etc. for local dev.
4. **Both Monad and Celo Envio deployments are live** — this means the multichain merge now involves migrating two live deployments. The urgency is higher: every day we run separate deployments is more divergence to reconcile.

### Why Now?

- Monad Envio indexer is live but not yet wired into the dashboard UI (hasuraUrl not set) — no migration of existing multi-endpoint queries needed
- The handler code is already chain-agnostic — zero handler logic changes beyond ID prefixing
- Every day with separate deployments is a day of unnecessary operational complexity
- ⚠️ Monad data already exists in prod — adding chainId to entity IDs is now a breaking migration requiring a full reindex of both chains

---

## 8. Step-by-Step Migration Plan

### Phase 1: Prep (Day 1 morning)

- [ ] **1.1** Create branch `feat/multichain-indexer`
- [ ] **1.2** Add `chainId: Int! @index` to all entities in `schema.graphql`
- [ ] **1.3** Update `eventId()` helper to prefix with `event.chainId`
- [ ] **1.4** Update all pool/entity ID construction in handlers to include chain ID
- [ ] **1.5** Set `entity.chainId = event.chainId` in all handler `set()` calls
- [ ] **1.6** Create `config.mainnet.yaml` merging Celo + Monad networks
- [ ] **1.7** Create `config.testnet.yaml` merging Celo Sepolia + Monad testnet
- [ ] **1.8** Update `run-envio-with-env.mjs` if needed for multi-chain RPC env vars

### Phase 2: Test (Day 1 afternoon)

- [ ] **2.1** Run `pnpm codegen` with new config — verify generated types
- [ ] **2.2** Run `pnpm test` — fix any failing tests (ID format changes)
- [ ] **2.3** Run `pnpm dev` locally — verify both chains index correctly
- [ ] **2.4** Query Hasura locally — verify entities have `chainId`, IDs are unique

### Phase 3: Deploy (Day 2 morning)

- [ ] **3.1** Deploy multichain indexer to Envio hosted service
- [ ] **3.2** Wait for full sync (estimate: 30–60 min)
- [ ] **3.3** Verify data integrity: compare pool counts, swap counts, reserves against old single-chain endpoints
- [ ] **3.4** Update dashboard `NEXT_PUBLIC_HASURA_URL` to new multichain endpoint

### Phase 4: Dashboard Updates (Day 2 afternoon)

- [ ] **4.1** Add chain ID display/filter to pool list
- [ ] **4.2** Update any hardcoded pool references
- [ ] **4.3** Verify dashboard works with multichain data
- [ ] **4.4** Deploy dashboard to Vercel

### Phase 5: Cleanup

- [ ] **5.1** Deprecate old single-chain Envio deployments (keep running for 1 week as fallback)
- [ ] **5.2** Remove old per-chain mainnet configs (keep devnet configs)
- [ ] **5.3** Update `STATUS.md`, `AGENTS.md`, `SPEC.md`
- [ ] **5.4** Delete old Envio hosted deployments after verification period

---

## Appendix: Current Config Comparison

Both configs are structurally identical. Key differences are only:

- `name` field (`celo-mainnet` vs `monad-mainnet`)
- `networks[0].id` (`42220` vs `143`)
- `networks[0].start_block`
- Contract addresses (different deployments, same contracts)
- Monad contracts are live — real addresses in `config.monad.mainnet.yaml` (FPMMFactory, 3 FPMM pools, VirtualPool). VirtualPoolFactory TBD.

Everything else — events, ABIs, handler paths, field selection, `unordered_multichain_mode` — is identical. This confirms the merge is a straightforward config concatenation.
