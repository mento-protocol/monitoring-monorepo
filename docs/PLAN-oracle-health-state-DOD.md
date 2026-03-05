# Oracle & Health State — Definition of Done

## Checklist

### UI — Pool List Page
- [ ] Pool list page shows a "Status" column with colored badges (OK/WARN/CRITICAL/N/A)
- [ ] FPMM pools (source contains "fpmm") show colored health badges based on oracle state
- [ ] VirtualPools (source contains "virtual") show gray "N/A" badge

### UI — Pool Detail Page
- [ ] Clicking a pool opens detail page with a health panel showing:
  - Oracle Status (Fresh/Stale) + last updated timestamp
  - Oracle Price (e.g. "1 GBPm = 1.3339 USDm")
  - Deviation ratio (X bps / Y bps) with progress bar
  - Last Rebalance (relative time or "Never")
  - Number of reporters
- [ ] Health panel shows "N/A" state for VirtualPools
- [ ] Pool detail page has an "oracle" tab with an oracle price chart (Plotly)
- [ ] Oracle tab shows historical oracle price + deviation as chart + table

### Indexer
- [ ] Schema: Pool entity has oracle fields (`oracleOk`, `oraclePrice`, `oraclePriceDenom`, `oracleTimestamp`, `oracleExpiry`, `oracleNumReporters`, `referenceRateFeedID`, `priceDifference`, `rebalanceThreshold`, `lastRebalancedAt`, `healthStatus`)
- [ ] Schema: `OracleSnapshot` entity indexed by `poolId` and `timestamp`
- [ ] SortedOracles ABI extracted and available at `indexer-envio/abis/SortedOracles.json`
- [ ] Mainnet config indexes SortedOracles events (`OracleReported`, `MedianUpdated`) at `0xefB84935239dAcdecF7c5bA76d8dE40b077B7b33`
- [ ] Sepolia and DevNet configs are NOT modified (SortedOracles not deployed there)
- [ ] FPMM pool creation (FPMMDeployed) fetches `referenceRateFeedID()` and `getRebalancingState()` via viem
- [ ] UpdateReserves handler updates oracle fields and creates OracleSnapshot
- [ ] Rebalanced handler updates oracle fields + `lastRebalancedAt`, creates OracleSnapshot
- [ ] SortedOracles.OracleReported handler updates pool oracle state and creates OracleSnapshot
- [ ] SortedOracles.MedianUpdated handler updates pool oracle price
- [ ] VirtualPool handlers set all oracle fields to defaults with `healthStatus: "N/A"`
- [ ] VirtualPool Swap/Mint/Burn/UpdateReserves/Rebalanced events are tracked (reserves, volumes)

### Verification
- [ ] Codegen passes for mainnet config (`pnpm indexer:mainnet:codegen`)
- [ ] Dashboard builds with zero errors (`pnpm --filter ui-dashboard build`)
- [ ] All existing tests pass + 15 new tests for health status computation (`pnpm --filter ui-dashboard test`)

## How to Test in Browser

1. Start the indexer with mainnet config and let it sync
2. Open pool list → verify "Status" column appears with colored badges
3. Check FPMM pools show OK/WARN/CRITICAL (not N/A)
4. Check VirtualPools show "⚪ N/A" in the Status column
5. Click any FPMM pool → verify Health Status panel appears above the tabs
6. Click "oracle" tab → verify chart renders (empty message if no snapshots yet)
7. Compare `healthStatus` in GraphQL with manual calculation:
   - Query `getRebalancingState()` on a mainnet FPMM pool
   - Compute: `priceDifference / rebalanceThreshold`
   - If >= 1.0 → CRITICAL; if >= 0.8 → WARN; else → OK

## Implementation Notes

### rateFeedID → Pool Mapping
The in-memory `rateFeedPoolMap` is populated when FPMMDeployed events fire. On indexer restart, this map is empty until pools are re-indexed. SortedOracles events that fire before FPMMDeployed events are processed will be silently skipped (pool not found). This is acceptable for mainnet where pools were deployed well before the current start block.

### VirtualPool Oracle Data
VirtualPools have no `referenceRateFeedID()` or `getRebalancingState()` functions. They are plain AMM pools. Health status is always "N/A" for these pools.

### Oracle Price Format
`oraclePrice` and `oraclePriceDenom` are raw values from the oracle (24 decimal precision for SortedOracles). Display as: `oraclePrice / oraclePriceDenom` to get the rate.

### SortedOracles Networks
SortedOracles is only indexed on Celo Mainnet. Sepolia has no SortedOracles contract and DevNet has no OracleAdapter. Future work: add Sepolia support when SortedOracles is deployed.
