// Satori JSX for the peg-monitoring Open Graph card.
//
// This folder is the render layer and `_lib/` is the logic layer: nothing here
// is imported by the page, and nothing from `_components/` (which is `"use
// client"`) may be imported here — a client module entering the OG import
// graph breaks the route.

import type { PegOgRow } from "../_lib/peg-og-data";
import { Rail } from "./rail";
import { DIM, HAIRLINE, MUTED, TEXT, TEXT_2, TONE_COLOR } from "./theme";

// Fixed widths with `flexShrink: 0`: without it a long price steals width from
// its own cell and the rails stop lining up down the column.
const COL = {
  pair: { width: 230, flexShrink: 0 },
  price: { width: 170, flexShrink: 0 },
  distance: { width: 170, flexShrink: 0 },
  status: { width: 130, flexShrink: 0 },
} as const;

export function TableRow({ row, last }: { row: PegOgRow; last: boolean }) {
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
      <span style={{ ...COL.pair, fontSize: 33, fontWeight: 600, color: TEXT }}>
        {row.pair}
      </span>
      <span
        style={{ ...COL.price, fontSize: 31, fontWeight: 600, color: TEXT_2 }}
      >
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
        <span
          style={{ fontSize: 26, fontWeight: 600, color: TONE_COLOR[row.tone] }}
        >
          {row.status}
        </span>
      </div>
    </div>
  );
}

export function TableHeads() {
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
