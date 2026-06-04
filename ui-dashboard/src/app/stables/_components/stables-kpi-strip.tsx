"use client";

import { useMemo } from "react";
import { BreakdownTile } from "@/components/breakdown-tile";
import { formatUSD, parseWei } from "@/lib/format";
import { displayLabel, effectiveOracleRate } from "@/lib/stables";
import type { OracleRateMap } from "@/lib/tokens";
import {
  groupCustodySnapshotsByToken,
  latestDailyCirculatingSupply,
  rollupByToken,
  unionCustodySnapshotsWithLatest,
  winnersAndLosers7d,
} from "../_lib/aggregate";
import type {
  StableSupplyDailySnapshot,
  StableTokenCustodyDailySnapshot,
  TokenAgg,
} from "../_lib/types";

// `formatUSD` thresholds (>= 999_950, >= 1_000) miss negative inputs and
// fall through to `$-5000000.00` instead of `-$5M`. Strip the sign first
// then prepend it manually so the K/M/B suffix logic fires correctly for
// supply contractions on the 7d-change + biggest-contraction tiles.
function formatSignedUSD(v: number): string {
  return `${v >= 0 ? "+" : "-"}${formatUSD(Math.abs(v))}`;
}

type Props = {
  // Per-token latest rows (one per token via distinct_on). Sufficient for
  // the "Circulating supply" headline; the winners/losers tiles need the
  // wider snapshot stream for the 7d baseline comparison.
  latestPerToken: ReadonlyArray<StableSupplyDailySnapshot>;
  latestCustodyPerToken: ReadonlyArray<StableTokenCustodyDailySnapshot>;
  // Daily-snapshot stream from useStablesDailySnapshots — feeds the 7d
  // change calculation. Empty array is acceptable (tiles render N/A).
  snapshots: ReadonlyArray<StableSupplyDailySnapshot>;
  custodySnapshots: ReadonlyArray<StableTokenCustodyDailySnapshot>;
  rates: OracleRateMap;
  isLoading: boolean;
  hasError: boolean;
};

export function StablesKpiStrip({
  latestPerToken,
  latestCustodyPerToken,
  snapshots,
  custodySnapshots,
  rates,
  isLoading,
  hasError,
}: Props): React.JSX.Element {
  // Memoize the rollup + derived totals. SWR polls at 30s; parent re-renders
  // (range pill, hover state) shouldn't re-sort N=1000 snapshots each time.
  const { rollup, biggestExpansion, biggestContraction } = useMemo(() => {
    const mergedCustody = unionCustodySnapshotsWithLatest(
      custodySnapshots,
      latestCustodyPerToken,
    );
    const r = rollupByToken(snapshots, rates, undefined, mergedCustody);
    const wl = winnersAndLosers7d(r);
    return {
      rollup: r,
      biggestExpansion: wl.biggestExpansion,
      biggestContraction: wl.biggestContraction,
    };
  }, [snapshots, custodySnapshots, latestCustodyPerToken, rates]);

  const totalUsd = useMemo<number | null>(() => {
    const mergedCustody = unionCustodySnapshotsWithLatest(
      custodySnapshots,
      latestCustodyPerToken,
    );
    const custodyByToken = groupCustodySnapshotsByToken(mergedCustody);
    return latestPerToken.reduce<number | null>((acc, row) => {
      // `effectiveOracleRate` defaults USD-pegged stables (USDm, cUSD,
      // ...) to 1.0 when the oracle map doesn't carry an entry —
      // without this fallback, USDm (the largest stable) silently
      // drops out of the headline total since useOracleRates derives
      // rates against USDm pairs and never emits one for USDm itself.
      const rate = effectiveOracleRate(rates, row.tokenSymbol, row.chainId);
      if (rate == null) return acc;
      const custodyRows =
        custodyByToken.get(`${row.chainId}|${row.tokenAddress}`) ?? [];
      const circulating = latestDailyCirculatingSupply(row, custodyRows);
      const usd = parseWei(circulating.toString(), row.tokenDecimals) * rate;
      return (acc ?? 0) + usd;
    }, null);
  }, [latestPerToken, custodySnapshots, latestCustodyPerToken, rates]);

  const totalNetChange7dUsd = useMemo<number | null>(() => {
    return Array.from(rollup.values()).reduce<number | null>(
      (acc, agg) =>
        agg.netChange7dUsd == null ? acc : (acc ?? 0) + agg.netChange7dUsd,
      null,
    );
  }, [rollup]);

  return (
    <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <BreakdownTile
        label="Circulating supply"
        total={totalUsd}
        sub24h={null}
        sub7d={null}
        sub30d={null}
        isLoading={isLoading}
        hasError={hasError}
        format={(v) => formatUSD(v)}
      />
      <BreakdownTile
        label="7d net change"
        total={totalNetChange7dUsd}
        sub24h={null}
        sub7d={null}
        sub30d={null}
        isLoading={isLoading}
        hasError={hasError}
        format={formatSignedUSD}
      />
      <MoverTile
        label="Biggest expansion (7d)"
        agg={biggestExpansion}
        isLoading={isLoading}
        hasError={hasError}
      />
      <MoverTile
        label="Biggest contraction (7d)"
        agg={biggestContraction}
        isLoading={isLoading}
        hasError={hasError}
      />
    </section>
  );
}

function MoverTile({
  label,
  agg,
  isLoading,
  hasError,
}: {
  label: string;
  agg: TokenAgg | null;
  isLoading: boolean;
  hasError: boolean;
}): React.JSX.Element {
  const subtitle = agg
    ? `${displayLabel(agg.tokenSymbol, agg.source)} on ${chainLabel(agg.chainId)}`
    : undefined;
  return (
    <BreakdownTile
      label={label}
      total={agg?.netChange7dUsd ?? null}
      sub24h={null}
      sub7d={null}
      sub30d={null}
      isLoading={isLoading}
      hasError={hasError}
      format={formatSignedUSD}
      subtitle={subtitle}
    />
  );
}

function chainLabel(chainId: number): string {
  if (chainId === 143) return "Monad";
  if (chainId === 42220) return "Celo";
  return `Chain ${chainId}`;
}
