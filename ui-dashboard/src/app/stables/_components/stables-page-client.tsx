"use client";

import { Suspense, useState } from "react";
import { useOracleRates } from "@/hooks/use-oracle-rates";
import type { RangeKey } from "../_lib/types";
import {
  useStablesDailySnapshots,
  useStablesLatestPerToken,
  useStablesV2Changes,
} from "../_lib/use-stables-data";
import { StablesChangesTable } from "./stables-changes-table";
import { StablesHeroChart } from "./stables-hero-chart";
import { StablesKpiStrip } from "./stables-kpi-strip";

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
    events: changeEvents,
    error: changesError,
    isLoading: changesLoading,
    capped: changesCapped,
  } = useStablesV2Changes("7d");

  const isLoading = ratesLoading || latestLoading || snapshotsLoading;
  const hasError = latestError != null || snapshotsError != null;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-semibold text-slate-100">
          Mento stablecoins
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Outstanding supply of Mento-issued stablecoins (USDm, EURm, GBPm,
          BRLm, …) tracked across V2 Reserve mints/burns, V3 hub USDm bridge
          flows, and V3 Liquity CDP debt.
        </p>
      </header>

      <StablesKpiStrip
        latestPerToken={latestPerToken}
        snapshots={snapshots}
        rates={rates}
        isLoading={isLoading}
        hasError={hasError}
      />

      <StablesHeroChart
        snapshots={snapshots}
        latestPerToken={latestPerToken}
        rates={rates}
        range={range}
        onRangeChange={setRange}
        isLoading={isLoading}
        hasError={hasError}
        capped={snapshotsCapped}
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
