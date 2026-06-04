"use client";

import { useMemo } from "react";
import { BreakdownTile } from "@/components/breakdown-tile";
import { ChainIcon } from "@/components/chain-icon";
import { formatUSD, parseWei } from "@/lib/format";
import { networkForChainId } from "@/lib/networks";
import { displayLabel, effectiveOracleRate } from "@/lib/stables";
import type { OracleRateMap } from "@/lib/tokens";
import {
  custodySnapshotsAlignedToSupplyRows,
  groupCustodySnapshotsByToken,
  custodyTokenKey,
  latestDailyCirculatingSupply,
  rollupByToken,
  unionSnapshotsWithLatest,
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

// Sum a per-window USD net change across the rollup, skipping tokens with no
// oracle rate (null). Returns null only when no token contributes — mirrors
// `totalNetChange7dUsd` so the sub-row renders "N/A" on rate-less data.
function sumWindowUsd(
  rollup: ReadonlyMap<string, TokenAgg>,
  pick: (agg: TokenAgg) => number | null,
): number | null {
  return Array.from(rollup.values()).reduce<number | null>((acc, agg) => {
    const v = pick(agg);
    return v == null ? acc : (acc ?? 0) + v;
  }, null);
}

type Props = {
  // Per-token current rows. Transfer-tracked tokens come from current
  // StableTokenSupply state; Celo CDP rows fall back to latest daily snapshots.
  // Sufficient for the "Circulating supply" headline; the winners/losers tiles
  // need the wider snapshot stream for the 7d baseline comparison.
  latestPerToken: ReadonlyArray<StableSupplyDailySnapshot>;
  latestCustodyPerToken: ReadonlyArray<StableTokenCustodyDailySnapshot>;
  // Daily-snapshot stream from useStablesDailySnapshots — feeds the 7d
  // change calculation. Merged with latestPerToken so KPI deltas use the
  // current state even when sparse daily snapshots have not rolled over.
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
    const mergedSnapshots = unionSnapshotsWithLatest(snapshots, latestPerToken);
    const mergedCustody = custodySnapshotsAlignedToSupplyRows(
      mergedSnapshots,
      custodySnapshots,
      latestCustodyPerToken,
    );
    const r = rollupByToken(mergedSnapshots, rates, undefined, mergedCustody);
    const wl = winnersAndLosers7d(r);
    return {
      rollup: r,
      biggestExpansion: wl.biggestExpansion,
      biggestContraction: wl.biggestContraction,
    };
  }, [
    snapshots,
    latestPerToken,
    custodySnapshots,
    latestCustodyPerToken,
    rates,
  ]);

  const totalUsd = useMemo<number | null>(() => {
    const mergedCustody = custodySnapshotsAlignedToSupplyRows(
      latestPerToken,
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
        custodyByToken.get(custodyTokenKey(row.chainId, row.tokenAddress)) ??
        [];
      const circulating = latestDailyCirculatingSupply(row, custodyRows);
      const usd = parseWei(circulating.toString(), row.tokenDecimals) * rate;
      return (acc ?? 0) + usd;
    }, null);
  }, [latestPerToken, custodySnapshots, latestCustodyPerToken, rates]);

  // Per-window total net change (USD) feeding the KPI sub-rows. Both the
  // "Circulating supply" and "7d net change" tiles show absolute $ deltas, so
  // their sub-rows are identical by design (the 7d slot repeats tile 2's
  // headline).
  const windows = useMemo(() => {
    return {
      net1dUsd: sumWindowUsd(rollup, (a) => a.netChange1dUsd),
      net7dUsd: sumWindowUsd(rollup, (a) => a.netChange7dUsd),
      net30dUsd: sumWindowUsd(rollup, (a) => a.netChange30dUsd),
    };
  }, [rollup]);

  const totalNetChange7dUsd = windows.net7dUsd;

  return (
    <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <BreakdownTile
        label="Circulating supply"
        total={totalUsd}
        sub24h={windows.net1dUsd}
        sub7d={windows.net7dUsd}
        sub30d={windows.net30dUsd}
        isLoading={isLoading}
        hasError={hasError}
        format={(v) => formatUSD(v)}
        subFormat={formatSignedUSD}
      />
      <BreakdownTile
        label="7d net change"
        total={totalNetChange7dUsd}
        sub24h={windows.net1dUsd}
        sub7d={windows.net7dUsd}
        sub30d={windows.net30dUsd}
        isLoading={isLoading}
        hasError={hasError}
        format={formatSignedUSD}
      />
      <MoverTile
        label="Biggest expansion"
        agg={biggestExpansion}
        isLoading={isLoading}
        hasError={hasError}
      />
      <MoverTile
        label="Biggest contraction"
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
  return (
    <BreakdownTile
      label={label}
      total={agg?.netChange7dUsd ?? null}
      sub24h={agg?.netChange1dUsd ?? null}
      sub7d={agg?.netChange7dUsd ?? null}
      sub30d={agg?.netChange30dUsd ?? null}
      isLoading={isLoading}
      hasError={hasError}
      format={formatSignedUSD}
      badge={agg ? <MoverBadge agg={agg} /> : undefined}
    />
  );
}

// Token + chain identity for a mover tile, rendered as a pill on the title row.
// The chain is conveyed by the branded icon (its `aria-label` names the chain),
// so the pill stays compact without an explicit "on Celo" suffix.
function MoverBadge({ agg }: { agg: TokenAgg }): React.JSX.Element {
  const network = networkForChainId(agg.chainId);
  return (
    <span className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-full border border-slate-700 bg-slate-800/80 px-2 py-0.5 text-xs">
      {network ? <ChainIcon network={network} size={14} /> : null}
      <span className="font-medium text-slate-200">
        {displayLabel(agg.tokenSymbol, agg.source)}
      </span>
    </span>
  );
}
