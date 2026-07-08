"use client";

import { Suspense } from "react";
import { useOracleRates } from "@/hooks/use-oracle-rates";
import type { OracleRateMap } from "@/lib/tokens";
import { useStablesRangeUrlState } from "../_lib/use-stables-range-url-state";
import {
  useStablesCustodyDailySnapshots,
  useStablesDailySnapshots,
  useStablesLatestCustodyPerToken,
  useStablesLatestPerToken,
  useStablesChanges,
} from "../_lib/use-stables-data";
import { useSupplyChangeThreshold } from "../_lib/use-supply-change-threshold";
import { StablesChangesTable } from "./stables-changes-table";
import { StablesHeroChart } from "./stables-hero-chart";
import { StablesKpiStrip } from "./stables-kpi-strip";
import { StablesSparklineGrid } from "./stables-sparkline-grid";

export function StablesPageClient(): React.JSX.Element {
  return (
    <Suspense>
      <StablesContent />
    </Suspense>
  );
}

function StablesContent(): React.JSX.Element {
  const { range, updateRange } = useStablesRangeUrlState();

  const { merged: rates, isLoading: ratesLoading } = useOracleRates();
  const {
    snapshots: latestPerToken,
    error: latestError,
    isLoading: latestLoading,
  } = useStablesLatestPerToken();
  const {
    snapshots,
    error: snapshotsError,
    isLoading: snapshotsLoading,
    capped: snapshotsCapped,
  } = useStablesDailySnapshots(range);
  const {
    snapshots: latestCustodyPerToken,
    error: latestCustodyError,
    isLoading: latestCustodyLoading,
  } = useStablesLatestCustodyPerToken();
  const {
    snapshots: custodySnapshots,
    error: custodySnapshotsError,
    isLoading: custodySnapshotsLoading,
    capped: custodySnapshotsCapped,
  } = useStablesCustodyDailySnapshots(range);
  const latestCustodyUnavailable =
    latestCustodyError != null && latestCustodyPerToken.length === 0;
  const custodySnapshotsUnavailable =
    custodySnapshotsError != null && custodySnapshots.length === 0;
  const effectiveLatestCustodyPerToken = latestCustodyUnavailable
    ? []
    : latestCustodyPerToken;
  const effectiveCustodySnapshots = custodySnapshotsUnavailable
    ? []
    : custodySnapshots;
  const chartCapped =
    snapshotsCapped || (!custodySnapshotsUnavailable && custodySnapshotsCapped);
  const isLoading =
    ratesLoading ||
    latestLoading ||
    snapshotsLoading ||
    (!latestCustodyUnavailable && latestCustodyLoading) ||
    (!custodySnapshotsUnavailable && custodySnapshotsLoading);
  const hasError = latestError != null || snapshotsError != null;

  return (
    <div className="space-y-8">
      <StablesHeader />

      <StablesKpiStrip
        latestPerToken={latestPerToken}
        latestCustodyPerToken={effectiveLatestCustodyPerToken}
        snapshots={snapshots}
        custodySnapshots={effectiveCustodySnapshots}
        rates={rates}
        isLoading={isLoading}
        hasError={hasError}
      />

      <StablesHeroChart
        snapshots={snapshots}
        latestPerToken={latestPerToken}
        custodySnapshots={effectiveCustodySnapshots}
        latestCustodyPerToken={effectiveLatestCustodyPerToken}
        rates={rates}
        range={range}
        onRangeChange={updateRange}
        isLoading={isLoading}
        hasError={hasError}
      />

      <StablesSparklineGrid
        snapshots={snapshots}
        latestPerToken={latestPerToken}
        custodySnapshots={effectiveCustodySnapshots}
        latestCustodyPerToken={effectiveLatestCustodyPerToken}
        rates={rates}
        isLoading={isLoading}
        hasError={hasError}
      />

      <StablesSnapshotLimitNotice visible={chartCapped} />

      <StablesChangesSection rates={rates} />
    </div>
  );
}

function StablesSnapshotLimitNotice({
  visible,
}: {
  visible: boolean;
}): React.JSX.Element | null {
  if (!visible) return null;
  return (
    <p className="text-xs text-amber-400" role="status">
      Showing the most recent 1,000 snapshot rows — older history may be
      truncated. Use the 1W or 1M range for a complete view.
    </p>
  );
}

function StablesChangesSection({
  rates,
}: {
  rates: OracleRateMap;
}): React.JSX.Element {
  const {
    minimumUsdValue: minimumSupplyChangeUsd,
    updateMinimumUsdValue: updateMinimumSupplyChangeUsd,
    resetMinimumUsdValue: resetMinimumSupplyChangeUsd,
  } = useSupplyChangeThreshold();
  const {
    events: changeEvents,
    error: changesError,
    isLoading: changesLoading,
    capped: changesCapped,
    unpricedEventsCount: changesUnpricedEventsCount,
  } = useStablesChanges("7d", 0, rates, minimumSupplyChangeUsd);

  return (
    <StablesChangesTable
      events={changeEvents}
      minimumUsdValue={minimumSupplyChangeUsd}
      onMinimumUsdValueChange={updateMinimumSupplyChangeUsd}
      onMinimumUsdValueReset={resetMinimumSupplyChangeUsd}
      isLoading={changesLoading}
      hasError={changesError != null}
      capped={changesCapped}
      unpricedEventsCount={changesUnpricedEventsCount}
    />
  );
}

function StablesHeader(): React.JSX.Element {
  return (
    <header>
      <h1 className="text-3xl font-semibold text-slate-100">
        Mento stablecoins
      </h1>
      <p className="mt-1 text-sm text-slate-400">
        Circulating supply of Mento-issued stablecoins across Celo and Monad,
        excluding Celo NTT lock custody from global totals.
      </p>
    </header>
  );
}
