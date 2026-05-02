"use client";

import { Tile } from "@/components/feedback";
import { BreakdownTile } from "@/components/breakdown-tile";
import { BridgeVolumeChart } from "@/components/bridge-volume-chart";
import { BridgeTopBridgersChart } from "@/components/bridge-top-bridgers-chart";
import { BridgeTokenBreakdownChart } from "@/components/bridge-token-breakdown-chart";
import type { OracleRateMap } from "@/lib/tokens";
import type {
  BridgeBridger,
  BridgeDailySnapshot,
  BridgeTransfer,
} from "@/lib/types";
import type { WindowTotals } from "@/lib/bridge-flows/snapshots";
import { RouteDeliveryTile } from "./route-delivery-tile";

export function BridgeOverviewSection({
  snapshots,
  rates,
  snapshotsIsLoading,
  snapshotsHasError,
  snapshotsCapped,
  topBridgers,
  topBridgersIsLoading,
  topBridgersHasError,
  transferTotals,
  pendingHasError,
  pendingCount,
  pendingCapped,
  deliveredTransfers,
  deliveredIsLoading,
  deliveredHasError,
}: {
  snapshots: BridgeDailySnapshot[];
  rates: OracleRateMap;
  snapshotsIsLoading: boolean;
  snapshotsHasError: boolean;
  snapshotsCapped: boolean;
  topBridgers: BridgeBridger[];
  topBridgersIsLoading: boolean;
  topBridgersHasError: boolean;
  transferTotals: WindowTotals;
  pendingHasError: boolean;
  pendingCount: number | null;
  pendingCapped: boolean;
  deliveredTransfers: ReadonlyArray<
    Pick<
      BridgeTransfer,
      | "status"
      | "sentTimestamp"
      | "deliveredTimestamp"
      | "sourceChainId"
      | "destChainId"
    >
  >;
  deliveredIsLoading: boolean;
  deliveredHasError: boolean;
}) {
  return (
    <>
      <section
        aria-label="Charts"
        className="grid grid-cols-1 lg:grid-cols-3 gap-6"
      >
        <BridgeVolumeChart
          snapshots={snapshots}
          rates={rates}
          isLoading={snapshotsIsLoading}
          hasError={snapshotsHasError}
          isCapped={snapshotsCapped}
        />
        <BridgeTokenBreakdownChart
          snapshots={snapshots}
          rates={rates}
          isLoading={snapshotsIsLoading}
          hasError={snapshotsHasError}
          isCapped={snapshotsCapped}
        />
        <BridgeTopBridgersChart
          bridgers={topBridgers}
          isLoading={topBridgersIsLoading}
          hasError={topBridgersHasError}
        />
      </section>

      <section
        aria-label="Key metrics"
        className="grid grid-cols-1 sm:grid-cols-3 gap-4"
      >
        <BreakdownTile
          label="Total Bridge Transfers"
          total={snapshotsHasError ? null : transferTotals.total}
          sub24h={transferTotals.sub24h}
          sub7d={transferTotals.sub7d}
          sub30d={transferTotals.sub30d}
          isLoading={snapshotsIsLoading}
          hasError={snapshotsHasError}
          format={(n: number) => n.toLocaleString()}
          subtitle={snapshotsCapped ? "Partial — snapshot cap hit" : undefined}
        />
        <Tile
          label="In-Flight"
          value={
            pendingHasError
              ? "—"
              : pendingCount === null
                ? "…"
                : pendingCapped
                  ? "1,000+"
                  : pendingCount.toLocaleString()
          }
          subtitle={
            !pendingHasError && pendingCount !== null && pendingCount > 0
              ? "Sent, attested, or queued — not yet delivered"
              : undefined
          }
        />
        <RouteDeliveryTile
          transfers={deliveredTransfers}
          isLoading={deliveredIsLoading}
          hasError={deliveredHasError}
        />
      </section>
    </>
  );
}
