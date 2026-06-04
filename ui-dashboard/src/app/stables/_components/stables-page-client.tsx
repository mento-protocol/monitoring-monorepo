"use client";

import { Suspense, useState } from "react";
import { useOracleRates } from "@/hooks/use-oracle-rates";
import type { RangeKey } from "../_lib/types";
import {
  useStablesCustodyDailySnapshots,
  useStablesDailySnapshots,
  useStablesLatestCustodyPerToken,
  useStablesLatestPerToken,
  useStablesChanges,
} from "../_lib/use-stables-data";
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
  const [range, setRange] = useState<RangeKey>("30d");

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
  const {
    events: changeEvents,
    error: changesError,
    isLoading: changesLoading,
    capped: changesCapped,
  } = useStablesChanges("7d");

  const isLoading =
    ratesLoading ||
    latestLoading ||
    snapshotsLoading ||
    latestCustodyLoading ||
    custodySnapshotsLoading;
  const hasError =
    latestError != null ||
    snapshotsError != null ||
    latestCustodyError != null ||
    custodySnapshotsError != null;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-semibold text-slate-100">
          Mento stablecoins
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Circulating supply of Mento-issued stablecoins across Celo and Monad,
          excluding Celo NTT lock custody from global totals.
        </p>
      </header>

      <StablesKpiStrip
        latestPerToken={latestPerToken}
        latestCustodyPerToken={latestCustodyPerToken}
        snapshots={snapshots}
        custodySnapshots={custodySnapshots}
        rates={rates}
        isLoading={isLoading}
        hasError={hasError}
      />

      <StablesSparklineGrid
        snapshots={snapshots}
        latestPerToken={latestPerToken}
        custodySnapshots={custodySnapshots}
        latestCustodyPerToken={latestCustodyPerToken}
        rates={rates}
        isLoading={isLoading}
        hasError={hasError}
      />

      <StablesHeroChart
        snapshots={snapshots}
        latestPerToken={latestPerToken}
        custodySnapshots={custodySnapshots}
        latestCustodyPerToken={latestCustodyPerToken}
        rates={rates}
        range={range}
        onRangeChange={setRange}
        isLoading={isLoading}
        hasError={hasError}
        capped={snapshotsCapped || custodySnapshotsCapped}
      />

      <StablesChangesTable
        events={changeEvents}
        isLoading={changesLoading}
        hasError={changesError != null}
        capped={changesCapped}
      />
    </div>
  );
}
