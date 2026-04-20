import { ImageResponse } from "next/og";
import { fetchHomepageOgData, type HomepageOgData } from "@/lib/homepage-og";
import { formatUSD } from "@/lib/format";

export const runtime = "nodejs";
export const revalidate = 60;
export const contentType = "image/png";
export const size = { width: 1200, height: 630 };

const BG = "#0f172a";
const TEXT = "#e2e8f0";
const MUTED = "#94a3b8";
const ACCENT = "#818cf8";
const TILE_BG = "#1e293b";
const TILE_BORDER = "#334155";

const OK_COLOR = "#34d399";
const CRITICAL_COLOR = "#f87171";

function formatWoW(pct: number): { text: string; color: string } {
  const arrow = pct >= 0 ? "▲" : "▼";
  return {
    text: `${arrow} ${Math.abs(pct).toFixed(1)}% 7d`,
    color: pct >= 0 ? OK_COLOR : CRITICAL_COLOR,
  };
}

function buildAlt(data: HomepageOgData | null): string {
  if (!data) return "Mento Analytics — cross-chain protocol overview";
  const parts: string[] = ["Mento Analytics"];
  // `null` = unavailable; `0` = real empty state worth surfacing.
  if (data.totalTvlUsd != null) {
    parts.push(`TVL ${formatUSD(data.totalTvlUsd)}`);
  }
  if (data.totalVolume7dUsd != null) {
    parts.push(`7d volume ${formatUSD(data.totalVolume7dUsd)}`);
  }
  parts.push(`${data.poolCount} pools on ${data.chains.join(" + ")}`);
  const attention =
    (data.healthBuckets.WARN ?? 0) + (data.healthBuckets.CRITICAL ?? 0);
  parts.push(
    attention === 0
      ? "all healthy"
      : `${attention} ${attention === 1 ? "needs" : "need"} attention`,
  );
  return parts.join(" · ");
}

// Large TVL line chart — fills most of the card as the single main KPI
// after the hero number. Draws a filled area under the line for extra
// visual weight at Slack-thumbnail scale.
function TvlChart({ series }: { series: number[] }) {
  if (series.length < 2) return null;
  const w = 1088;
  const h = 280;
  const pad = 6;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const step = (w - pad * 2) / (series.length - 1);
  const points = series
    .map((v, i) => {
      const x = pad + i * step;
      const y = pad + (h - pad * 2) * (1 - (v - min) / span);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const baselineY = h - pad;
  const firstX = pad;
  const lastX = pad + (series.length - 1) * step;
  const areaPoints = `${firstX},${baselineY} ${points} ${lastX.toFixed(1)},${baselineY}`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polygon points={areaPoints} fill={ACCENT} fillOpacity={0.18} />
      <polyline
        points={points}
        fill="none"
        stroke={ACCENT}
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Card({ data }: { data: HomepageOgData | null }) {
  // null → "—" (unavailable); 0 → "$0.00" (real empty state).
  const tvl =
    data && data.totalTvlUsd != null ? formatUSD(data.totalTvlUsd) : "—";
  const tvlWow = data?.tvlWoWPct != null ? formatWoW(data.tvlWoWPct) : null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: BG,
        padding: 56,
        color: TEXT,
        fontFamily: '"Geist", "Inter", "Helvetica", sans-serif',
        gap: 36,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            style={{
              width: 18,
              height: 18,
              borderRadius: 6,
              background: ACCENT,
            }}
          />
          <span
            style={{
              fontSize: 28,
              fontWeight: 700,
              letterSpacing: 0.5,
              color: TEXT,
            }}
          >
            Mento Analytics
          </span>
        </div>
        {data ? (
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span style={{ fontSize: 24, color: MUTED }}>
              {data.poolCount} pools
            </span>
            <span
              style={{
                fontSize: 26,
                padding: "12px 26px",
                borderRadius: 999,
                background: TILE_BG,
                border: `1px solid ${TILE_BORDER}`,
                color: MUTED,
              }}
            >
              {data.chains.join(" · ")}
            </span>
          </div>
        ) : null}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 20,
          }}
        >
          <span
            style={{
              fontSize: 22,
              letterSpacing: 2,
              textTransform: "uppercase",
              color: MUTED,
            }}
          >
            Total TVL
          </span>
          {tvlWow ? (
            <span
              style={{
                fontSize: 24,
                fontWeight: 600,
                color: tvlWow.color,
              }}
            >
              {tvlWow.text}
            </span>
          ) : null}
        </div>
        <span
          style={{
            fontSize: 92,
            fontWeight: 800,
            letterSpacing: -2,
            color: TEXT,
            lineHeight: 1,
          }}
        >
          {tvl}
        </span>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          justifyContent: "flex-end",
          gap: 10,
          marginTop: 32,
        }}
      >
        {data && data.tvlSeries.length >= 2 ? (
          <TvlChart series={data.tvlSeries} />
        ) : null}
        {data && data.tvlSeries.length >= 2 ? (
          <span
            style={{
              fontSize: 18,
              letterSpacing: 1.5,
              textTransform: "uppercase",
              color: MUTED,
              alignSelf: "flex-end",
            }}
          >
            Last 30 days
          </span>
        ) : null}
      </div>
    </div>
  );
}

// 60s fresh / 24h stale-while-revalidate. Edge CDN serves stale bytes
// instantly while refreshing in the background — so an incident-state
// flip propagates in ~60s, not ~1h.
const IMAGE_CACHE_CONTROL =
  "public, max-age=60, s-maxage=60, stale-while-revalidate=86400";

export async function generateImageMetadata() {
  const data = await fetchHomepageOgData();
  return [
    {
      id: "og",
      alt: buildAlt(data),
      size,
      contentType,
    },
  ];
}

export default async function Image() {
  const data = await fetchHomepageOgData();
  return new ImageResponse(<Card data={data} />, {
    ...size,
    headers: { "Cache-Control": IMAGE_CACHE_CONTROL },
  });
}
