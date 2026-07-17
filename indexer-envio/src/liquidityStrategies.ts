import type { EvmOnEventContext, Pool, PoolLiquidityStrategy } from "envio";
import { lookupLiquidityStrategyKind } from "./contractAddresses.js";

export type LiquidityStrategyKindName = "OPEN" | "CDP" | "RESERVE" | "UNKNOWN";

type LiquidityStrategyContext = Pick<
  EvmOnEventContext,
  "Pool" | "PoolLiquidityStrategy"
> & { isPreload: boolean };

export function poolLiquidityStrategyId(
  poolId: string,
  strategyAddress: string,
): string {
  return `${poolId}-${strategyAddress.toLowerCase()}`;
}

function resolvedKind(args: {
  chainId: number;
  strategyAddress: string;
  explicitKind?: LiquidityStrategyKindName;
  existing?: PoolLiquidityStrategy;
}): LiquidityStrategyKindName {
  const observed =
    args.explicitKind ??
    lookupLiquidityStrategyKind(args.chainId, args.strategyAddress) ??
    "UNKNOWN";
  if (observed === "UNKNOWN" && args.existing?.kind !== undefined) {
    return args.existing.kind;
  }
  return observed;
}

function fallbackLegacyRebalancer(
  rows: readonly PoolLiquidityStrategy[],
  disabledAddress: string,
): string {
  const disabled = disabledAddress.toLowerCase();
  return (
    rows
      .filter(
        (row) => row.active && row.strategyAddress.toLowerCase() !== disabled,
      )
      .sort((a, b) => {
        if (a.updatedAtBlock !== b.updatedAtBlock) {
          return a.updatedAtBlock > b.updatedAtBlock ? -1 : 1;
        }
        return a.strategyAddress.localeCompare(b.strategyAddress);
      })[0]?.strategyAddress ?? ""
  );
}

/**
 * Persist one pool/strategy authorization transition and keep the legacy
 * Pool.rebalancerAddress pointer usable for older consumers. The entity is the
 * authoritative representation: multiple rows may be active for one pool.
 *
 * This helper performs its reads in Envio's preload pass and writes only in
 * processing, so callers can use it from FPMM, OLS, and CDP lifecycle events
 * without duplicating preload guards.
 */
export async function syncPoolLiquidityStrategy(args: {
  context: LiquidityStrategyContext;
  chainId: number;
  poolId: string;
  strategyAddress: string;
  active: boolean;
  explicitKind?: LiquidityStrategyKindName;
  blockNumber: bigint;
  blockTimestamp: bigint;
}): Promise<void> {
  const strategyAddress = args.strategyAddress.toLowerCase();
  const id = poolLiquidityStrategyId(args.poolId, strategyAddress);
  const [existing, pool, activeRows] = await Promise.all([
    args.context.PoolLiquidityStrategy.get(id),
    args.context.Pool.get(args.poolId),
    args.active
      ? Promise.resolve([] as PoolLiquidityStrategy[])
      : args.context.PoolLiquidityStrategy.getWhere({
          poolId: { _eq: args.poolId },
        }),
  ]);
  if (args.context.isPreload) return;

  const next: PoolLiquidityStrategy = {
    id,
    chainId: args.chainId,
    poolId: args.poolId,
    strategyAddress,
    kind: resolvedKind({
      chainId: args.chainId,
      strategyAddress,
      ...(args.explicitKind === undefined
        ? {}
        : { explicitKind: args.explicitKind }),
      ...(existing === undefined ? {} : { existing }),
    }),
    active: args.active,
    addedAtBlock: existing?.addedAtBlock ?? args.blockNumber,
    addedAtTimestamp: existing?.addedAtTimestamp ?? args.blockTimestamp,
    updatedAtBlock: args.blockNumber,
    updatedAtTimestamp: args.blockTimestamp,
  };
  args.context.PoolLiquidityStrategy.set(next);

  if (!pool) return;
  const legacyRebalancer = args.active
    ? strategyAddress
    : pool.rebalancerAddress.toLowerCase() === strategyAddress
      ? fallbackLegacyRebalancer(activeRows, strategyAddress)
      : pool.rebalancerAddress;
  if (legacyRebalancer === pool.rebalancerAddress) return;
  const updatedPool: Pool = {
    ...pool,
    rebalancerAddress: legacyRebalancer,
    updatedAtBlock: args.blockNumber,
    updatedAtTimestamp: args.blockTimestamp,
  };
  args.context.Pool.set(updatedPool);
}
