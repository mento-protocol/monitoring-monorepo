"use client";

import { BreakdownTile } from "@/components/breakdown-tile";
import { formatUSD, parseWei } from "@/lib/format";
import { displayLabel } from "@/lib/stables";
import type { OracleRateMap } from "@/lib/tokens";
import { rollupByToken, winnersAndLosers7d } from "../_lib/aggregate";
import type { StableSupplyDailySnapshot, TokenAgg } from "../_lib/types";

type Props = {
  // Per-token latest rows (one per token via distinct_on). Sufficient for
  // the "Total outstanding" headline; the winners/losers tiles need the
  // wider snapshot stream for the 7d baseline comparison.
  latestPerToken: ReadonlyArray<StableSupplyDailySnapshot>;
  // Daily-snapshot stream from useStablesDailySnapshots — feeds the 7d
  // change calculation. Empty array is acceptable (tiles render N/A).
  snapshots: ReadonlyArray<StableSupplyDailySnapshot>;
  rates: OracleRateMap;
  isLoading: boolean;
  hasError: boolean;
};

export function StablesKpiStrip({
  latestPerToken,
  snapshots,
  rates,
  isLoading,
  hasError,
}: Props): React.JSX.Element {
  const rollup = rollupByToken(snapshots, rates);
  const { biggestExpansion, biggestContraction } = winnersAndLosers7d(rollup);

  const totalUsd = latestPerToken.reduce<number | null>((acc, row) => {
    const rate = rates.get(row.tokenSymbol);
    if (rate == null) return acc;
    const usd =
      parseWei(BigInt(row.totalSupply).toString(), row.tokenDecimals) * rate;
    return (acc ?? 0) + usd;
  }, null);

  const totalNetChange7dUsd = Array.from(rollup.values()).reduce<number | null>(
    (acc, agg) =>
      agg.netChange7dUsd == null ? acc : (acc ?? 0) + agg.netChange7dUsd,
    null,
  );

  return (
    <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <BreakdownTile
        label="Total outstanding"
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
        format={(v) => `${v >= 0 ? "+" : ""}${formatUSD(v)}`}
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
  const subtitle = agg ? displayLabel(agg.tokenSymbol, agg.source) : undefined;
  return (
    <BreakdownTile
      label={label}
      total={agg?.netChange7dUsd ?? null}
      sub24h={null}
      sub7d={null}
      sub30d={null}
      isLoading={isLoading}
      hasError={hasError}
      format={(v) => `${v >= 0 ? "+" : ""}${formatUSD(v)}`}
      subtitle={subtitle}
    />
  );
}
