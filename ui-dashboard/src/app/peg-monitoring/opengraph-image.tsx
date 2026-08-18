import { ImageResponse } from "next/og";
import {
  fetchPegMonitoringForMetadata,
  type PegMonitoringOgData,
  type PegOgRow,
} from "./_lib/peg-og-data";
import { type PegBoardTone } from "./_lib/peg-board-model";
import { railGradient, railTicks } from "./_lib/peg-og-layout";

export const runtime = "nodejs";
export const revalidate = 60;
export const contentType = "image/png";
export const size = { width: 1200, height: 630 };

// The board's own palette, resolved to sRGB hex. Satori parses neither the
// `oklch()` literals in `peg-board-model.ts` nor the design-system custom
// properties the page reads them through, so the card carries the resolved
// values. Keep these in step with `PEG_COLOR` when that block moves.
const BG = "#070010";
const SURFACE = "#15111b";
const HAIRLINE = "#272130";
const TEXT = "#f9f8fc";
const TEXT_2 = "#ceccd3";
const MUTED = "#8d8b92";
const DIM = "#6b6673";
const GREEN = "#1ecc09";
const AMBER = "#fe9900";
const RED_TEXT = "#f05751";
const OFF_SCALE = "#bb5850";
const PURPLE = "#7005fc";

// Satori's fallback face ships a single weight, so this card builds hierarchy
// from size and colour alone. `fontWeight` silently does nothing here: the
// repo's Geist files are woff2, which Satori cannot parse, and no `fonts`
// array is passed to `ImageResponse` — the same gap the homepage and pool
// cards have. Loading a real face needs a ttf/otf added to the repo first.
const TONE_COLOR: Record<PegBoardTone, string> = {
  healthy: GREEN,
  warning: AMBER,
  uncertain: AMBER,
  critical: RED_TEXT,
};

const TICK_COLOR = {
  critical: RED_TEXT,
  warn: AMBER,
  target: TEXT_2,
} as const;

const TONE_TINT: Record<PegBoardTone, { bg: string; border: string }> = {
  healthy: { bg: "rgba(30,204,9,0.12)", border: "rgba(30,204,9,0.38)" },
  warning: { bg: "rgba(254,153,0,0.12)", border: "rgba(254,153,0,0.38)" },
  uncertain: { bg: "rgba(254,153,0,0.12)", border: "rgba(254,153,0,0.38)" },
  critical: { bg: "rgba(201,44,44,0.16)", border: "rgba(201,44,44,0.48)" },
};

/**
 * One or two pegs get a tile each; three or more collapse to table rows. A
 * lone table row stranded in 380px of empty card reads as a rendering fault,
 * where a tall tile reads as deliberate.
 */
function isTiled(rows: readonly PegOgRow[]): boolean {
  return rows.length <= 2;
}

function buildAlt(data: PegMonitoringOgData | null): string {
  if (data === null) return "Mento peg monitoring — status unavailable";
  const rows = data.rows.map(
    (row) => `${row.pair} ${row.price}, ${row.distance}, ${row.status}`,
  );
  // The alt string carries the qualifier the pill drops for width — a reader
  // on a failed image must still learn the package was stale.
  return [
    "Mento peg monitoring",
    data.summary,
    ...(data.qualifier === null ? [] : [data.qualifier]),
    ...rows,
  ].join(" · ");
}

function Rail({ row, height }: { row: PegOgRow; height: number }) {
  const marker = row.marker;
  const dotSize = height + 6;
  return (
    <div
      style={{
        display: "flex",
        position: "relative",
        flex: 1,
        height,
        borderRadius: 5,
        background: railGradient(row.thresholds),
        opacity: marker === null ? 0.35 : 1,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: -5,
          width: 2,
          height: height + 10,
          background: "rgba(206,204,211,0.5)",
        }}
      />
      {marker === null ? null : marker.offScale ? (
        <OffScaleMarker below={marker.percent < 50} size={dotSize} />
      ) : (
        // react-doctor-disable-next-line react-doctor/no-inline-exhaustive-style
        <div
          style={{
            position: "absolute",
            left: `${marker.percent}%`,
            top: -3,
            marginLeft: -dotSize / 2,
            width: dotSize,
            height: dotSize,
            borderRadius: dotSize,
            background: TONE_COLOR[row.tone],
            border: `3px solid ${BG}`,
          }}
        />
      )}
    </div>
  );
}

/**
 * A deviation past ±60 bps has no honest position on the rail, so it pins to
 * the edge as a hollow ring with a chevron — the same treatment the page's
 * `DistanceRail` uses, rather than a solid dot implying a measured spot.
 *
 * Laid out as one absolutely-positioned full-width row that flex-justifies to
 * the correct end. Per-element percentage offsets (`left: "99%"`) do not
 * survive here: with a third absolutely-positioned sibling on the rail Satori
 * resolved them to 0, so an above-target premium pinned to the discount end
 * and the card asserted the opposite direction of the real deviation. Flex
 * justification has no such failure mode, and it keeps the chevron inside the
 * rail rather than clipped off the edge of the card.
 */
function OffScaleMarker({ below, size }: { below: boolean; size: number }) {
  const chevron = (
    <span style={{ fontSize: 22, color: RED_TEXT }}>{below ? "«" : "»"}</span>
  );
  return (
    // react-doctor-disable-next-line react-doctor/no-inline-exhaustive-style
    <div
      style={{
        display: "flex",
        position: "absolute",
        left: 0,
        top: -3,
        width: "100%",
        height: size,
        alignItems: "center",
        gap: 4,
        justifyContent: below ? "flex-start" : "flex-end",
      }}
    >
      {below ? chevron : null}
      <div
        style={{
          width: size,
          height: size,
          borderRadius: size,
          background: "rgba(201,44,44,0.15)",
          border: `3px solid ${OFF_SCALE}`,
        }}
      />
      {below ? null : chevron}
    </div>
  );
}

/**
 * One tile owns the whole body; two have to split it. A tile drawn at the
 * single-peg scale needs about 246px and two of them only get ~211px each,
 * which pushed the stats row below its own border and into the footer, so the
 * two-peg variant trims its type and padding to fit.
 */
function tileScale(compact: boolean) {
  return compact
    ? {
        pad: "16px 30px",
        pair: 34,
        price: 30,
        distance: 22,
        headGap: 16,
        rail: 20,
        railGap: 4,
        scaleHeight: 22,
        tick: 15,
        statTop: 12,
        statKey: 15,
        statValue: 21,
        pillPad: "6px 16px",
        pillText: 21,
        pillDot: 9,
      }
    : {
        pad: "28px 32px",
        pair: 44,
        price: 40,
        distance: 26,
        headGap: 22,
        rail: 28,
        railGap: 8,
        scaleHeight: 24,
        tick: 17,
        statTop: 18,
        statKey: 16,
        statValue: 25,
        pillPad: "8px 20px",
        pillText: 25,
        pillDot: 11,
      };
}

type TileScale = ReturnType<typeof tileScale>;

/**
 * Threshold ticks under a tile's rail, read from the peg's own policy. Ticks
 * beyond the fixed ±60 bps window are dropped rather than clamped, since a
 * clamped tick would place a threshold where it is not.
 */
function RailScale({ row, scale }: { row: PegOgRow; scale: TileScale }) {
  const ticks = railTicks(row.thresholds);
  return (
    <div
      style={{
        display: "flex",
        position: "relative",
        height: scale.scaleHeight,
      }}
    >
      {ticks.map((tick) => (
        <div
          key={tick.label}
          style={{
            display: "flex",
            position: "absolute",
            left: `${tick.at}%`,
            marginLeft: -70,
            width: 140,
            justifyContent: "center",
          }}
        >
          <span style={{ fontSize: scale.tick, color: TICK_COLOR[tick.tone] }}>
            {tick.label}
          </span>
        </div>
      ))}
    </div>
  );
}

function StatusPill({ row, scale }: { row: PegOgRow; scale: TileScale }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: scale.pillPad,
        borderRadius: 999,
        background: TONE_TINT[row.tone].bg,
        border: `1px solid ${TONE_TINT[row.tone].border}`,
      }}
    >
      <div
        style={{
          width: scale.pillDot,
          height: scale.pillDot,
          borderRadius: scale.pillDot,
          background: TONE_COLOR[row.tone],
        }}
      />
      <span style={{ fontSize: scale.pillText, color: TONE_COLOR[row.tone] }}>
        {row.status}
      </span>
    </div>
  );
}

/** The board's supporting columns, kept as facts rather than filler space. */
function TileStats({ row, scale }: { row: PegOgRow; scale: TileScale }) {
  const stats = [
    { key: "PRIMARY MARKET", value: row.venue ?? "—", color: TEXT_2 },
    { key: "BID–ASK SPREAD", value: row.spread ?? "—", color: TEXT_2 },
    {
      key: "CIRCUIT BREAKER",
      value: row.breaker?.label ?? "—",
      color: row.breaker === null ? TEXT_2 : TONE_COLOR[row.breaker.tone],
    },
  ];
  return (
    <div style={{ display: "flex", gap: 16 }}>
      {stats.map((stat) => (
        <div
          key={stat.key}
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            gap: 6,
            paddingTop: scale.statTop,
            borderTop: `1px solid ${HAIRLINE}`,
          }}
        >
          <span
            style={{
              fontSize: scale.statKey,
              letterSpacing: 1.6,
              textTransform: "uppercase",
              color: DIM,
            }}
          >
            {stat.key}
          </span>
          <span style={{ fontSize: scale.statValue, color: stat.color }}>
            {stat.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function Tile({ row, compact }: { row: PegOgRow; compact: boolean }) {
  const scale = tileScale(compact);
  return (
    // react-doctor-disable-next-line react-doctor/no-inline-exhaustive-style
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        justifyContent: "space-between",
        padding: scale.pad,
        borderRadius: 16,
        background: SURFACE,
        border: `1px solid ${HAIRLINE}`,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: scale.headGap,
          }}
        >
          <span
            style={{ fontSize: scale.pair, color: TEXT, letterSpacing: -0.6 }}
          >
            {row.pair}
          </span>
          <span style={{ fontSize: scale.price, color: TEXT_2 }}>
            {row.price}
          </span>
          <span
            style={{ fontSize: scale.distance, color: TONE_COLOR[row.tone] }}
          >
            {row.distance}
          </span>
        </div>
        <StatusPill row={row} scale={scale} />
      </div>
      <div
        style={{ display: "flex", flexDirection: "column", gap: scale.railGap }}
      >
        <div style={{ display: "flex" }}>
          <Rail row={row} height={scale.rail} />
        </div>
        <RailScale row={row} scale={scale} />
      </div>
      <TileStats row={row} scale={scale} />
    </div>
  );
}

// Fixed widths with `flexShrink: 0`: without it a long price steals width from
// its own cell and the rails stop lining up down the column.
const COL = {
  pair: { width: 230, flexShrink: 0 },
  price: { width: 170, flexShrink: 0 },
  distance: { width: 170, flexShrink: 0 },
  status: { width: 130, flexShrink: 0 },
} as const;

function TableRow({ row, last }: { row: PegOgRow; last: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        flex: 1,
        alignItems: "center",
        gap: 12,
        padding: "0 10px",
        borderBottom: last ? "none" : `1px solid ${HAIRLINE}`,
      }}
    >
      <span style={{ ...COL.pair, fontSize: 33, color: TEXT }}>{row.pair}</span>
      <span style={{ ...COL.price, fontSize: 31, color: TEXT_2 }}>
        {row.price}
      </span>
      <div style={{ display: "flex", flex: 1, alignItems: "center", gap: 14 }}>
        <Rail row={row} height={20} />
        <span style={{ ...COL.distance, fontSize: 22, color: MUTED }}>
          {row.distance}
        </span>
      </div>
      <div
        style={{ display: "flex", ...COL.status, justifyContent: "flex-end" }}
      >
        <span style={{ fontSize: 26, color: TONE_COLOR[row.tone] }}>
          {row.status}
        </span>
      </div>
    </div>
  );
}

function TableHeads() {
  const cell = { fontSize: 17, letterSpacing: 2, color: DIM };
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "0 10px 14px",
        borderBottom: `1px solid ${HAIRLINE}`,
      }}
    >
      <span style={{ ...cell, ...COL.pair }}>PEG</span>
      <span style={{ ...cell, ...COL.price }}>PRICE</span>
      <span style={{ ...cell, flex: 1 }}>DISTANCE TO TARGET</span>
      <div
        style={{ display: "flex", ...COL.status, justifyContent: "flex-end" }}
      >
        <span style={cell}>STATUS</span>
      </div>
    </div>
  );
}

function Header({ data }: { data: PegMonitoringOgData | null }) {
  const tone: PegBoardTone = data?.tone ?? "uncertain";
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 26,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          style={{ width: 16, height: 16, borderRadius: 5, background: PURPLE }}
        />
        <span style={{ fontSize: 26, color: TEXT }}>Mento</span>
        <span style={{ fontSize: 26, color: DIM }}>/</span>
        <span style={{ fontSize: 26, color: MUTED }}>Peg Monitoring</span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 24px",
          borderRadius: 999,
          background: TONE_TINT[tone].bg,
          border: `1px solid ${TONE_TINT[tone].border}`,
        }}
      >
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: 12,
            background: TONE_COLOR[tone],
          }}
        />
        <span style={{ fontSize: 25, color: TONE_COLOR[tone] }}>
          {data?.summary ?? "Status unavailable"}
        </span>
      </div>
    </div>
  );
}

function Body({ data }: { data: PegMonitoringOgData | null }) {
  const rows = data?.rows ?? [];
  if (rows.length === 0)
    return (
      <div style={{ display: "flex", flex: 1, alignItems: "center" }}>
        <span style={{ fontSize: 30, color: MUTED }}>
          No confirmed decision package is available.
        </span>
      </div>
    );
  if (isTiled(rows))
    return (
      <div
        style={{ display: "flex", flexDirection: "column", flex: 1, gap: 16 }}
      >
        {rows.map((row) => (
          // Keyed by asset id, not the pair label: two pegs can share a pair
          // label (same asset name, same peg) while their ids stay distinct.
          <Tile key={row.id} row={row} compact={rows.length > 1} />
        ))}
      </div>
    );
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      <TableHeads />
      {rows.map((row, index) => (
        <TableRow key={row.id} row={row} last={index === rows.length - 1} />
      ))}
    </div>
  );
}

function Footer({ data }: { data: PegMonitoringOgData | null }) {
  const right =
    data === null
      ? ""
      : [
          data.omittedCount > 0 ? `+${data.omittedCount} more` : null,
          data.stale ? `Last confirmed ${data.age} ago` : null,
        ]
          .filter((part) => part !== null)
          .join(" · ");
  // The qualifier ("latest data is stale") outranks the standing provenance
  // line: it is the one thing that changes how the numbers above should be read.
  const qualifier = data === null ? null : data.qualifier;
  const left =
    data === null
      ? "monitoring.mento.org/peg-monitoring"
      : (qualifier ?? `Executable prices, not oracles · ${data.cadence}`);
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        marginTop: 18,
        fontSize: 19,
        color: DIM,
      }}
    >
      <span style={{ color: qualifier === null ? DIM : AMBER }}>{left}</span>
      <span>{right}</span>
    </div>
  );
}

function Card({ data }: { data: PegMonitoringOgData | null }) {
  // No package is an unknown state, not a critical one — the edge bar stays
  // amber so a fetch failure never reads as a confirmed breach.
  const tone: PegBoardTone = data?.tone ?? "uncertain";
  return (
    // react-doctor-disable-next-line react-doctor/no-inline-exhaustive-style
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        position: "relative",
        background: BG,
        padding: "44px 56px 36px",
        color: TEXT,
        fontFamily: '"Geist", "Inter", "Helvetica", sans-serif',
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: size.width,
          height: 8,
          background: TONE_COLOR[tone],
        }}
      />
      <Header data={data} />
      <Body data={data} />
      <Footer data={data} />
    </div>
  );
}

// 60s fresh / 24h stale-while-revalidate, matching the homepage and pool
// cards: the CDN serves stale bytes instantly while refreshing behind them,
// so a breach reaches a new unfurl in about a minute rather than an hour.
const IMAGE_CACHE_CONTROL =
  "public, max-age=60, s-maxage=60, stale-while-revalidate=86400";

export async function generateImageMetadata() {
  const data = await fetchPegMonitoringForMetadata();
  return [{ id: "og", alt: buildAlt(data), size, contentType }];
}

export default async function Image() {
  const data = await fetchPegMonitoringForMetadata();
  return new ImageResponse(<Card data={data} />, {
    ...size,
    headers: { "Cache-Control": IMAGE_CACHE_CONTROL },
  });
}
