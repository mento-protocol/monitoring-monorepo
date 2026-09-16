import type { OracleFeedState } from "envio";
import { asAddress } from "./helpers.js";

type FeedStateBase = Pick<
  OracleFeedState,
  "id" | "chainId" | "rateFeedID" | "reportExpiry" | "bootstrapThroughBlock"
>;

type FeedStateEvent = {
  blockNumber: bigint;
  logIndex: number;
  blockTimestamp: bigint;
};

export function oracleFeedStateId(chainId: number, rateFeedID: string): string {
  return `${chainId}-${asAddress(rateFeedID)}`;
}

export function upperMedianTimestamp(timestamps: readonly bigint[]): bigint {
  if (timestamps.length === 0) return 0n;
  const sorted = [...timestamps].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor(sorted.length / 2)]!;
}

function canonicalReports(
  reporters: readonly string[],
  timestamps: readonly bigint[],
): { activeReporters: string[]; activeReportTimestamps: bigint[] } {
  if (reporters.length !== timestamps.length) {
    throw new Error(
      `oracle feed bootstrap length mismatch reporters=${reporters.length} timestamps=${timestamps.length}`,
    );
  }

  const reports = new Map<string, bigint>();
  for (let index = 0; index < reporters.length; index += 1) {
    const reporter = asAddress(reporters[index]!);
    const timestamp = timestamps[index]!;
    if (timestamp <= 0n) {
      throw new Error(
        `oracle feed bootstrap has non-positive timestamp reporter=${reporter}`,
      );
    }
    if (reports.has(reporter)) {
      throw new Error(
        `oracle feed bootstrap has duplicate reporter=${reporter}`,
      );
    }
    reports.set(reporter, timestamp);
  }

  const entries = [...reports.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return {
    activeReporters: entries.map(([reporter]) => reporter),
    activeReportTimestamps: entries.map(([, timestamp]) => timestamp),
  };
}

function rebuildFeedState(
  base: FeedStateBase,
  reporters: readonly string[],
  timestamps: readonly bigint[],
  event: FeedStateEvent,
): OracleFeedState {
  const canonical = canonicalReports(reporters, timestamps);
  return {
    ...base,
    ...canonical,
    medianReportTimestamp: upperMedianTimestamp(
      canonical.activeReportTimestamps,
    ),
    updatedAtBlock: event.blockNumber,
    updatedAtLogIndex: event.logIndex,
    updatedAtTimestamp: event.blockTimestamp,
  };
}

function eventPosition(state: OracleFeedState, event: FeedStateEvent): number {
  if (event.blockNumber < state.updatedAtBlock) return -1;
  if (event.blockNumber > state.updatedAtBlock) return 1;
  return Math.sign(event.logIndex - state.updatedAtLogIndex);
}

/** True when the event sits strictly behind the persisted watermark — the only
 * ordering `applyOracleFeedExpiry` rejects. A caller that mirrors an expiry the
 * expiry state machine has already validated uses this rather than the wider
 * predicate below: an expiry log inside the bootstrap boundary block still has
 * to reach the feed row. See ADR 0105. */
export function isEventBehindWatermark(
  state: OracleFeedState,
  event: FeedStateEvent,
): boolean {
  return eventPosition(state, event) < 0;
}

/** True when the persisted row already reflects this event's position for a
 * caller that advances the watermark itself. `MedianUpdated` is that caller:
 * the feed-state-writing log it follows always sits at a strictly lower
 * logIndex in the same block, so a first delivery is always strictly ahead and
 * only a re-delivery can land at or behind the watermark. The bootstrap-
 * boundary clause is deliberately absent — a median log inside that block is a
 * first delivery for the pool rows, which the feed bootstrap does not cover.
 * See ADR 0105. */
export function isEventAtOrBehindWatermark(
  state: OracleFeedState,
  event: FeedStateEvent,
): boolean {
  return eventPosition(state, event) <= 0;
}

/** True when the persisted row already reflects this event's position, so
 * re-applying it would double-count. Envio delivers each event at least once:
 * a batch that ends mid-block commits that block's entity writes with
 * `progress_block` set to the previous block, so the next start re-delivers
 * the whole block. The transitions below still throw — the handler layer
 * turns this case into a logged no-op. See ADR 0105. */
export function isEventAlreadyApplied(
  state: OracleFeedState,
  event: FeedStateEvent,
): boolean {
  return (
    isEventBehindWatermark(state, event) ||
    event.blockNumber <= state.bootstrapThroughBlock
  );
}

export function bootstrapOracleFeedState(args: {
  chainId: number;
  rateFeedID: string;
  reporters: readonly string[];
  timestamps: readonly bigint[];
  reportExpiry: bigint;
  bootstrapThroughBlock: bigint;
}): OracleFeedState {
  if (args.reportExpiry <= 0n) {
    throw new Error(
      `oracle feed bootstrap has invalid expiry=${args.reportExpiry}`,
    );
  }
  return rebuildFeedState(
    {
      id: oracleFeedStateId(args.chainId, args.rateFeedID),
      chainId: args.chainId,
      rateFeedID: asAddress(args.rateFeedID),
      reportExpiry: args.reportExpiry,
      bootstrapThroughBlock: args.bootstrapThroughBlock,
    },
    args.reporters,
    args.timestamps,
    {
      blockNumber: args.bootstrapThroughBlock,
      logIndex: -1,
      blockTimestamp: 0n,
    },
  );
}

export function applyOracleReport(
  state: OracleFeedState,
  reporterAddress: string,
  reportTimestamp: bigint,
  event: FeedStateEvent,
): OracleFeedState {
  const position = eventPosition(state, event);
  const reporter = asAddress(reporterAddress);
  if (position === 0) {
    const reporterIndex = state.activeReporters.indexOf(reporter);
    if (state.activeReportTimestamps[reporterIndex] === reportTimestamp) {
      return state;
    }
    throw new Error(
      `OracleReported conflicts at persisted event position reporter=${reporter}`,
    );
  }
  if (position < 0 || event.blockNumber <= state.bootstrapThroughBlock) {
    throw new Error(
      `OracleReported is out of order block=${event.blockNumber} logIndex=${event.logIndex}`,
    );
  }
  if (reportTimestamp <= 0n) {
    throw new Error(
      `OracleReported has non-positive timestamp=${reportTimestamp}`,
    );
  }

  const reports = new Map(
    state.activeReporters.map((reporter, index) => [
      reporter,
      state.activeReportTimestamps[index]!,
    ]),
  );
  reports.set(reporter, reportTimestamp);
  return rebuildFeedState(
    state,
    [...reports.keys()],
    [...reports.values()],
    event,
  );
}

export function applyOracleReportRemoval(
  state: OracleFeedState,
  reporterAddress: string,
  event: FeedStateEvent,
): OracleFeedState {
  const position = eventPosition(state, event);
  if (position === 0) return state;
  if (position < 0 || event.blockNumber <= state.bootstrapThroughBlock) {
    throw new Error(
      `OracleReportRemoved is out of order block=${event.blockNumber} logIndex=${event.logIndex}`,
    );
  }

  const reporter = asAddress(reporterAddress);
  const reports = new Map(
    state.activeReporters.map((address, index) => [
      address,
      state.activeReportTimestamps[index]!,
    ]),
  );
  if (!reports.delete(reporter)) {
    throw new Error(`OracleReportRemoved reporter missing=${reporter}`);
  }
  return rebuildFeedState(
    state,
    [...reports.keys()],
    [...reports.values()],
    event,
  );
}

export function applyOracleFeedExpiry(
  state: OracleFeedState,
  reportExpiry: bigint,
  event: FeedStateEvent,
): OracleFeedState {
  if (reportExpiry <= 0n) return state;
  const position = eventPosition(state, event);
  if (position === 0) {
    if (state.reportExpiry === reportExpiry) return state;
    throw new Error("oracle expiry conflicts at persisted event position");
  }
  if (position < 0) {
    throw new Error(
      `oracle expiry update is out of order block=${event.blockNumber} logIndex=${event.logIndex}`,
    );
  }
  return {
    ...state,
    reportExpiry,
    updatedAtBlock: event.blockNumber,
    updatedAtLogIndex: event.logIndex,
    updatedAtTimestamp: event.blockTimestamp,
  };
}
