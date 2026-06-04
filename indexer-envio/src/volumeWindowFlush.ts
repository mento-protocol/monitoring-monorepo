// Heartbeat-driven flush of VolumeWindowSnapshot /
// BrokerVolumeWindowSnapshot rows. The first swap of a new UTC day
// flushes all closed days since the last finalized one for all four
// windowKeys. Today's row is intentionally never written by the indexer —
// the dashboard adds today's partial from a small TraderDailySnapshot
// query (see ui-dashboard/src/lib/queries/volume.ts).
//
// Cost: one chainId getWhere per UTC-day rollover per chain (not per
// event), reused across all 4 in-memory window aggregations. Roughly
// O(active_traders × days_indexed) memory at flush time, ~21k rows /
// 100ms wall on Celo's "all" window — within Envio's per-event handler
// budget.

import type {
  BrokerVolumeWindowSnapshot,
  BrokerTraderDailySnapshot,
  VolumeChainState,
  VolumeWindowSnapshot,
  TraderDailySnapshot,
} from "envio";
import { SECONDS_PER_DAY, dayBucket } from "./helpers.js";
import {
  WINDOW_KEYS,
  aggregatePerWindow,
  buildVolumeWindowSnapshot,
  windowStartDay,
} from "./volumeWindowSnapshot.js";

// ────────────────────────────────────────────────────────────────────
// v3 — TraderDailySnapshot → VolumeWindowSnapshot
// ────────────────────────────────────────────────────────────────────

export type V3FlushContext = {
  TraderDailySnapshot: {
    getWhere: (query: {
      chainId: { _eq: number };
    }) => Promise<TraderDailySnapshot[]>;
  };
  VolumeChainState: {
    get: (id: string) => Promise<VolumeChainState | undefined>;
    set: (entity: VolumeChainState) => void;
  };
  VolumeWindowSnapshot: {
    set: (entity: VolumeWindowSnapshot) => void;
  };
};

/** Flush all 4 window snapshots for a single (chainId, snapshotDay).
 *  Idempotent: re-running with the same args overwrites with identical rows. */
export async function flushV3VolumeWindowSnapshots(args: {
  context: V3FlushContext;
  chainId: number;
  snapshotDay: bigint;
  blockNumber: bigint;
  updatedAtTimestamp: bigint;
}): Promise<void> {
  const rows = await args.context.TraderDailySnapshot.getWhere({
    chainId: { _eq: args.chainId },
  });
  const grouped = aggregatePerWindow(rows, args.chainId, args.snapshotDay);
  for (const w of WINDOW_KEYS) {
    const snap = buildVolumeWindowSnapshot({
      chainId: args.chainId,
      windowKey: w,
      snapshotDay: args.snapshotDay,
      windowStartDay: windowStartDay(args.snapshotDay, w),
      aggregates: grouped[w],
      blockNumber: args.blockNumber,
      updatedAtTimestamp: args.updatedAtTimestamp,
    });
    args.context.VolumeWindowSnapshot.set(snap);
  }
}

/** Heartbeat trigger: invoked at the end of each v3 swap handler. If
 *  the current event's UTC day exceeds the last finalized day, flush
 *  every closed day in between (typically just one — the day that
 *  ended overnight). */
export async function maybeHeartbeatFlushV3(args: {
  context: V3FlushContext;
  chainId: number;
  blockTimestamp: bigint;
  blockNumber: bigint;
}): Promise<void> {
  const today = dayBucket(args.blockTimestamp);
  const stateId = `${args.chainId}`;
  const existing = await args.context.VolumeChainState.get(stateId);
  const lastFlushedDay = existing?.lastFlushedDay ?? 0n;
  const lastClosedDay = today - SECONDS_PER_DAY;
  if (lastFlushedDay >= lastClosedDay) return;

  // First-ever flush for this chain: flush only the most recent closed day
  // (avoids replaying every day from epoch on a re-sync's first event).
  const startDay =
    lastFlushedDay === 0n ? lastClosedDay : lastFlushedDay + SECONDS_PER_DAY;
  for (let d = startDay; d <= lastClosedDay; d += SECONDS_PER_DAY) {
    await flushV3VolumeWindowSnapshots({
      context: args.context,
      chainId: args.chainId,
      snapshotDay: d,
      blockNumber: args.blockNumber,
      updatedAtTimestamp: args.blockTimestamp,
    });
  }

  args.context.VolumeChainState.set({
    id: stateId,
    chainId: args.chainId,
    lastFlushedDay: lastClosedDay,
    lastFlushedDayBroker: existing?.lastFlushedDayBroker ?? 0n,
    updatedAtTimestamp: args.blockTimestamp,
  });
}

// ────────────────────────────────────────────────────────────────────
// v2 — BrokerTraderDailySnapshot → BrokerVolumeWindowSnapshot
// ────────────────────────────────────────────────────────────────────

export type V2FlushContext = {
  BrokerTraderDailySnapshot: {
    getWhere: (query: {
      chainId: { _eq: number };
    }) => Promise<BrokerTraderDailySnapshot[]>;
  };
  VolumeChainState: {
    get: (id: string) => Promise<VolumeChainState | undefined>;
    set: (entity: VolumeChainState) => void;
  };
  BrokerVolumeWindowSnapshot: {
    set: (entity: BrokerVolumeWindowSnapshot) => void;
  };
};

export async function flushV2VolumeWindowSnapshots(args: {
  context: V2FlushContext;
  chainId: number;
  snapshotDay: bigint;
  blockNumber: bigint;
  updatedAtTimestamp: bigint;
}): Promise<void> {
  const rows = await args.context.BrokerTraderDailySnapshot.getWhere({
    chainId: { _eq: args.chainId },
  });
  // BrokerTraderDailySnapshot keys by `caller` (tx.from / signer EOA), but
  // the shared `aggregatePerWindow` helper expects a `trader` field on each
  // row (named for v3's TraderDailySnapshot). Map `caller → trader` here so
  // both venues feed identically structured rows into the aggregator.
  const sharedRows = rows.map((r) => ({
    chainId: r.chainId,
    trader: r.caller,
    timestamp: r.timestamp,
    volumeUsdWei: r.volumeUsdWei,
    swapCount: r.swapCount,
    isSystemAddress: r.isSystemAddress,
  }));
  const grouped = aggregatePerWindow(
    sharedRows,
    args.chainId,
    args.snapshotDay,
  );
  for (const w of WINDOW_KEYS) {
    // BrokerVolumeWindowSnapshot is structurally identical to
    // VolumeWindowSnapshot — see schema.graphql.
    const snap: BrokerVolumeWindowSnapshot = buildVolumeWindowSnapshot({
      chainId: args.chainId,
      windowKey: w,
      snapshotDay: args.snapshotDay,
      windowStartDay: windowStartDay(args.snapshotDay, w),
      aggregates: grouped[w],
      blockNumber: args.blockNumber,
      updatedAtTimestamp: args.updatedAtTimestamp,
    });
    args.context.BrokerVolumeWindowSnapshot.set(snap);
  }
}

export async function maybeHeartbeatFlushV2(args: {
  context: V2FlushContext;
  chainId: number;
  blockTimestamp: bigint;
  blockNumber: bigint;
}): Promise<void> {
  const today = dayBucket(args.blockTimestamp);
  const stateId = `${args.chainId}`;
  const existing = await args.context.VolumeChainState.get(stateId);
  const lastFlushedDayBroker = existing?.lastFlushedDayBroker ?? 0n;
  const lastClosedDay = today - SECONDS_PER_DAY;
  if (lastFlushedDayBroker >= lastClosedDay) return;

  const startDay =
    lastFlushedDayBroker === 0n
      ? lastClosedDay
      : lastFlushedDayBroker + SECONDS_PER_DAY;
  for (let d = startDay; d <= lastClosedDay; d += SECONDS_PER_DAY) {
    await flushV2VolumeWindowSnapshots({
      context: args.context,
      chainId: args.chainId,
      snapshotDay: d,
      blockNumber: args.blockNumber,
      updatedAtTimestamp: args.blockTimestamp,
    });
  }

  args.context.VolumeChainState.set({
    id: stateId,
    chainId: args.chainId,
    lastFlushedDay: existing?.lastFlushedDay ?? 0n,
    lastFlushedDayBroker: lastClosedDay,
    updatedAtTimestamp: args.blockTimestamp,
  });
}
