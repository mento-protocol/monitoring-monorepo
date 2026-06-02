"use client";

import dynamic from "next/dynamic";
import type { Pool, PoolSnapshot } from "@/lib/types";
import { parseWei } from "@/lib/format";
import type { Network } from "@/lib/networks";
import { forwardFillSeries } from "@/lib/chart-gap-fill";
import {
  PLOTLY_BASE_LAYOUT,
  PLOTLY_AXIS_DEFAULTS,
  PLOTLY_LEGEND,
  PLOTLY_CONFIG,
  RANGE_SELECTOR_BUTTONS_DAILY,
  makeDateXAxis,
} from "@/lib/plot";
import { SECONDS_PER_DAY } from "@/lib/time-series";
import { isFpmm, isFxPool } from "@/lib/tokens";
import { fxWeekendBands } from "@/lib/weekend";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });
const SORTED_ORACLES_DECIMALS = 24;

interface LiquidityChartProps {
  snapshots: PoolSnapshot[];
  pool: Pool | null;
  network?: Network;
  token0Symbol?: string;
  token1Symbol?: string;
}

type LiquiditySeries = {
  useUsd: boolean;
  timestamps: string[];
  reserves0Usd: Array<number | null>;
  reserves1Usd: Array<number | null>;
  raw0: Array<number | null>;
  raw1: Array<number | null>;
};

type LiquiditySeriesInput = {
  snapshots: PoolSnapshot[];
  pool: Pool | null;
  token0Symbol: string;
};

function buildLiquiditySeries({
  snapshots,
  pool,
  token0Symbol,
}: LiquiditySeriesInput): LiquiditySeries {
  const sorted = [...snapshots].sort(
    (a, b) => Number(a.timestamp) - Number(b.timestamp),
  );
  const range = dailyRange(sorted);
  const nonUsdmUsdPrice = parseSortedOracleFeedUsdPrice(
    pool?.oraclePrice ?? "0",
  );
  const usdmIsToken0 = token0Symbol === "USDm";
  const useUsd = nonUsdmUsdPrice > 0;
  const dec0 = pool?.token0Decimals ?? 18;
  const dec1 = pool?.token1Decimals ?? 18;
  const raw0Series = forwardFillSeries(
    sorted.map((s) => ({
      timestamp: Number(s.timestamp),
      value: parseWei(s.reserves0, dec0),
    })),
    range,
  );
  const raw1Series = forwardFillSeries(
    sorted.map((s) => ({
      timestamp: Number(s.timestamp),
      value: parseWei(s.reserves1, dec1),
    })),
    range,
  );
  const toUsd0 = (amount: number | undefined): number | null => {
    if (amount === undefined) return null;
    return useUsd && !usdmIsToken0 ? amount * nonUsdmUsdPrice : amount;
  };
  const toUsd1 = (amount: number | undefined): number | null => {
    if (amount === undefined) return null;
    return useUsd && usdmIsToken0 ? amount * nonUsdmUsdPrice : amount;
  };

  return {
    useUsd,
    timestamps: raw0Series.map((point) =>
      new Date(point.timestamp * 1000).toISOString(),
    ),
    reserves0Usd: raw0Series.map((point) => toUsd0(point.value)),
    reserves1Usd: raw1Series.map((point) => toUsd1(point.value)),
    raw0: raw0Series.map((point) => point.value ?? null),
    raw1: raw1Series.map((point) => point.value ?? null),
  };
}

function dayBucket(timestamp: number): number {
  return Math.floor(timestamp / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

function currentDayBucket(): number {
  return dayBucket(Math.floor(Date.now() / 1000));
}

function dailyRange(snapshots: PoolSnapshot[]): {
  from: number;
  to: number;
  bucketSeconds: number;
} {
  const first = snapshots[0]!;
  const last = snapshots[snapshots.length - 1]!;
  const from = dayBucket(Number(first.timestamp));
  const lastSnapshotEnd = dayBucket(Number(last.timestamp)) + SECONDS_PER_DAY;
  const todayEnd = currentDayBucket() + SECONDS_PER_DAY;
  return {
    from,
    to: Math.max(lastSnapshotEnd, todayEnd),
    bucketSeconds: SECONDS_PER_DAY,
  };
}

function makeFxWeekendShapes({
  pool,
  network,
  from,
  to,
}: {
  pool: Pool | null | undefined;
  network: Network | undefined;
  from: number;
  to: number;
}): Plotly.Layout["shapes"] {
  if (!pool || !network || !isFpmm(pool)) return [];
  if (!isFxPool(network, pool.token0 ?? null, pool.token1 ?? null)) return [];
  return fxWeekendBands({ from, to });
}

function parseSortedOracleFeedUsdPrice(rawPrice: string): number {
  if (!rawPrice || rawPrice === "0") return 0;
  const feedValue = Number(rawPrice) / 10 ** SORTED_ORACLES_DECIMALS;
  return Number.isFinite(feedValue) && feedValue > 0 ? feedValue : 0;
}

export function LiquidityChart({
  snapshots,
  pool,
  network,
  token0Symbol = "Token 0",
  token1Symbol = "Token 1",
}: LiquidityChartProps) {
  if (snapshots.length === 0) return null;
  const sorted = [...snapshots].sort(
    (a, b) => Number(a.timestamp) - Number(b.timestamp),
  );
  const range = dailyRange(sorted);

  // Convert raw token reserves to USD value using the current oracle price as
  // an approximation for all historical data points. This lets both series share
  // a single Y-axis so a balanced pool shows two overlapping lines.
  //
  // Liquidity conversion needs the feed-direction USD price for the non-USDm
  // token. The oracle chart uses pool display direction, which intentionally
  // inverts USDm-base pools and is not suitable for reserve USD conversion.
  const { useUsd, timestamps, reserves0Usd, reserves1Usd, raw0, raw1 } =
    buildLiquiditySeries({
      snapshots: sorted,
      pool,
      token0Symbol,
    });
  const trace0 = makeReserveTrace({
    timestamps,
    values: reserves0Usd,
    raw: raw0,
    tokenSymbol: token0Symbol,
    useUsd,
    color: "#6366f1",
    fillcolor: "rgba(99,102,241,0.1)",
  });
  const trace1 = makeReserveTrace({
    timestamps,
    values: reserves1Usd,
    raw: raw1,
    tokenSymbol: token1Symbol,
    useUsd,
    color: "#a78bfa",
    fillcolor: "rgba(167,139,250,0.1)",
  });

  const subtitle = useUsd
    ? "Estimated using current oracle price — balanced pool = lines overlap"
    : null;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2 sm:p-4 mb-4 overflow-hidden">
      <div className="flex items-baseline gap-2 mb-3">
        <h3 className="text-sm font-medium text-slate-400">
          Pool Reserves Over Time
        </h3>
        {subtitle && <span className="text-xs text-slate-600">{subtitle}</span>}
      </div>
      <Plot
        data={[trace0, trace1]}
        layout={{
          ...makeLayout(useUsd),
          shapes: makeFxWeekendShapes({
            pool,
            network,
            from: range.from,
            to: range.to,
          }),
        }}
        config={PLOTLY_CONFIG}
        style={{ width: "100%", height: 320 }}
        useResizeHandler
      />
    </div>
  );
}

function makeReserveTrace({
  timestamps,
  values,
  raw,
  tokenSymbol,
  useUsd,
  color,
  fillcolor,
}: {
  timestamps: string[];
  values: Array<number | null>;
  raw: Array<number | null>;
  tokenSymbol: string;
  useUsd: boolean;
  color: string;
  fillcolor: string;
}) {
  const name = useUsd ? `${tokenSymbol} (USD)` : tokenSymbol;
  return {
    x: timestamps,
    y: values,
    customdata: raw,
    hovertemplate: useUsd
      ? `<b>%{customdata:,.2f} ${tokenSymbol}</b><br>≈ $%{y:,.2f} USD<br>%{x|%b %d, %Y %H:%M}<extra></extra>`
      : `<b>%{customdata:,.2f} ${tokenSymbol}</b><br>%{x|%b %d, %Y %H:%M}<extra></extra>`,
    type: "scatter" as const,
    mode: "lines" as const,
    name,
    line: { color, width: 2 },
    fill: "tozeroy" as const,
    fillcolor,
    yaxis: "y" as const,
  };
}

function makeLayout(useUsd: boolean) {
  return {
    ...PLOTLY_BASE_LAYOUT,
    font: { ...PLOTLY_BASE_LAYOUT.font, size: 11 },
    xaxis: makeDateXAxis(RANGE_SELECTOR_BUTTONS_DAILY),
    yaxis: {
      title: { text: useUsd ? "Reserve Value (USD)" : "Reserve Balance" },
      ...PLOTLY_AXIS_DEFAULTS,
    },
    legend: {
      ...PLOTLY_LEGEND,
      orientation: "h" as const,
      x: 0.5,
      y: -0.25,
      xanchor: "center" as const,
      yanchor: "top" as const,
    },
    margin: { t: 8, r: 16, b: 8, l: 48 },
    autosize: true,
    dragmode: "pan" as const,
  };
}
