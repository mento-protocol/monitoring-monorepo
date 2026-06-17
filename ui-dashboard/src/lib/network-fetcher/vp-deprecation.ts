export type VpExchangeDeprecationRow = {
  wrappedByPoolId?: string;
  isDeprecated?: boolean;
};

export type VpLifecycleDeprecationRow = {
  poolId?: string;
};

function deprecatedVirtualPoolIds(
  exchangeRows: readonly VpExchangeDeprecationRow[],
  lifecycleRows: readonly VpLifecycleDeprecationRow[],
): Set<string> {
  const deprecatedPoolIds = new Set<string>();
  for (const row of exchangeRows) {
    if (row.wrappedByPoolId && row.isDeprecated) {
      deprecatedPoolIds.add(row.wrappedByPoolId);
    }
  }
  for (const row of lifecycleRows) {
    if (row.poolId) deprecatedPoolIds.add(row.poolId);
  }
  return deprecatedPoolIds;
}

export function mergeDeprecatedVirtualPools<TPool extends { id: string }>(
  pools: readonly TPool[],
  exchangeRows: readonly VpExchangeDeprecationRow[],
  lifecycleRows: readonly VpLifecycleDeprecationRow[],
): TPool[] {
  const deprecatedPoolIds = deprecatedVirtualPoolIds(
    exchangeRows,
    lifecycleRows,
  );
  if (deprecatedPoolIds.size === 0) return pools.slice();
  return pools.map((pool) =>
    deprecatedPoolIds.has(pool.id)
      ? { ...pool, wrappedExchangeDeprecated: true }
      : pool,
  );
}
