# Global Pool Table — Feature Work Log

## Phase 1: Setup & Exploration (DONE)

### What was done
- Ran `git fetch` and confirmed the repo at `~/code/mento-monitoring-monorepo` (actual path: `~/.openclaw/workspace/code/mento-monitoring-monorepo`).
- Created git worktree at `monitoring-monorepo-global-pool-table` on branch `feat/global-pool-table`.
- Explored the codebase:
  - Home page: `ui-dashboard/src/app/page.tsx` — renders per-chain `ChainPoolsSection` components, each wrapping `PoolsTable` in a `StaticNetworkProvider`.
  - `PoolsTable` (`ui-dashboard/src/components/pools-table.tsx`) — depends on `useNetwork()` context for pool name resolution, TVL calculation, sort context, and link construction. Sorts by `totalVolume` desc by default.
  - `useAllNetworksData` — fetches pools, snapshots, and fees for all configured chains in parallel; returns `NetworkData[]` with per-chain `network`, `pools`, `snapshots`, etc.
  - `NetworkData` type has `network: Network` and `pools: Pool[]` fields.
  - `StaticNetworkProvider` injects a fixed network into context.

### Key decisions
- Create a new `GlobalPoolsTable` component that takes `pools` annotated with their `Network`, plus a merged `volume24h` map across all chains.
- The component will NOT use `useNetwork()` — instead each row receives its own `network` alongside the `Pool`.
- Add a "Chain" column between "Pool" and "Source/Health".
- Default sort: `tvl` descending (as requested by the feature spec).
- Keep all existing columns (Pool, Source, Health, TVL, 24h Volume, Total Volume, Swaps, Rebalances, Rebalancer).
- Replace the `configuredNetworks.map(ChainPoolsSection)` section on the home page with a single `<GlobalPoolsTable>`.

---

## Phase 2: Implementation (DONE)

### What was done

**New component: `ui-dashboard/src/components/global-pools-table.tsx`**
- `GlobalPoolEntry` type: `{ pool: Pool; network: Network }` — enriches each pool with its originating network.
- `globalPoolKey(entry)` utility: returns `${network.id}:${pool.id}` to uniquely identify pools across chains (prevents collisions when two chains have pools with the same on-chain ID).
- `sortGlobalPools()`: like the existing `sortPools()` but works with `GlobalPoolEntry[]` and supports a new `"chain"` sort key.
- `GlobalPoolsTable` component:
  - Default sort: `tvl` descending (as specified).
  - Columns: Pool, Chain (new, hidden on mobile), Source (conditional on `hasVirtualPools`), Health, TVL, 24h Volume, Total Volume, Swaps, Rebalances, Rebalancer.
  - Uses `Link` directly with `?network=<networkId>` for pool detail links (no `NetworkAwareLink` since we have explicit networks per row).
  - Shows Source badge if any network in the list has virtual pools; shows `—` for rows from non-virtual-pool chains.
  - Weekend banner preserved.
  - `volume24hByKey` map keyed by `globalPoolKey` to avoid cross-chain collisions.

**Updated: `ui-dashboard/src/app/page.tsx`**
- Removed: per-chain `ChainPoolsSection` pattern, `StaticNetworkProvider`, import of `PoolsTable`.
- Added: `useMemo` that builds `globalEntries: GlobalPoolEntry[]` and `volume24hByKey` from all network data.
- Top-level network errors rendered as `ErrorBox` notices (one per failing chain) above the unified table.
- "All Pools" section now renders a single `<GlobalPoolsTable>` instead of one table per chain.
- KPI tiles (Summary section) unchanged.

**Updated: `ui-dashboard/src/app/__tests__/page.test.tsx`**
- Removed mock for `@/components/pools-table` and `@/components/network-provider` (no longer used on home page).
- Added mock for `@/components/global-pools-table` with a stub `GlobalPoolsTable` and the real `globalPoolKey` function.

**New test: `ui-dashboard/src/components/__tests__/global-pools-table.test.tsx`**
- 15 tests covering: `globalPoolKey`, column structure, Chain label rendering, pool detail links, 24h volume states, multi-chain rendering, and `sortGlobalPools` (TVL asc/desc, chain sort asc/desc).

### Results
- All 383 tests pass (368 original + 15 new).
- `tsc --noEmit` clean (no TypeScript errors).

---

## Final Summary

### Feature shipped
The home page (`/`) now shows ONE unified pool table sorted by TVL descending instead of separate tables per chain.

### Files changed
- **New**: `ui-dashboard/src/components/global-pools-table.tsx`
  The `GlobalPoolsTable` component and supporting types/helpers.
- **New**: `ui-dashboard/src/components/__tests__/global-pools-table.test.tsx`
  15 tests covering the new component and sort logic.
- **Modified**: `ui-dashboard/src/app/page.tsx`
  Replaced `ChainPoolsSection` / per-chain rendering with a single `GlobalPoolsTable`. Added logic to build a flat `GlobalPoolEntry[]` and a cross-chain `volume24hByKey` map.
- **Modified**: `ui-dashboard/src/app/__tests__/page.test.tsx`
  Updated mocks to reflect the new imports.

### Design decisions
- Pool rows are uniquely keyed by `${network.id}:${pool.id}` to avoid ID collisions across chains.
- The "Chain" column is hidden on small screens (same responsive pattern as other secondary columns).
- Pool detail links use `?network=<id>` explicitly; `NetworkAwareLink` was not used since each row has a concrete network.
- When any chain's snapshot query fails, that chain's volume cells show "N/A" individually (not a whole-table error).
- Top-level network failures (pools query failure) render as `ErrorBox` notices above the table.
- The `Source` column only appears when at least one entry's network has `hasVirtualPools: true`; rows from non-virtual chains show `—`.

### Test results
All 383 tests pass. `tsc --noEmit` clean.
