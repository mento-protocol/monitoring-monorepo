"use client";

import dynamic from "next/dynamic";
import useSWR from "swr";
import { useSession } from "next-auth/react";
import { fetchJsonOr404 } from "@/lib/fetch-json";
import { relativeTimeFromIso } from "@/lib/format";
import { PLOTLY_BASE_LAYOUT, PLOTLY_CONFIG } from "@/lib/plot";
import type { IntelWealthRecord } from "@/lib/intel-wealth";

const Plot = dynamic(() => import("react-plotly.js"), {
  ssr: false,
  loading: () => <div className="h-40 animate-pulse rounded bg-slate-800/30" />,
});

/**
 * Walk an unknown portfolio response and sum the `usd` field of every
 * per-token leaf. A "per-token leaf" is an object that has BOTH a `usd`
 * number AND a `symbol` string — the shape Arkham returns for individual
 * token entries (`{id, name, symbol, balance, price, usd}`). The shape
 * test guards against double-counting if Arkham ever adds a chain- or
 * portfolio-level summary `usd` field alongside the per-token breakdown.
 */
function sumUsdFields(obj: unknown, depth = 0): number {
  if (depth > 6) return 0;
  if (!obj || typeof obj !== "object") return 0;
  const o = obj as Record<string, unknown>;
  if (typeof o.usd === "number" && typeof o.symbol === "string") {
    return o.usd;
  }
  let total = 0;
  for (const val of Object.values(o)) {
    total += sumUsdFields(val, depth + 1);
  }
  return total;
}

type ChartPoint = {
  label: string;
  usd: number;
};

// Portfolio keys are "0d_ago", "30d_ago", "90d_ago", "180d_ago" — see
// scripts/intel-marathon/extract-wealth.mjs.
const DAY_LABELS: Record<string, string> = {
  "0d_ago": "Now",
  "30d_ago": "30d ago",
  "90d_ago": "90d ago",
  "180d_ago": "180d ago",
};

function buildPortfolioPoints(
  portfolio: Record<string, { ts: number; data: unknown }> | null | undefined,
): ChartPoint[] {
  if (!portfolio) return [];
  const result: ChartPoint[] = [];
  for (const [key, entry] of Object.entries(portfolio)) {
    // Drop unknown keys so a future Arkham addition (e.g. "365d_ago") doesn't
    // sort to position -1 and skew the chart's leading edge.
    const label = DAY_LABELS[key];
    if (!label) continue;
    try {
      const usd = sumUsdFields(entry.data);
      if (!Number.isFinite(usd) || usd <= 0) continue;
      result.push({ label, usd });
    } catch {
      // drop the point
    }
  }
  const ORDER = ["180d ago", "90d ago", "30d ago", "Now"];
  result.sort((a, b) => ORDER.indexOf(a.label) - ORDER.indexOf(b.label));
  return result;
}

function formatUSD(value: number): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function sumChainBalances(
  balanceMap: Record<string, number> | null | undefined,
): number {
  if (!balanceMap) return 0;
  return Object.values(balanceMap).reduce<number>(
    (acc, v) => acc + (typeof v === "number" ? v : 0),
    0,
  );
}

function buildSummaryText(record: IntelWealthRecord): string | null {
  try {
    const current = sumChainBalances(record.balances?.totalBalance ?? null);
    if (current <= 0) return null;
    const prev = sumChainBalances(record.balances?.totalBalance24hAgo ?? null);
    if (prev <= 0) return `current: ${formatUSD(current)}`;
    const delta = (((current - prev) / prev) * 100).toFixed(1);
    return `current: ${formatUSD(current)} (24h ago: ${formatUSD(prev)}, Δ ${delta}%)`;
  } catch {
    return null;
  }
}

const SPARK_LAYOUT = {
  ...PLOTLY_BASE_LAYOUT,
  height: 160,
  xaxis: {
    showgrid: false,
    showline: false,
    zeroline: false,
    tickfont: { size: 10, color: "#64748b" },
    fixedrange: true,
  },
  yaxis: {
    showgrid: false,
    showticklabels: false,
    showline: false,
    zeroline: false,
    fixedrange: true,
  },
  margin: { t: 8, r: 8, b: 24, l: 8 },
  autosize: true,
  dragmode: false as const,
  hovermode: "x" as const,
  hoverlabel: {
    bgcolor: "#0f172a",
    bordercolor: "#6366f1",
    font: { color: "#e2e8f0", size: 12, family: "inherit" },
  },
};

function sparkTrace(points: ChartPoint[]) {
  return {
    x: points.map((p) => p.label),
    y: points.map((p) => p.usd),
    type: "scatter" as const,
    mode: "lines+markers" as const,
    line: { color: "#6366f1", width: 2 },
    marker: { color: "#6366f1", size: 6 },
    fill: "tozeroy" as const,
    fillcolor: "rgba(99,102,241,0.08)",
    hovertemplate: "<b>$%{y:,.0f}</b><extra></extra>",
  };
}

export function IntelWealthChart({ address }: { address: string }) {
  const { status } = useSession();
  const { data } = useSWR<IntelWealthRecord | null>(
    status === "authenticated" ? `/api/intel/wealth/${address}` : null,
    (url: string) =>
      fetchJsonOr404<IntelWealthRecord>(url, "Wealth", {
        timeoutMs: 15_000,
      }),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshInterval: 0,
    },
  );

  if (!data) return null;
  const points = buildPortfolioPoints(
    data.portfolio as
      | Record<string, { ts: number; data: unknown }>
      | null
      | undefined,
  );
  if (points.length === 0) return null;
  const summaryText = buildSummaryText(data);

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900">
      <div className="border-b border-slate-800 px-5 py-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">
          Wealth trajectory (USD, all chains)
        </h2>
        {data.fetchedAt && (
          <span className="text-xs text-slate-500">
            Fetched {relativeTimeFromIso(data.fetchedAt)}
          </span>
        )}
      </div>
      <div className="p-5">
        <Plot
          data={[sparkTrace(points)]}
          layout={SPARK_LAYOUT}
          config={{ ...PLOTLY_CONFIG, scrollZoom: false }}
          style={{ width: "100%", height: 160 }}
          useResizeHandler
        />
        {summaryText && (
          <p className="mt-2 text-xs text-slate-400">{summaryText}</p>
        )}
      </div>
    </section>
  );
}
