import type { OracleExpiryState } from "envio";
import { asAddress } from "./helpers.js";

type ExpiryStateEvent = {
  blockNumber: bigint;
  logIndex: number;
  blockTimestamp: bigint;
};

export function oracleExpiryStateId(
  chainId: number,
  rateFeedID: string,
): string {
  return `${chainId}-${asAddress(rateFeedID)}`;
}

function effectiveReportExpiry(
  globalReportExpiry: bigint,
  tokenReportExpiry: bigint,
): bigint {
  return tokenReportExpiry > 0n ? tokenReportExpiry : globalReportExpiry;
}

function eventPosition(
  state: OracleExpiryState,
  event: ExpiryStateEvent,
): number {
  if (event.blockNumber < state.updatedAtBlock) return -1;
  if (event.blockNumber > state.updatedAtBlock) return 1;
  return Math.sign(event.logIndex - state.updatedAtLogIndex);
}

function validateEventOrder(
  state: OracleExpiryState,
  event: ExpiryStateEvent,
  label: string,
): number {
  if (event.blockNumber <= state.bootstrapThroughBlock) {
    throw new Error(
      `${label} is at or behind bootstrap boundary block=${event.blockNumber} logIndex=${event.logIndex}`,
    );
  }

  const position = eventPosition(state, event);
  if (position < 0) {
    throw new Error(
      `${label} is out of order block=${event.blockNumber} logIndex=${event.logIndex}`,
    );
  }
  return position;
}

export function bootstrapOracleExpiryState(args: {
  chainId: number;
  rateFeedID: string;
  globalReportExpiry: bigint;
  tokenReportExpiry: bigint;
  bootstrapThroughBlock: bigint;
}): OracleExpiryState {
  if (args.globalReportExpiry <= 0n) {
    throw new Error(
      `oracle expiry bootstrap has invalid global expiry=${args.globalReportExpiry}`,
    );
  }
  if (args.tokenReportExpiry < 0n) {
    throw new Error(
      `oracle expiry bootstrap has invalid token expiry=${args.tokenReportExpiry}`,
    );
  }

  return {
    id: oracleExpiryStateId(args.chainId, args.rateFeedID),
    chainId: args.chainId,
    rateFeedID: asAddress(args.rateFeedID),
    globalReportExpiry: args.globalReportExpiry,
    tokenReportExpiry: args.tokenReportExpiry,
    reportExpiry: effectiveReportExpiry(
      args.globalReportExpiry,
      args.tokenReportExpiry,
    ),
    bootstrapThroughBlock: args.bootstrapThroughBlock,
    updatedAtBlock: args.bootstrapThroughBlock,
    updatedAtLogIndex: -1,
    updatedAtTimestamp: 0n,
  };
}

export function applyTokenReportExpiry(
  state: OracleExpiryState,
  tokenReportExpiry: bigint,
  event: ExpiryStateEvent,
): OracleExpiryState {
  if (tokenReportExpiry < 0n) {
    throw new Error(
      `TokenReportExpirySet has invalid token expiry=${tokenReportExpiry}`,
    );
  }

  const reportExpiry = effectiveReportExpiry(
    state.globalReportExpiry,
    tokenReportExpiry,
  );
  const position = validateEventOrder(state, event, "TokenReportExpirySet");
  if (position === 0) {
    if (
      state.tokenReportExpiry === tokenReportExpiry &&
      state.reportExpiry === reportExpiry
    ) {
      return state;
    }
    throw new Error(
      "TokenReportExpirySet conflicts at persisted event position",
    );
  }

  return {
    ...state,
    tokenReportExpiry,
    reportExpiry,
    updatedAtBlock: event.blockNumber,
    updatedAtLogIndex: event.logIndex,
    updatedAtTimestamp: event.blockTimestamp,
  };
}

export function applyGlobalReportExpiry(
  state: OracleExpiryState,
  globalReportExpiry: bigint,
  event: ExpiryStateEvent,
): OracleExpiryState {
  if (globalReportExpiry <= 0n) {
    throw new Error(
      `ReportExpirySet has invalid global expiry=${globalReportExpiry}`,
    );
  }

  const reportExpiry = effectiveReportExpiry(
    globalReportExpiry,
    state.tokenReportExpiry,
  );
  const position = validateEventOrder(state, event, "ReportExpirySet");
  if (position === 0) {
    if (
      state.globalReportExpiry === globalReportExpiry &&
      state.reportExpiry === reportExpiry
    ) {
      return state;
    }
    throw new Error("ReportExpirySet conflicts at persisted event position");
  }

  return {
    ...state,
    globalReportExpiry,
    reportExpiry,
    updatedAtBlock: event.blockNumber,
    updatedAtLogIndex: event.logIndex,
    updatedAtTimestamp: event.blockTimestamp,
  };
}
