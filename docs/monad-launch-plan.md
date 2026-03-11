# Monad Mainnet — Monitoring Launch Plan

> **Status:** Pre-launch prep. Contract addresses TBD — this document tracks everything needed to go live once addresses are available.
> 
> **Target chain:** Monad Mainnet (`chainId: 10143` — confirm with team)
> **Contracts package namespace:** `"monad-mainnet"` (exists in `@mento-protocol/contracts@0.2.0` for chainId 143; confirm final chainId and namespace once deployment is done)

---

## Definition of Done

Monitoring is live for Monad when:

- [ ] Envio indexer is running for Monad, events are being indexed
- [ ] GraphQL endpoint is accessible and returning pool/swap/oracle data
- [ ] Dashboard shows Monad pools in the "All Pools" table with correct health status
- [ ] Oracle prices, reserves, trading limits, and rebalancer status are accurate
- [ ] TVL and 24h volume tiles show Monad data (or are clearly labeled per-chain)
- [ ] Vercel deployment has Monad env vars set and network is reachable
- [ ] No CI failures on the `deploy/monad-mainnet` branch

---

## Pre-requisites (blocking — need from team)

| Item | Status | Notes |
|------|--------|-------|
| Final Monad chain ID | ⏳ TBD | Confirm: is it `143` (testnet) or a mainnet ID? |
| `@mento-protocol/contracts` namespace for Monad | ⏳ TBD | Likely `"monad-mainnet"` — confirm once deployment is published to package |
| FPMMFactory address | ⏳ TBD | Required in Envio config |
| VirtualPoolFactory address | ⏳ TBD | Required in Envio config |
| SortedOracles address | ⏳ TBD | Required in Envio config + contractAddresses.ts |
| USDm address (Monad) | ⏳ TBD | Required for USDm direction detection |
| Initial FPMM pool addresses | ⏳ TBD | One or more at launch |
| Initial VirtualPool addresses | ⏳ TBD | Zero or more at launch |
| Monad RPC URL | ⏳ TBD | For Envio indexer config |
| Monad block explorer base URL | ⏳ TBD | e.g. `https://explorer.monad.xyz` |
| Envio hosted deployment for Monad | ⏳ TBD | Need GraphQL endpoint URL once indexer is deployed |
| Start block for indexing | ⏳ TBD | First deployment transaction block |

---

## Implementation Steps

### Step 1 — Update `shared-config/deployment-namespaces.json`

Add the Monad chain ID and its `@mento-protocol/contracts` namespace:

```json
{
  "42220": "mainnet",
  "11142220": "testnet-v2-rc5",
  "<MONAD_CHAIN_ID>": "monad-mainnet"
}
```

**Files:** `shared-config/deployment-namespaces.json`  
**Blocked by:** Confirmed chain ID + package namespace

---

### Step 2 — Update `indexer-envio/src/contractAddresses.ts`

Add Monad to `CONTRACT_NAMESPACE_BY_CHAIN`:

```ts
export const CONTRACT_NAMESPACE_BY_CHAIN: Record<number, string> = {
  42220: "mainnet",
  11142220: "testnet-v2-rc5",
  <MONAD_CHAIN_ID>: "monad-mainnet",
};
```

**Files:** `indexer-envio/src/contractAddresses.ts`  
**Blocked by:** Confirmed chain ID + namespace in `@mento-protocol/contracts`  
**Note:** Address resolution (SortedOracles, USDm) is automatic once the namespace is added, provided the package is updated with Monad addresses.

---

### Step 3 — Create `indexer-envio/config.monad.mainnet.yaml`

New Envio config file for Monad, following the same pattern as `config.celo.mainnet.yaml`:

```yaml
name: monad-mainnet
description: Monad Mainnet v3 FPMM HyperIndex indexer
networks:
  - id: <MONAD_CHAIN_ID>
    start_block: ${ENVIO_START_BLOCK:-<FIRST_DEPLOY_BLOCK>}
    contracts:
      - name: FPMMFactory
        abi_file_path: abis/FPMMFactory.json
        address:
          - <FPMM_FACTORY_ADDRESS>
        handler: src/EventHandlers.ts
        events:
          - event: FPMMDeployed
      - name: FPMM
        abi_file_path: abis/FPMM.json
        address:
          - <FPMM_POOL_ADDRESS_1>
          # add more as pools are deployed
        handler: src/EventHandlers.ts
        events:
          - event: Swap
          - event: Mint
          - event: Burn
          - event: UpdateReserves
          - event: Rebalanced
          - event: TradingLimitConfigured
      - name: VirtualPool
        abi_file_path: abis/FPMM.json
        address: []  # fill in when virtual pools are deployed
        handler: src/EventHandlers.ts
        events:
          - event: Swap
          - event: Mint
          - event: Burn
          - event: UpdateReserves
          - event: Rebalanced
      - name: VirtualPoolFactory
        abi_file_path: abis/VirtualPoolFactory.json
        address:
          - <VIRTUAL_POOL_FACTORY_ADDRESS>
        handler: src/EventHandlers.ts
        events:
          - event: VirtualPoolDeployed
          - event: PoolDeprecated
      - name: SortedOracles
        abi_file_path: abis/SortedOracles.json
        address:
          - "<SORTED_ORACLES_ADDRESS>"
        handler: src/EventHandlers.ts
        events:
          - event: OracleReported
          - event: MedianUpdated
unordered_multichain_mode: true
preload_handlers: true
field_selection:
  transaction_fields:
    - hash
    - from
```

**Files:** `indexer-envio/config.monad.mainnet.yaml` (new file)  
**Blocked by:** All addresses from Step 0

---

### Step 4 — Update `ui-dashboard/src/lib/networks.ts`

Add Monad to `ACTIVE_DEPLOYMENT` and `NETWORKS`:

```ts
const NS = {
  "celo-mainnet": DEPLOYMENT_NAMESPACES["42220"],
  "celo-sepolia": DEPLOYMENT_NAMESPACES["11142220"],
  "monad-mainnet": DEPLOYMENT_NAMESPACES["<MONAD_CHAIN_ID>"],
} as const;

export type IndexerNetworkId =
  | "devnet"
  | "celo-sepolia-local"
  | "celo-sepolia-hosted"
  | "celo-mainnet-local"
  | "celo-mainnet-hosted"
  | "monad-mainnet-hosted";  // new

// In NETWORKS:
"monad-mainnet-hosted": makeNetwork({
  id: "monad-mainnet-hosted",
  label: "Monad Mainnet",
  chainId: <MONAD_CHAIN_ID>,
  contractsNamespace: NS["monad-mainnet"],
  hasuraUrl: process.env.NEXT_PUBLIC_HASURA_URL_MONAD_HOSTED ?? "",
  hasuraSecret: process.env.NEXT_PUBLIC_HASURA_SECRET_MONAD_HOSTED ?? "",
  explorerBaseUrl:
    process.env.NEXT_PUBLIC_EXPLORER_URL_MONAD_HOSTED ??
    "https://explorer.monad.xyz",
}),
```

**Files:** `ui-dashboard/src/lib/networks.ts`  
**Blocked by:** Confirmed chain ID + package namespace

---

### Step 5 — Update `.env.production.local.example`

Document the new env vars:

```bash
# ── Monad Mainnet (hosted Envio indexer) ──────────────────────────────────────
NEXT_PUBLIC_HASURA_URL_MONAD_HOSTED=https://indexer.hyperindex.xyz/<MONAD_DEPLOYMENT_ID>/v1/graphql
NEXT_PUBLIC_HASURA_SECRET_MONAD_HOSTED=
# NEXT_PUBLIC_EXPLORER_URL_MONAD_HOSTED=https://explorer.monad.xyz
```

**Files:** `ui-dashboard/.env.production.local.example`  
**Blocked by:** Envio hosted deployment URL

---

### Step 6 — Set Vercel env vars

In the Vercel project (mentolabs/monitoring-dashboard):
- `NEXT_PUBLIC_HASURA_URL_MONAD_HOSTED` — GraphQL endpoint
- `NEXT_PUBLIC_HASURA_SECRET_MONAD_HOSTED` — if needed
- `NEXT_PUBLIC_EXPLORER_URL_MONAD_HOSTED` — block explorer

**Blocked by:** Envio hosted deployment URL

---

### Step 7 — Update `deploy/monad-mainnet` branch

Merge `main` into `deploy/monad-mainnet`, then push to trigger Vercel preview.  
This is the same pattern used for Celo deployments.

---

### Step 8 — Update `@mento-protocol/contracts` package (if needed)

If Monad contract addresses are not yet in the package (`@mento-protocol/contracts`):
- The `contractAddresses.ts` fail-fast logic will throw at indexer startup
- Package needs to be updated with `FPMMFactory`, `VirtualPoolFactory`, `SortedOracles`, `USDm` addresses for the Monad chain/namespace
- Then bump the `@mento-protocol/contracts` version in `indexer-envio/package.json`

**Owned by:** Contracts team  
**Note:** `USDm` address for chainId 143/`monad-mainnet` namespace already exists in v0.2.0 (`0x866a7e4611C127DCe1a14C6841D2eA962A68dc88`). Other contracts TBD.

---

## Test Plan

### Local smoke test (before deploying)

```bash
# 1. Spin up Envio locally with the Monad config
cd indexer-envio
ENVIO_START_BLOCK=<start_block> envio dev --config config.monad.mainnet.yaml

# 2. Verify indexing starts without errors (no contractAddresses throws)
# 3. Check a known swap transaction appears in PoolSnapshot

# 4. Run the dashboard against the local indexer
cd ui-dashboard
NEXT_PUBLIC_HASURA_URL_MONAD_HOSTED=http://localhost:8080/v1/graphql pnpm dev
# Visit http://localhost:3000 → select "Monad Mainnet" network
# Verify: pools visible, health badges render, oracle prices shown
```

### Automated tests

```bash
# All existing tests must still pass — no regressions
cd indexer-envio && pnpm test    # 21 tests including contractAddresses assertions
cd ui-dashboard && pnpm test     # 105 tests including network merge tests

# The contractAddresses tests will automatically validate Monad address resolution
# once the chain ID is added to CONTRACT_NAMESPACE_BY_CHAIN
```

### Post-deploy verification checklist

- [ ] Monad network selectable in dashboard dropdown
- [ ] "All Pools" table shows at least 1 pool
- [ ] Health status column shows values (not all "N/A")
- [ ] Oracle price visible and non-zero for at least 1 FPMM pool
- [ ] Swap count > 0 if any swaps have occurred
- [ ] Pool detail page loads without error
- [ ] Explorer links point to correct Monad explorer
- [ ] TVL tile shows non-zero value
- [ ] No console errors in browser

---

## Dependency Map

```
Contracts deployed on Monad
    ↓
@mento-protocol/contracts package updated with addresses
    ↓
shared-config/deployment-namespaces.json  ←──────────────────┐
contractAddresses.ts (CONTRACT_NAMESPACE_BY_CHAIN)            │  (must stay in sync)
    ↓                                                          │
config.monad.mainnet.yaml   networks.ts (NETWORKS)  ──────────┘
    ↓                              ↓
Envio hosted indexer         Vercel env vars set
    ↓                              ↓
GraphQL endpoint     →    dashboard can query it
```

---

## Estimated Time Once Addresses Are Available

| Step | Effort |
|------|--------|
| Steps 1–5 (code changes) | ~30 min |
| Envio deployment + indexer sync to tip | ~1–2 hours (depends on start block) |
| Vercel env vars + preview deploy | ~5 min |
| Smoke test + verification | ~15 min |
| **Total** | **~2–3 hours** |

The code changes themselves are mechanical — the bottleneck is indexer sync time.
