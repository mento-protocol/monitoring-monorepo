# Plan: Celo Mainnet Envio Indexer

## Context

**Current state:** Mento v3 (FPMM/VirtualPool) contracts are **NOT deployed to Celo Mainnet yet.** The treb "virtual" namespace has pre-computed addresses but they have no on-chain code.

**What IS live on Celo Mainnet:** Mento v2 BiPoolManager system:

- **Broker:** `0x777A8255cA72412f0d706dc03C9D1987306B4CaD`
- **BiPoolManager:** `0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901`
- 18 active exchange pairs (BiPool exchanges)
- Tokens rebranded to v3 names (cUSD→USDm, cEUR→EURm, etc.)
- No FPMM or VirtualPool factories

**Implication:** We need to index the **v2 BiPoolManager Swap events** on mainnet, not the v3 FPMM events that only exist on Sepolia/DevNet. The handler logic and schema may need extension to handle BiPoolManager's different event signatures.

## Architecture Decision

### Option A: Index v2 BiPoolManager on mainnet (recommended)

- Index `Swap`, `BucketUpdate` events from BiPoolManager
- Add v2-specific handler logic alongside existing v3 handlers
- Dashboard shows both v2 (mainnet) and v3 (Sepolia) pools

### Option B: Wait for v3 mainnet deployment

- No indexer work needed now
- Dashboard stays Sepolia-only until v3 goes live

**Recommendation:** Option A — provides immediate value showing real mainnet activity. When v3 deploys on mainnet, we add those contracts to the same config.

---

## Implementation Plan

### Phase 1: BiPoolManager ABI + Config (est. 30 min)

1. **Get BiPoolManager ABI** from celoscan or mento-core
2. **Create `config.celo.mainnet.yaml`:**
   ```yaml
   name: celo-mainnet
   networks:
     - id: 42220
       start_block: <find BiPoolManager deployment block>
       contracts:
         - name: BiPoolManager
           abi_file_path: abis/BiPoolManager.json
           address:
             - 0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901
           handler: src/EventHandlers.ts
           events:
             - event: Swap # BiPoolManager Swap event
   ```
3. **Find start block** — BiPoolManager deployment tx on celoscan

### Phase 2: Schema Extension (est. 30 min)

The existing schema works for v3 FPMM pools. For v2 BiPoolManager:

- `Pool` entity works as-is (id, token0, token1, reserves, swap counts)
- `SwapEvent` works as-is (same concept, different event signature)
- `source` field differentiates: `"bi_pool_manager"` vs `"fpmm_factory"` / `"virtual_pool_factory"`
- May need to add a `Pool` creation handler for BiPoolManager exchanges

**Key difference:** BiPoolManager uses `exchangeId` (bytes32) not pool addresses. We'll need to:

- Map exchangeId → Pool entity
- Extract token0/token1 from the exchange config
- Handle the different Swap event signature

### Phase 3: Event Handlers (est. 1-2 hours)

1. **BiPoolManager.Swap handler:**
   - Different event signature than FPMM.Swap
   - Maps to same Pool + SwapEvent entities
   - Updates pool cumulative metrics

2. **Pool initialization:**
   - Query BiPoolManager.getExchanges() for existing pairs
   - Create Pool entities for each exchange
   - Populate token0, token1, initial reserves

3. **Token symbol resolution:**
   - Query on-chain `symbol()` for all mainnet tokens
   - Add to `contracts.json` or networks.ts

### Phase 4: Envio Config + Hosted Deployment (est. 30 min)

1. **Test locally:**
   ```bash
   pnpm indexer:celo-mainnet:dev
   ```
2. **Deploy to Envio hosted:**
   - Create `mento-v3-celo-mainnet` on envio.dev (Philip — manual step)
   - Branch: `deploy/celo-mainnet`
   - Config: `config.celo.mainnet.yaml`
   - HyperSync IS available for Celo mainnet (chain 42220) ✅

3. **Get hosted GraphQL endpoint**

### Phase 5: Dashboard Integration (est. 30 min)

1. **Set `ACTIVE_DEPLOYMENT["celo-mainnet"]`** in networks.ts
2. **Add mainnet tokens to contracts.json** (queried on-chain)
3. **Add Vercel env var:** `NEXT_PUBLIC_HASURA_URL_MULTICHAIN`
4. **Set DEFAULT_NETWORK** to `celo-mainnet`
5. **Verify network switcher** shows mainnet data

---

## Manual Steps Required (Philip)

1. **Create Envio hosted deployment** at <https://envio.dev/app>:
   - Repo: `mento-protocol/monitoring-monorepo`
   - Name: `mento-v3-celo-mainnet`
   - Directory: `indexer-envio`
   - Config: `config.celo.mainnet.yaml`
   - Branch: `deploy/celo-mainnet`
   - Plan: Development (Free)
2. **Copy the GraphQL endpoint** from Envio dashboard after deployment

3. **Add Vercel env var:** `NEXT_PUBLIC_HASURA_URL_MULTICHAIN=<endpoint>`

4. Celo mainnet RPC uses Envio HyperRPC (`https://42220.rpc.hypersync.xyz`). Requires `ENVIO_API_TOKEN` — create one at https://envio.dev/app/api-tokens.

---

## Key Technical Details

**BiPoolManager Swap event signature** (v2):

```solidity
event Swap(
  bytes32 indexed exchangeId,
  address indexed trader,
  address tokenIn,
  address tokenOut,
  uint256 amountIn,
  uint256 amountOut
)
```

vs **FPMM Swap event** (v3):

```solidity
event Swap(
  address indexed sender,
  uint256 amount0In,
  uint256 amount1In,
  uint256 amount0Out,
  uint256 amount1Out
)
```

**Celo Mainnet Tokens** (from on-chain `symbol()` queries):

| Address                                      | Symbol |
| -------------------------------------------- | ------ |
| `0x765DE816845861e75A25fCA122bb6898B8B1282a` | USDm   |
| `0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73` | EURm   |
| + 14 more stablecoins (cKES→KESm, etc.)      |        |

**HyperSync:** Available for Celo mainnet (chain 42220) — confirmed via `https://42220.hypersync.xyz/height`. This means fast backfill (~minutes, not hours).

---

## Risks

1. **BiPoolManager ABI:** Need to source the correct ABI including events. May need to pull from celoscan verified contract.
2. **Exchange ID mapping:** BiPoolManager uses bytes32 exchangeIds, not pool addresses. Need to map these to meaningful Pool entities.
3. **Historical depth:** BiPoolManager has been live since ~2023. Full backfill might index millions of events. Consider setting start_block to a recent date (e.g., last 3 months).
4. **Schema compatibility:** Reusing the same Pool entity for both v2 and v3 pools requires careful field mapping.

---

## Estimated Timeline

| Phase     | Task                       | Time          |
| --------- | -------------------------- | ------------- |
| 1         | ABI + Config               | 30 min        |
| 2         | Schema extension           | 30 min        |
| 3         | Event handlers             | 1-2 hours     |
| 4         | Local test + hosted deploy | 30 min        |
| 5         | Dashboard integration      | 30 min        |
| **Total** |                            | **3-4 hours** |
