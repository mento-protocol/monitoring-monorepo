// Satori JSX for the peg-monitoring Open Graph card.
//
// This folder is the render layer and `_lib/` is the logic layer: nothing here
// is imported by the page, and nothing from `_components/` (which is `"use
// client"`) may be imported here — a client module entering the OG import
// graph breaks the route.

import type { PegOgRow } from "../_lib/peg-og-data";
import { Rail, RailScale } from "./rail";
import {
  DIM,
  HAIRLINE,
  SURFACE,
  TEXT,
  TEXT_2,
  TONE_COLOR,
  TONE_TINT,
} from "./theme";

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

export type TileScale = ReturnType<typeof tileScale>;

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
      <span
        style={{
          fontSize: scale.pillText,
          fontWeight: 600,
          color: TONE_COLOR[row.tone],
        }}
      >
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
          <span
            style={{
              fontSize: scale.statValue,
              fontWeight: 600,
              color: stat.color,
            }}
          >
            {stat.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Tile({ row, compact }: { row: PegOgRow; compact: boolean }) {
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
            style={{
              fontSize: scale.pair,
              fontWeight: 600,
              color: TEXT,
              letterSpacing: -0.6,
            }}
          >
            {row.pair}
          </span>
          <span
            style={{ fontSize: scale.price, fontWeight: 600, color: TEXT_2 }}
          >
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
