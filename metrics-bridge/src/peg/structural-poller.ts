import { resolvePegBreakerEvidence } from "./breaker-evidence.js";
import {
  fetchPegStructuralContext,
  type PegStructuralContextResult,
  type PegTradingLimitRow,
} from "./graphql.js";
import type { PegMonitorMetricSnapshot } from "./metrics.js";
import {
  PEG_REGISTRY_MAX_MONITORS_PER_ASSET,
  type PegMonitor,
} from "./registry.js";
import {
  computeStructuralSaturation,
  deriveReferenceSize,
  FPMM_L1_WINDOW_SECONDS,
  TRADING_LIMIT_INTERNAL_DECIMALS,
} from "./structural.js";

export interface PegPolledStructuralContext {
  reachable: boolean;
  querySaturated: boolean;
  saturation: number | null;
  counterpartyCount: number;
  limits: PegTradingLimitRow[];
  monitors: PegMonitorMetricSnapshot[];
}

type StructuralPollErrorKind =
  | "bounds"
  | "structural_query"
  | "structural_missing"
  | "structural_binding"
  | "structural_data";

interface StructuralPollErrorLocation {
  asset?: string;
  monitorIndex?: number;
}

interface StructuralPollContext {
  nowSeconds: number;
  dependencies: {
    fetchStructuralContext: typeof fetchPegStructuralContext;
    report: (
      kind: StructuralPollErrorKind,
      cause: unknown,
      location?: StructuralPollErrorLocation,
    ) => void;
  };
}

type MonitorResult = {
  snapshot: PegMonitorMetricSnapshot;
  limit: PegTradingLimitRow | null;
};

const poolIdFor = (monitor: PegMonitor) =>
  `${monitor.chainId}-${monitor.poolAddress.toLowerCase()}`;

const addressMatches = (left: string | null, right: string) =>
  typeof left === "string" && left.toLowerCase() === right.toLowerCase();

function structuralBindingIssue(
  monitor: PegMonitor,
  result: Extract<PegStructuralContextResult, { status: "ok" }>,
): string | null {
  const poolId = poolIdFor(monitor);
  if (result.pool.id !== poolId) return "pool id mismatch";
  if (result.pool.chainId !== monitor.chainId) return "pool chain mismatch";
  if (!String(result.pool.source).toLowerCase().includes("fpmm")) {
    return "pool source is not FPMM-backed";
  }
  if (!addressMatches(result.pool.referenceRateFeedID, monitor.rateFeedId)) {
    return "pool rate-feed mismatch";
  }
  const monitoredTokenInPool = [result.pool.token0, result.pool.token1].some(
    (token) => addressMatches(token, monitor.monitoredTokenAddress),
  );
  if (!monitoredTokenInPool) return "monitored token is absent from pool";
  if (result.tradingLimit.chainId !== monitor.chainId) {
    return "trading-limit chain mismatch";
  }
  if (result.tradingLimit.poolId !== poolId) {
    return "trading-limit pool mismatch";
  }
  if (
    !addressMatches(result.tradingLimit.token, monitor.monitoredTokenAddress)
  ) {
    return "trading-limit token mismatch";
  }
  if (result.tradingLimit.decimals !== TRADING_LIMIT_INTERNAL_DECIMALS) {
    return "trading-limit internal decimals mismatch";
  }
  return null;
}

const monitorIdentity = (monitor: PegMonitor) => ({
  chainId: monitor.chainId,
  poolAddress: monitor.poolAddress,
  rateFeedId: monitor.rateFeedId,
  monitoredTokenAddress: monitor.monitoredTokenAddress,
});

const failedMonitor = (
  monitor: PegMonitor,
  querySaturated = false,
): MonitorResult => ({
  snapshot: {
    ...monitorIdentity(monitor),
    indexedPoolReachable: false,
    structuralSaturation: null,
    structuralQuerySaturated: querySaturated,
    counterpartyCount: 0,
    breaker: null,
  },
  limit: null,
});

function boundedMonitors(
  monitors: PegMonitor[],
  context: StructuralPollContext,
): PegMonitor[] {
  if (monitors.length > PEG_REGISTRY_MAX_MONITORS_PER_ASSET) {
    context.dependencies.report(
      "bounds",
      new Error(
        `asset monitors exceeds parsed schema bound ${PEG_REGISTRY_MAX_MONITORS_PER_ASSET}`,
      ),
    );
  }
  return monitors.slice(0, PEG_REGISTRY_MAX_MONITORS_PER_ASSET);
}

// eslint-disable-next-line max-lines-per-function
async function pollMonitor(
  assetId: string,
  monitor: PegMonitor,
  monitorIndex: number,
  context: StructuralPollContext,
): Promise<MonitorResult> {
  const location = { asset: assetId, monitorIndex };
  let result: PegStructuralContextResult;
  try {
    result = await context.dependencies.fetchStructuralContext({
      poolId: poolIdFor(monitor),
      monitoredToken: monitor.monitoredTokenAddress,
      chainId: monitor.chainId,
      rateFeedId: monitor.rateFeedId,
      since: BigInt(Math.max(0, context.nowSeconds - FPMM_L1_WINDOW_SECONDS)),
    });
  } catch (error) {
    context.dependencies.report("structural_query", error, location);
    return failedMonitor(monitor);
  }

  if (result.status !== "ok") {
    context.dependencies.report(
      "structural_missing",
      new Error(`structural context status: ${result.status}`),
      location,
    );
    return failedMonitor(monitor, result.pageSaturated);
  }
  const bindingIssue = structuralBindingIssue(monitor, result);
  if (bindingIssue !== null) {
    context.dependencies.report(
      "structural_binding",
      new Error(bindingIssue),
      location,
    );
    return failedMonitor(monitor, result.pageSaturated);
  }

  try {
    const { saturationFraction } = computeStructuralSaturation(
      result.tradingLimit,
      BigInt(context.nowSeconds),
    );
    // Validate the fixed-15 limits once. Source-specific caps are applied later.
    deriveReferenceSize(result.tradingLimit, Number.MAX_VALUE);
    const breaker = resolvePegBreakerEvidence(result.breakerConfigs ?? []);
    if (breaker.error !== null) {
      context.dependencies.report("structural_data", breaker.error, location);
    }
    return {
      snapshot: {
        ...monitorIdentity(monitor),
        indexedPoolReachable: true,
        structuralSaturation: saturationFraction,
        structuralQuerySaturated: result.pageSaturated,
        counterpartyCount: new Set(
          result.swaps.map(({ caller }) => caller.toLowerCase()),
        ).size,
        breaker: breaker.breaker,
      },
      limit: result.tradingLimit,
    };
  } catch (error) {
    context.dependencies.report("structural_data", error, location);
    return failedMonitor(monitor, result.pageSaturated);
  }
}

export async function pollPegStructuralContext(
  assetId: string,
  monitors: PegMonitor[],
  context: StructuralPollContext,
): Promise<PegPolledStructuralContext> {
  const results = await Promise.all(
    boundedMonitors(monitors, context).map((monitor, index) =>
      pollMonitor(assetId, monitor, index, context),
    ),
  );
  const reachable =
    results.length > 0 &&
    results.every(({ snapshot }) => snapshot.indexedPoolReachable);
  const saturations = results.flatMap(({ snapshot }) =>
    snapshot.structuralSaturation === null
      ? []
      : [snapshot.structuralSaturation],
  );
  return {
    reachable,
    querySaturated: results.some(
      ({ snapshot }) => snapshot.structuralQuerySaturated,
    ),
    saturation:
      reachable && saturations.length > 0 ? Math.max(...saturations) : null,
    counterpartyCount: results.reduce(
      (total, { snapshot }) => total + snapshot.counterpartyCount,
      0,
    ),
    limits: reachable
      ? results.flatMap(({ limit }) => (limit === null ? [] : [limit]))
      : [],
    monitors: results.map(({ snapshot }) => snapshot),
  };
}
