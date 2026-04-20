import { ImageResponse } from "next/og";
import {
  fetchBridgeFlowsOgData,
  type BridgeFlowsOgData,
} from "@/lib/bridge-flows-og";
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

function buildAlt(data: BridgeFlowsOgData | null): string {
  if (!data) return "Mento Bridge Flows — Wormhole cross-chain transfers";
  const parts: string[] = ["Mento Bridge Flows"];
  // `null` = snapshots query failed → skip; `0` = truly empty window → keep.
  if (data.volume30dUsd != null) {
    parts.push(`30d volume ${formatUSD(data.volume30dUsd)}`);
  }
  if (data.totalTransfers30d != null) {
    parts.push(
      `${data.totalTransfers30d.toLocaleString()} ${
        data.totalTransfers30d === 1 ? "transfer" : "transfers"
      }`,
    );
  }
  if (data.chains.length > 0) {
    parts.push(`on ${data.chains.join(" + ")}`);
  }
  if (data.volumeWoWPct != null) {
    parts.push(formatWoW(data.volumeWoWPct).text);
  }
  return parts.join(" · ");
}

// Full-width volume chart, mirroring the homepage TVL OG's area+line style
// so the three OGs (home, pool, bridge) share a visual grammar.
function VolumeChart({ series }: { series: number[] }) {
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

function Card({ data }: { data: BridgeFlowsOgData | null }) {
  // null → "—" (snapshot query failed); 0 → "$0" (genuinely no bridge
  // activity in the 30d window). Don't conflate.
  const volume =
    data && data.volume30dUsd != null
      ? data.volume30dUsd > 0
        ? formatUSD(data.volume30dUsd)
        : "$0"
      : "—";
  const wow = data?.volumeWoWPct != null ? formatWoW(data.volumeWoWPct) : null;
  const chainsLabel =
    data && data.chains.length > 0
      ? `Wormhole · ${data.chains.join(" · ")}`
      : "Wormhole";

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
            Mento Bridge Flows
          </span>
        </div>
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
          {chainsLabel}
        </span>
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
            Bridged Volume (30d)
          </span>
          {wow ? (
            <span
              style={{
                fontSize: 24,
                fontWeight: 600,
                color: wow.color,
              }}
            >
              {wow.text}
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
          {volume}
        </span>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          justifyContent: "flex-end",
        }}
      >
        {data && data.volumeSeries.length >= 2 ? (
          <VolumeChart series={data.volumeSeries} />
        ) : null}
      </div>
    </div>
  );
}

// 60s fresh / 24h stale-while-revalidate. Matches the homepage OG cadence;
// bridge data changes minute-to-minute, so 1h (pool OG cadence) would feel
// stale in Slack unfurls.
const IMAGE_CACHE_CONTROL =
  "public, max-age=60, s-maxage=60, stale-while-revalidate=86400";

export async function generateImageMetadata() {
  const data = await fetchBridgeFlowsOgData();
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
  const data = await fetchBridgeFlowsOgData();
  return new ImageResponse(<Card data={data} />, {
    ...size,
    headers: { "Cache-Control": IMAGE_CACHE_CONTROL },
  });
}
