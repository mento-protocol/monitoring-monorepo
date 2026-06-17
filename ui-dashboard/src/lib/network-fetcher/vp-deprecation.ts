export type VpExchangeDeprecationRow = {
  wrappedByPoolId?: string;
  isDeprecated?: boolean;
  minimumReports?: string;
};

export type VpExchangeDeprecationResult = {
  BiPoolExchange: VpExchangeDeprecationRow[];
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
  const exchangeByPoolId = new Map<string, VpExchangeDeprecationRow>();
  for (const row of exchangeRows) {
    if (row.wrappedByPoolId) exchangeByPoolId.set(row.wrappedByPoolId, row);
  }
  if (deprecatedPoolIds.size === 0 && exchangeByPoolId.size === 0) {
    return pools.slice();
  }
  return pools.map((pool) => {
    const exchange = exchangeByPoolId.get(pool.id);
    if (!exchange && !deprecatedPoolIds.has(pool.id)) return pool;
    return {
      ...pool,
      ...(deprecatedPoolIds.has(pool.id)
        ? { wrappedExchangeDeprecated: true }
        : {}),
      ...(exchange?.minimumReports !== undefined
        ? { wrappedExchangeMinimumReports: exchange.minimumReports }
        : {}),
    };
  });
}
