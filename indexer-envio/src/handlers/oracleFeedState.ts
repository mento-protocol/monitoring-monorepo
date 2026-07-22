import type { EvmOnEventContext, OracleFeedState, Pool } from "envio";
import { indexer } from "../indexer.js";
import { asAddress, asBigInt } from "../helpers.js";
import { updateHealthAccumulators } from "../healthScore.js";
import {
  applyOracleFeedExpiry,
  applyOracleReport,
  applyOracleReportRemoval,
  bootstrapOracleFeedState,
  oracleFeedStateId,
} from "../oracleFeedState.js";
import { computeHealthStatus, maybePreloadPool } from "../pool.js";
import { getPoolsByFeed } from "../rpc.js";
import {
  oracleReportTimestampsEffectForChain,
  reportExpiryEffect,
} from "../rpc/effects.js";

type FeedMutation =
  | { kind: "report"; reporterAddress: string; reportTimestamp: bigint }
  | { kind: "remove"; reporterAddress: string };

type FeedEvent = {
  chainId: number;
  rateFeedID: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
  logIndex: number;
};

export async function preloadOracleFeedState(
  context: Pick<EvmOnEventContext, "OracleFeedState">,
  chainId: number,
  rateFeedID: string,
): Promise<void> {
  await context.OracleFeedState.get(oracleFeedStateId(chainId, rateFeedID));
}

export async function oracleFeedBootstrapInputs(
  context: Pick<EvmOnEventContext, "Pool">,
  poolIds: readonly string[],
  eventBlockNumber: bigint,
): Promise<{
  knownReportExpiry: bigint | null;
  bootstrapThroughBlock: bigint;
}> {
  const pools = await Promise.all(
    poolIds.map((poolId) => context.Pool.get(poolId)),
  );
  const expiries = new Set(
    pools.flatMap((pool) =>
      pool && pool.oracleExpiry > 0n ? [pool.oracleExpiry] : [],
    ),
  );
  const hasTrackedPoolStateFromEarlierBlock = pools.some(
    (pool) => pool !== undefined && pool.updatedAtBlock < eventBlockNumber,
  );
  const bootstrapAtBlockClose = !hasTrackedPoolStateFromEarlierBlock;
  return {
    // Keep timestamps and expiry on the same boundary. A current-block Pool
    // row can still predate a later expiry event in that block, so block-close
    // bootstrap must recover the exact effective expiry by RPC.
    knownReportExpiry:
      !bootstrapAtBlockClose && expiries.size === 1 ? [...expiries][0]! : null,
    // JSON-RPC cannot snapshot an intra-block log boundary. If no currently
    // referencing pool row was persisted before this block, the feed may have
    // become tracked after an earlier oracle log (deployment or self-heal).
    // Bootstrap block-close state and absorb this block's transitions; later
    // blocks resume log ordering.
    bootstrapThroughBlock: bootstrapAtBlockClose
      ? eventBlockNumber
      : eventBlockNumber - 1n,
  };
}

function unavailableMessage(
  event: FeedEvent,
  detail: "timestamps" | "expiry" | "state",
): string {
  return (
    `sortedOracles.oracleFeedStateUnavailable detail=${detail} ` +
    `chainId=${event.chainId} feed=${event.rateFeedID} ` +
    `block=${event.blockNumber} logIndex=${event.logIndex}`
  );
}

async function bootstrapFeedState(
  context: EvmOnEventContext,
  event: FeedEvent,
  knownReportExpiry: bigint | null,
  bootstrapThroughBlock: bigint,
): Promise<OracleFeedState> {
  if (
    event.blockNumber <= 0n ||
    bootstrapThroughBlock < 0n ||
    bootstrapThroughBlock > event.blockNumber
  ) {
    const message = unavailableMessage(event, "state");
    context.log.error(message);
    throw new Error(message);
  }
  // preload-effect-exempt: one exact boundary timestamp-list bootstrap per tracked feed; the persisted row makes every later report RPC-free.
  const reportsPromise = context.effect(
    oracleReportTimestampsEffectForChain(event.chainId),
    {
      chainId: event.chainId,
      rateFeedID: event.rateFeedID,
      blockNumber: bootstrapThroughBlock,
    },
  );
  const expiryPromise =
    knownReportExpiry !== null
      ? Promise.resolve(knownReportExpiry)
      : // preload-effect-exempt: one exact-boundary expiry recovery per feed whose pool deployment did not seed it.
        context.effect(reportExpiryEffect, {
          chainId: event.chainId,
          rateFeedID: event.rateFeedID,
          blockNumber: bootstrapThroughBlock,
        });
  const [reports, reportExpiry] = await Promise.all([
    reportsPromise,
    expiryPromise,
  ]);
  if (reports == null) {
    const message = unavailableMessage(event, "timestamps");
    context.log.error(message);
    throw new Error(message);
  }
  if (reportExpiry == null || reportExpiry <= 0n) {
    const message = unavailableMessage(event, "expiry");
    context.log.error(message);
    throw new Error(message);
  }

  try {
    return bootstrapOracleFeedState({
      chainId: event.chainId,
      rateFeedID: event.rateFeedID,
      reporters: reports.reporters,
      timestamps: reports.timestamps,
      reportExpiry,
      bootstrapThroughBlock,
    });
  } catch (error) {
    const message = `${unavailableMessage(event, "state")} reason=${String(error)}`;
    context.log.error(message);
    throw new Error(message, { cause: error });
  }
}

/** Resolve the persisted feed state and apply one report/removal transition.
 * Bootstrap is deliberately processing-only: preload may not see the row an
 * earlier event creates in ordered processing. */
export async function resolveOracleFeedState(args: {
  context: EvmOnEventContext;
  event: FeedEvent;
  mutation: FeedMutation;
  knownReportExpiry: bigint | null;
  bootstrapThroughBlock: bigint;
}): Promise<OracleFeedState> {
  const id = oracleFeedStateId(args.event.chainId, args.event.rateFeedID);
  const existing = await args.context.OracleFeedState.get(id);
  const base =
    existing ??
    (await bootstrapFeedState(
      args.context,
      args.event,
      args.knownReportExpiry,
      args.bootstrapThroughBlock,
    ));
  // A feed with no referencing Pool row persisted before this block is
  // bootstrapped at exact block-close state. That snapshot already contains
  // every report and removal in the block, including logs before feed
  // assignment and after this handler, so replaying a same-block transition
  // would double-apply it.
  if (args.event.blockNumber === base.bootstrapThroughBlock) {
    if (existing) return existing;
    const absorbed = {
      ...base,
      updatedAtTimestamp: args.event.blockTimestamp,
    };
    args.context.OracleFeedState.set(absorbed);
    return absorbed;
  }
  const eventPosition = {
    blockNumber: args.event.blockNumber,
    blockTimestamp: args.event.blockTimestamp,
    logIndex: args.event.logIndex,
  };
  const updated =
    args.mutation.kind === "report"
      ? applyOracleReport(
          base,
          args.mutation.reporterAddress,
          args.mutation.reportTimestamp,
          eventPosition,
        )
      : applyOracleReportRemoval(
          base,
          args.mutation.reporterAddress,
          eventPosition,
        );
  if (updated !== existing) args.context.OracleFeedState.set(updated);
  return updated;
}

export async function requireOracleFeedState(
  context: EvmOnEventContext,
  event: FeedEvent,
): Promise<OracleFeedState> {
  const state = await context.OracleFeedState.get(
    oracleFeedStateId(event.chainId, event.rateFeedID),
  );
  if (state) return state;
  const message = unavailableMessage(event, "state");
  context.log.error(message);
  throw new Error(message);
}

export async function updateOracleFeedStateExpiryIfPresent(args: {
  context: EvmOnEventContext;
  event: FeedEvent;
  reportExpiry: bigint | null | undefined;
}): Promise<void> {
  if (args.reportExpiry == null || args.reportExpiry <= 0n) return;
  const state = await args.context.OracleFeedState.get(
    oracleFeedStateId(args.event.chainId, args.event.rateFeedID),
  );
  if (!state) return;
  args.context.OracleFeedState.set(
    applyOracleFeedExpiry(state, args.reportExpiry, {
      blockNumber: args.event.blockNumber,
      blockTimestamp: args.event.blockTimestamp,
      logIndex: args.event.logIndex,
    }),
  );
}

async function updatePoolsAfterReportRemoval(args: {
  context: EvmOnEventContext;
  poolIds: readonly string[];
  state: OracleFeedState;
  blockNumber: bigint;
  blockTimestamp: bigint;
}): Promise<void> {
  await Promise.all(
    args.poolIds.map(async (poolId) => {
      const existing = await args.context.Pool.get(poolId);
      if (!existing) return;
      const healthBoundary =
        existing.lastOracleSnapshotTimestamp > 0n
          ? updateHealthAccumulators(
              existing,
              args.blockTimestamp,
              existing.lastDeviationRatio,
              {
                reportTimestamp: existing.lastOracleReportAt,
                expiry: existing.oracleExpiry,
              },
            )
          : {};
      const oracleOk =
        existing.medianLive &&
        args.state.medianReportTimestamp > 0n &&
        args.state.medianReportTimestamp + args.state.reportExpiry >=
          args.blockTimestamp;
      const updated: Pool = {
        ...existing,
        ...healthBoundary,
        lastOracleReportAt: args.state.medianReportTimestamp,
        oracleExpiry: args.state.reportExpiry,
        oracleOk,
        updatedAtBlock: args.blockNumber,
        updatedAtTimestamp: args.blockTimestamp,
      };
      args.context.Pool.set({
        ...updated,
        healthStatus: computeHealthStatus(updated, args.blockTimestamp),
      });
    }),
  );
}

indexer.onEvent(
  { contract: "SortedOracles", event: "OracleReportRemoved" },
  async ({ event, context }) => {
    const rateFeedID = asAddress(event.params.token);
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);
    const poolIds = await getPoolsByFeed(context, event.chainId, rateFeedID);
    // preload-handler-note: ordered processing must observe a feed bootstrap written by an earlier report; only the first tracked event performs the bounded exact bootstrap.
    // preload-effect-helpers: resolveOracleFeedState
    if (context.isPreload) {
      await Promise.all([
        preloadOracleFeedState(context, event.chainId, rateFeedID),
        maybePreloadPool(context, poolIds),
      ]);
      return;
    }
    if (poolIds.length === 0) return;

    const bootstrapInputs = await oracleFeedBootstrapInputs(
      context,
      poolIds,
      blockNumber,
    );
    const state = await resolveOracleFeedState({
      context,
      event: {
        chainId: event.chainId,
        rateFeedID,
        blockNumber,
        blockTimestamp,
        logIndex: event.logIndex,
      },
      mutation: {
        kind: "remove",
        reporterAddress: asAddress(event.params.oracle),
      },
      ...bootstrapInputs,
    });
    await updatePoolsAfterReportRemoval({
      context,
      poolIds,
      state,
      blockNumber,
      blockTimestamp,
    });
  },
);
