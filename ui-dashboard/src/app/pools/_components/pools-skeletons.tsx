// Local table-skeleton rhythms for /pools that diverge from the shared
// `TableSkeleton`'s 36px header / 44px row geometry
// (`src/components/skeletons.tsx`). Production audit (2026-07-14, 1440x900,
// live data, 27 pools / 25 swaps):
//  - Global pools table (`global-pools-table/pool-row.tsx`): thead 45px,
//    body rows 58px — taller than the shared rhythm because `TvlCell`
//    stacks a TVL value line + a WoW-change sub-line inside every row.
//  - Recent Swaps table (`SwapTable` in `pools-page-client.tsx`): thead
//    45px, body rows 37px — shorter than the shared rhythm; every cell is
//    single-line.
// Composed locally (not through `TableSkeleton`) so these numbers don't bend
// the shared component's calibration for the tables it already serves —
// same approach as `cdps/_components/cdps-skeletons.tsx`'s
// `CdpTxTableSkeleton`. `skeletons.tsx` stays untouched.

// The pools table's row source (`buildGlobalPoolEntries`, fed by
// `useAllNetworksData`) is runtime GraphQL data from the indexer per chain,
// not a static list — @mento-protocol/config has no pool registry to derive
// a count from statically. 27 approximates the current live pool count
// (repo guidance: ~30-50 pools at current scale); nudge this constant if the
// live count drifts materially from that.
export const POOLS_TABLE_SKELETON_ROWS = 27;

const POOLS_TABLE_HEADER_HEIGHT_PX = 45;
const POOLS_TABLE_ROW_HEIGHT_PX = 58;
const SWAPS_TABLE_HEADER_HEIGHT_PX = 45;
const SWAPS_TABLE_ROW_HEIGHT_PX = 37;

function liveRegion(
  label: string,
  presentational: boolean | undefined,
): Record<string, string> {
  if (presentational) return {};
  return { role: "status", "aria-live": "polite", "aria-label": label };
}

// Always presentational: both current call sites nest this inside a single
// outer live region (`pools/loading.tsx`'s page-level wrapper) rather than
// announcing on their own.
export function PoolsTableSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-800 bg-slate-900/30">
      <div
        className="animate-pulse border-b border-slate-800 bg-slate-800/50"
        style={{ height: POOLS_TABLE_HEADER_HEIGHT_PX }}
      />
      <div className="divide-y divide-slate-800/50">
        {Array.from({ length: POOLS_TABLE_SKELETON_ROWS }, (_, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <div
            key={`skel-pool-row-${i}`}
            className="animate-pulse bg-slate-800/30"
            style={{ height: POOLS_TABLE_ROW_HEIGHT_PX }}
          />
        ))}
      </div>
    </div>
  );
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
