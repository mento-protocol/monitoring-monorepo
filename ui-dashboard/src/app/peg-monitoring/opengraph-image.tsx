import { ImageResponse } from "next/og";
import { ogFontOptions } from "@/lib/og-fonts";
import {
  fetchPegMonitoringForMetadata,
  type PegMonitoringOgData,
  type PegOgRow,
} from "./_lib/peg-og-data";
import { type PegBoardTone } from "./_lib/peg-board-model";
import { Tile } from "./_og/tile";
import { TableHeads, TableRow } from "./_og/table";
import {
  AMBER,
  BG,
  DIM,
  MUTED,
  PURPLE,
  TEXT,
  TONE_COLOR,
  TONE_TINT,
} from "./_og/theme";

export const runtime = "nodejs";
export const revalidate = 60;
export const contentType = "image/png";
export const size = { width: 1200, height: 630 };

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
        <span style={{ fontSize: 26, fontWeight: 700, color: TEXT }}>
          Mento
        </span>
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
        <span
          style={{ fontSize: 25, fontWeight: 600, color: TONE_COLOR[tone] }}
        >
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

/**
 * 60s fresh, then at most 5 minutes of stale replay — deliberately shorter
 * than the 24h the homepage, pool and bridge-flows cards use.
 *
 * Those three carry TVL and volume, where a stale number is merely out of
 * date. This card carries an alert condition, and `stale-while-revalidate`
 * lets a CDN hand out already-rendered bytes while it refreshes behind them.
 * At 24h that means a card rendered while every peg was healthy can answer a
 * request made hours into a breach. The window is the bound on how wrong that
 * one reply can be, so it is set to the alert cadence rather than a day.
 *
 * The cost is that an unfurl arriving after a quiet spell waits for a real
 * render (~1-2s) instead of getting instant stale bytes. For a card whose job
 * is to state a safety condition, that is the right side of the trade.
 *
 * This bounds the origin only. Slack and X cache unfurls per URL on their own
 * schedule, so an already-posted link can still show what it showed when it
 * was first unfurled — no cache header here reaches that.
 */
const IMAGE_CACHE_CONTROL =
  "public, max-age=60, s-maxage=60, stale-while-revalidate=300";

export async function generateImageMetadata() {
  const data = await fetchPegMonitoringForMetadata();
  return [{ id: "og", alt: buildAlt(data), size, contentType }];
}

export default async function Image() {
  const data = await fetchPegMonitoringForMetadata();
  return new ImageResponse(<Card data={data} />, {
    ...size,
    ...(await ogFontOptions()),
    headers: { "Cache-Control": IMAGE_CACHE_CONTROL },
  });
}
