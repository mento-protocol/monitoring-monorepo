# OLS Implementation Work Log

## Phase 1 — Completed 2026-03-25

### What was done

**Indexer (`indexer-envio/`)**
- Copied `OpenLiquidityStrategy.json` ABI from `mento-deployments-v2`
- Added OLS contract block to `config.monad.mainnet.yaml` (0x54e2Ae8c8448912E17cE0b2453bAFB7B0D80E40f) and `config.monad.testnet.yaml` (0xCCd2aD0603a08EBc14D223a983171ef18192e8c9)
- Added `OlsPool`, `OlsLiquidityEvent`, `OlsLifecycleEvent` entities to `schema.graphql`
- Created `src/handlers/openLiquidityStrategy.ts` with 4 event handlers (PoolAdded, PoolRemoved, RebalanceCooldownSet, LiquidityMoved)
- Added `import "./handlers/openLiquidityStrategy"` to `EventHandlers.ts`
- `pnpm build` passes ✅

**Key implementation note:** Envio generates tuple event params as positional arrays, not named objects. `PoolAdded.params` is typed as `[Address, Address, bigint, Address, bigint, bigint, bigint, bigint]` — accessed by index `p[1]`, `p[2]`, etc. Also `cooldown` in `RebalanceCooldownSet` is already `bigint`, not `number`.

**UI (`ui-dashboard/`)**
- Added `OlsPool` and `OlsLiquidityEvent` types to `lib/types.ts`
- Added `OLS_POOL`, `OLS_LIQUIDITY_EVENTS`, `ALL_OLS_POOLS` queries to `lib/queries.ts`
- Added `"ols"` to `TABS` in pool detail page
- Implemented `OlsTab` (wraps `OlsStatusPanel` + `OlsLiquidityTable`) in `pool/[poolId]/page.tsx`
- Added `olsPoolIds` prop to `PoolsTable` — shows purple "OLS" pill on registered pools
- Fetches `ALL_OLS_POOLS` in `pools/page.tsx` and passes to `PoolsTable`
- `pnpm build` passes ✅

### Commits
- `8f0afa4` feat(indexer): add OpenLiquidityStrategy event indexing
- `b27f385` feat(ui): add OLS tab and badge to pool pages

### What's next (Phase 2)

- Deploy indexer to Envio and verify events flow on Monad
- Add Celo config once address is confirmed
- Phase 2 enhancements:
  - Cooldown pressure progress bar in status panel
  - Rebalance frequency chart (time series with expand/contract breakdown)
  - OLS lifecycle history table (PoolAdded, PoolRemoved, cooldown changes)
  - SPEC.md updates

### Open items / blockers
- Celo OLS contract address not yet deployed — Celo configs will be added when address is confirmed
