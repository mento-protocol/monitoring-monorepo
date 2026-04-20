import { ImageResponse } from "next/og";
import { fetchPoolForMetadata, type PoolOgData } from "@/lib/pool-og";
import { formatUSD } from "@/lib/format";

export const runtime = "nodejs";
export const revalidate = 3600;
export const contentType = "image/png";
export const size = { width: 1200, height: 630 };

const BG = "#0f172a";
const TEXT = "#e2e8f0";
const MUTED = "#94a3b8";
const ACCENT = "#818cf8";
const TILE_BG = "#1e293b";
const TILE_BORDER = "#334155";

type BadgeTone = "ok" | "warn" | "critical" | "neutral";

type HealthView = {
  label: string;
  tone: BadgeTone;
};

const TONE_COLOR: Record<BadgeTone, { fg: string; bg: string }> = {
  ok: { fg: "#34d399", bg: "rgba(52, 211, 153, 0.15)" },
  warn: { fg: "#fbbf24", bg: "rgba(251, 191, 36, 0.15)" },
  critical: { fg: "#f87171", bg: "rgba(248, 113, 113, 0.15)" },
  neutral: { fg: "#cbd5e1", bg: "rgba(148, 163, 184, 0.15)" },
};

function describeHealth(status: PoolOgData["health"]): HealthView {
  switch (status) {
    case "OK":
      return { label: "Healthy", tone: "ok" };
    case "WARN":
      return { label: "Attention", tone: "warn" };
    case "CRITICAL":
      return { label: "Critical", tone: "critical" };
    case "WEEKEND":
      return { label: "Markets closed", tone: "neutral" };
    default:
      return { label: "N/A", tone: "neutral" };
  }
}

function formatOracleAge(seconds: number): string {
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function buildAlt(data: PoolOgData | null): string {
  if (!data) return "Mento pool analytics preview";
  const parts: string[] = [`${data.name} pool on ${data.chainLabel}`];
  if (data.tvlUsd != null) parts.push(`TVL ${formatUSD(data.tvlUsd)}`);
  if (data.volume7dUsd != null) {
    parts.push(`7d volume ${formatUSD(data.volume7dUsd)}`);
  }
  const health = describeHealth(data.health);
  let healthPart = `health ${health.label.toLowerCase()}`;
  if (data.healthReasons.length > 0) {
    healthPart += ` (${data.healthReasons.join(", ")})`;
  }
  parts.push(healthPart);
  return parts.join(" · ");
}

function Sparkline({ series, color }: { series: number[]; color: string }) {
  if (series.length < 2) return null;
  const w = 280;
  const h = 44;
  const pad = 2;
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
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Tile({
  label,
  value,
  valueColor,
  subline,
  sublineColor,
  chart,
}: {
  label: string;
  value: string;
  valueColor?: string;
  subline?: string;
  sublineColor?: string;
  chart?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        padding: "24px 32px",
        borderRadius: 20,
        background: TILE_BG,
        border: `1px solid ${TILE_BORDER}`,
        gap: 8,
        justifyContent: "space-between",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span
          style={{
            fontSize: 20,
            letterSpacing: 2,
            textTransform: "uppercase",
            color: MUTED,
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontSize: 52,
            fontWeight: 700,
            color: valueColor ?? TEXT,
            lineHeight: 1,
          }}
        >
          {value}
        </span>
        {subline ? (
          <span
            style={{
              fontSize: 22,
              fontWeight: 600,
              color: sublineColor ?? MUTED,
            }}
          >
            {subline}
          </span>
        ) : null}
      </div>
      {chart}
    </div>
  );
}

function OracleFooter({ data }: { data: PoolOgData }) {
  if (data.oracleAgeSeconds == null) return null;
  const color = data.oracleFresh ? TONE_COLOR.ok.fg : TONE_COLOR.warn.fg;
  const label = data.oracleFresh ? "Oracle" : "Oracle stale";
  return (
    <span
      style={{
        fontSize: 26,
        color: MUTED,
        display: "flex",
        gap: 12,
        alignItems: "center",
      }}
    >
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: 999,
          background: color,
        }}
      />
      {label} · {formatOracleAge(data.oracleAgeSeconds)}
    </span>
  );
}

function Card({ data }: { data: PoolOgData | null }) {
  const name = data?.name ?? "Mento Pool";
  // null → "—" (unpriceable / unavailable); 0 → "$0.00" (real empty state).
  const tvl = data && data.tvlUsd != null ? formatUSD(data.tvlUsd) : "—";
  const volume7d =
    data && data.volume7dUsd != null ? formatUSD(data.volume7dUsd) : "—";

  let wowText: string | undefined;
  let wowColor: string | undefined;
  let sparkColor = TONE_COLOR.neutral.fg;
  if (data?.tvlWoWPct != null) {
    const pct = data.tvlWoWPct;
    const arrow = pct >= 0 ? "▲" : "▼";
    wowText = `${arrow} ${Math.abs(pct).toFixed(1)}% 7d`;
    wowColor = pct >= 0 ? TONE_COLOR.ok.fg : TONE_COLOR.critical.fg;
    sparkColor = wowColor;
  }

  const health = describeHealth(data?.health ?? "N/A");
  const healthColor = TONE_COLOR[health.tone];

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
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {data ? <OracleFooter data={data} /> : null}
          {data ? (
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
              {data.chainLabel}
            </span>
          ) : null}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <span
          style={{
            fontSize: name.length > 14 ? 112 : 140,
            fontWeight: 800,
            letterSpacing: -2,
            color: TEXT,
            lineHeight: 1,
          }}
        >
          {name}
        </span>
      </div>

      <div style={{ display: "flex", gap: 20 }}>
        <Tile
          label="TVL"
          value={tvl}
          subline={wowText}
          sublineColor={wowColor}
          chart={
            data && data.tvlSeries.length >= 2 ? (
              <Sparkline series={data.tvlSeries} color={sparkColor} />
            ) : null
          }
        />
        <Tile label="7d Volume" value={volume7d} />
        <Tile
          label="Health"
          value={health.label}
          valueColor={healthColor.fg}
          subline={data?.healthReasons[0]}
          sublineColor={healthColor.fg}
        />
      </div>
    </div>
  );
}

export async function generateImageMetadata({
  params,
}: {
  params: Promise<{ poolId: string }>;
}) {
  const { poolId } = await params;
  const data = await fetchPoolForMetadata(poolId);
  return [
    {
      id: "og",
      alt: buildAlt(data),
      size,
      contentType,
    },
  ];
}

// Cache the rendered PNG at Vercel's edge CDN for 1h, then serve stale for up
// to 24h while revalidating in the background. Slack/Discord/Twitter cache
// unfurls on their side too, so most crawler re-fetches never hit our fn.
const IMAGE_CACHE_CONTROL =
  "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400";

export default async function Image({
  params,
}: {
  params: Promise<{ poolId: string }>;
}) {
  const { poolId } = await params;
  const data = await fetchPoolForMetadata(poolId);
  return new ImageResponse(<Card data={data} />, {
    ...size,
    headers: { "Cache-Control": IMAGE_CACHE_CONTROL },
  });
}
