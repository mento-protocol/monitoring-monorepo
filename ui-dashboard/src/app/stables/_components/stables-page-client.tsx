"use client";

import { Suspense, useState } from "react";
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

// Whether the daily-snapshots truncation-cap outcome (`chartCapped` above)
// is still unresolved. Kept as a standalone function so its two boolean
// operators don't count against `StablesContent`'s own complexity budget.
function isSnapshotCapOutcomeLoading(
  snapshotsLoading: boolean,
  custodySnapshotsLoading: boolean,
  custodySnapshotsUnavailable: boolean,
): boolean {
  return (
    snapshotsLoading ||
    (!custodySnapshotsUnavailable && custodySnapshotsLoading)
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
  // Whether `chartCapped` (fed into the changes card as `snapshotLimitCapped`)
  // still might change — mirrors chartCapped's own guard so the two flip
  // together. Passed down so the changes card's settle latch can hold its
  // reveal until this resolves too (see StablesChangesSection below): the
  // card's header folds the truncation notice into its own height (issue
  // #1239), so if real rows revealed before this was known, a late cap
  // resolution would grow the header and shove the already-visible rows down
  // — the exact displacement #1239 exists to eliminate, just moved inside the
  // card (Codex review on #1256). Extracted to its own function (rather than
  // inlined like `chartCapped` above) to keep `StablesContent`'s own
  // cyclomatic complexity under the lint ceiling.
  const snapshotLimitCappedLoading = isSnapshotCapOutcomeLoading(
    snapshotsLoading,
    custodySnapshotsLoading,
    custodySnapshotsUnavailable,
  );
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

      <StablesChangesSection
        rates={rates}
        ratesLoading={ratesLoading}
        snapshotLimitCapped={chartCapped}
        snapshotLimitCappedLoading={snapshotLimitCappedLoading}
      />
    </div>
  );
}

function StablesChangesSection({
  rates,
  ratesLoading,
  snapshotLimitCapped,
  snapshotLimitCappedLoading,
}: {
  rates: OracleRateMap;
  ratesLoading: boolean;
  snapshotLimitCapped: boolean;
  snapshotLimitCappedLoading: boolean;
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
    hasPendingPage: changesHasPendingPage,
  } = useStablesChanges("7d", 0, rates, minimumSupplyChangeUsd);

  // Gate the follow-up-page skeleton to the INITIAL load only. On first load
  // we hold the skeleton until every raw page AND the oracle rates have
  // settled so the table reveals its full row set once, instead of showing a
  // partial set and growing again as later pages resolve (measured on
  // production as 3 discrete height jumps). Rates gate the visibility
  // predicate: `isVisibleSupplyChangeEvent` fail-opens non-USD rows while
  // `rates` is empty, so a changes page that resolves before rates would
  // otherwise report zero pending pages, latch too early, then grow in waves
  // once rates arrive and re-enable page 2/3 for the USD threshold. Waiting on
  // `ratesLoading` keeps the reveal single. Once settled, an interactive "Min
  // value" raise re-enables a 2nd/3rd page (`shouldFetchNextChangePage` in
  // use-stables-data.ts) with page-1 data unchanged — re-summoning the
  // skeleton there would drop already-visible rows and flash blank. Latch
  // "settled once" (React's render-phase state update, not an effect) and stop
  // gating on `hasPendingPage`/`ratesLoading` after it.
  //
  // Also gates on `snapshotLimitCappedLoading`: this card folds the daily
  // snapshots' truncation notice into its own header (issue #1239), so the
  // header's height depends on a query this section doesn't otherwise wait
  // on. Without this, real rows could reveal before that query resolves, and
  // a later cap-outcome flip would grow the header and shove the
  // already-visible rows down inside the card — the same displacement
  // #1239 eliminated at the page level, just reintroduced inside the card
  // (Codex review on #1256). Holding the reveal until the cap outcome is
  // known guarantees the header is already in its final shape by the time
  // rows first appear, so revealing rows never coincides with a header size
  // change.
  const [hasSettledOnce, setHasSettledOnce] = useState(false);
  if (
    !hasSettledOnce &&
    !changesLoading &&
    !changesHasPendingPage &&
    !ratesLoading &&
    !snapshotLimitCappedLoading
  ) {
    setHasSettledOnce(true);
  }
  const showChangesSkeleton =
    changesLoading ||
    (!hasSettledOnce &&
      (changesHasPendingPage || ratesLoading || snapshotLimitCappedLoading));

  return (
    <StablesChangesTable
      events={changeEvents}
      minimumUsdValue={minimumSupplyChangeUsd}
      onMinimumUsdValueChange={updateMinimumSupplyChangeUsd}
      onMinimumUsdValueReset={resetMinimumSupplyChangeUsd}
      isLoading={showChangesSkeleton}
      hasError={changesError != null}
      hasSettled={hasSettledOnce}
      capped={changesCapped}
      unpricedEventsCount={changesUnpricedEventsCount}
      snapshotLimitCapped={snapshotLimitCapped}
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
