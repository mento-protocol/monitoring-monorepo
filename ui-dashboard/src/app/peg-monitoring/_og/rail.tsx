// Satori JSX for the peg-monitoring Open Graph card.
//
// This folder is the render layer and `_lib/` is the logic layer: nothing here
// is imported by the page, and nothing from `_components/` (which is `"use
// client"`) may be imported here — a client module entering the OG import
// graph breaks the route.

import type { PegOgRow } from "../_lib/peg-og-data";
import { railGradient, railTicks } from "../_lib/peg-og-layout";
import type { TileScale } from "./tile";
import { BG, OFF_SCALE, RED_TEXT, TICK_COLOR, TONE_COLOR } from "./theme";

export function Rail({ row, height }: { row: PegOgRow; height: number }) {
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
 * Threshold ticks under a tile's rail, read from the peg's own policy. Ticks
 * beyond the fixed ±60 bps window are dropped rather than clamped, since a
 * clamped tick would place a threshold where it is not.
 */
export function RailScale({ row, scale }: { row: PegOgRow; scale: TileScale }) {
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
