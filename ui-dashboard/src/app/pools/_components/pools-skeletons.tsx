// Local table-skeleton rhythm for /pools that diverges from the shared
// `TableSkeleton`'s 36px header / 44px row geometry
// (`src/components/skeletons.tsx`). Production audit (2026-07-14, 1440x900,
// live data, 27 pools / 25 swaps): Recent Swaps table (`SwapTable` in
// `pools-page-client.tsx`) measures thead 45px, body rows 37px — shorter
// than the shared rhythm; every cell is single-line.
//
// The pools table's own rhythm (45px header / 58px rows) lives in
// `@/components/pools-table-skeleton` (`PoolsTableSkeleton`), not here — it's
// shared by the home route (`(home)/loading.tsx`, root `page-client.tsx`) as
// well as /pools, and `dashboard-route-private-pools` forbids code outside
// `app/pools/` from importing this route-private module.
//
// Composed locally (not through `TableSkeleton`) so this number doesn't bend
// the shared component's calibration for the tables it already serves —
// same approach as `cdps/_components/cdps-skeletons.tsx`'s
// `CdpTxTableSkeleton`. `skeletons.tsx` stays untouched.

const SWAPS_TABLE_HEADER_HEIGHT_PX = 45;
const SWAPS_TABLE_ROW_HEIGHT_PX = 37;

function liveRegion(
  label: string,
  presentational: boolean | undefined,
): Record<string, string> {
  if (presentational) return {};
  return { role: "status", "aria-live": "polite", "aria-label": label };
}

export function SwapsTableSkeleton({
  rows,
  presentational,
}: {
  rows: number;
  /** True when a parent already provides the live region (route fallback). */
  presentational?: boolean;
}) {
  return (
    <div
      className="overflow-hidden rounded-lg border border-slate-800 bg-slate-900/30"
      {...liveRegion("Loading table", presentational)}
    >
      <div
        className="animate-pulse border-b border-slate-800 bg-slate-800/50"
        style={{ height: SWAPS_TABLE_HEADER_HEIGHT_PX }}
      />
      <div className="divide-y divide-slate-800/50">
        {Array.from({ length: rows }, (_, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <div
            key={`skel-swap-row-${i}`}
            className="animate-pulse bg-slate-800/30"
            style={{ height: SWAPS_TABLE_ROW_HEIGHT_PX }}
          />
        ))}
      </div>
      {!presentational && <span className="sr-only">Loading…</span>}
    </div>
  );
}
