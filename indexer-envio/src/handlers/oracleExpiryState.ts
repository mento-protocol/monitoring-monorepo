import type { EvmOnEventContext, OracleExpiryState } from "envio";
import {
  applyGlobalReportExpiry,
  applyTokenReportExpiry,
  bootstrapOracleExpiryState,
  oracleExpiryStateId,
} from "../oracleExpiryState.js";
import { reportExpiryConfigEffect } from "../rpc/effects.js";

export type OracleExpiryEvent = {
  chainId: number;
  rateFeedID: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
  logIndex: number;
};

export type OracleExpiryMutation =
  | { kind: "global"; reportExpiry: bigint }
  | { kind: "token"; reportExpiry: bigint };

export async function preloadOracleExpiryState(
  context: Pick<EvmOnEventContext, "OracleExpiryState">,
  chainId: number,
  rateFeedID: string,
): Promise<void> {
  await context.OracleExpiryState.get(oracleExpiryStateId(chainId, rateFeedID));
}

function unavailableMessage(event: OracleExpiryEvent): string {
  return (
    `sortedOracles.oracleExpiryStateUnavailable ` +
    `chainId=${event.chainId} feed=${event.rateFeedID} ` +
    `block=${event.blockNumber} logIndex=${event.logIndex}`
  );
}

async function bootstrapExpiryState(
  context: EvmOnEventContext,
  event: OracleExpiryEvent,
  bootstrapThroughBlock: bigint,
): Promise<OracleExpiryState> {
  if (
    event.blockNumber <= 0n ||
    bootstrapThroughBlock < 0n ||
    bootstrapThroughBlock > event.blockNumber
  ) {
    const message = unavailableMessage(event);
    context.log.error(message);
    throw new Error(message);
  }
  // preload-effect-exempt: one exact raw-expiry bootstrap per tracked feed; ordered processing must first observe config rows written by earlier logs.
  const config = await context.effect(reportExpiryConfigEffect, {
    chainId: event.chainId,
    rateFeedID: event.rateFeedID,
    blockNumber: bootstrapThroughBlock,
  });
  if (config == null) {
    const message = unavailableMessage(event);
    context.log.error(message);
    throw new Error(message);
  }
  try {
    return bootstrapOracleExpiryState({
      chainId: event.chainId,
      rateFeedID: event.rateFeedID,
      globalReportExpiry: config.globalReportExpiry,
      tokenReportExpiry: config.tokenReportExpiry,
      bootstrapThroughBlock,
    });
  } catch (error) {
    const message = `${unavailableMessage(event)} reason=${String(error)}`;
    context.log.error(message);
    throw new Error(message, { cause: error });
  }
}

/** Resolve raw/effective expiry configuration at an exact bootstrap boundary,
 * then optionally apply one governance event in block/log order. A block-close
 * bootstrap already contains every expiry log in that initialization block,
 * so those same-block events are absorbed rather than replayed twice. */
export async function resolveOracleExpiryState(args: {
  context: EvmOnEventContext;
  event: OracleExpiryEvent;
  bootstrapThroughBlock: bigint;
  mutation?: OracleExpiryMutation;
}): Promise<OracleExpiryState> {
  const id = oracleExpiryStateId(args.event.chainId, args.event.rateFeedID);
  const existing = await args.context.OracleExpiryState.get(id);
  const base =
    existing ??
    (await bootstrapExpiryState(
      args.context,
      args.event,
      args.bootstrapThroughBlock,
    ));

  if (args.event.blockNumber === base.bootstrapThroughBlock) {
    if (existing) return existing;
    const absorbed = {
      ...base,
      updatedAtTimestamp: args.event.blockTimestamp,
    };
    args.context.OracleExpiryState.set(absorbed);
    return absorbed;
  }
  if (!args.mutation) {
    if (!existing) args.context.OracleExpiryState.set(base);
    return base;
  }

  const eventPosition = {
    blockNumber: args.event.blockNumber,
    blockTimestamp: args.event.blockTimestamp,
    logIndex: args.event.logIndex,
  };
  const updated =
    args.mutation.kind === "token"
      ? applyTokenReportExpiry(base, args.mutation.reportExpiry, eventPosition)
      : applyGlobalReportExpiry(
          base,
          args.mutation.reportExpiry,
          eventPosition,
        );
  if (updated !== existing) args.context.OracleExpiryState.set(updated);
  return updated;
}
