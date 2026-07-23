// Shared table-skeleton rhythm for `GlobalPoolsTable`. Every surface that
// stands in for it — the home route fallback (`(home)/loading.tsx`), the
// homepage's own client-side loading branch (`page-client.tsx`), the /pools
// route fallback (`pools/loading.tsx`), and the /pools client-side loading
// branch (`pools/_components/pools-page-client.tsx`) — must reserve the same
// measured geometry, or a slow resolve reproduces the CLS regression this
// component exists to fix on whichever surface was left behind.
//
// Lives outside any route's `_components/` (not inside
// `app/pools/_components/`) because `dashboard-route-private-pools`
// (`.dependency-cruiser.cjs`) forbids code outside `app/pools/` — including
// the home route group and root `page-client.tsx` — from importing it.
//
// Production audit (2026-07-14, 1440x900, live data, 27 pools): the global
// pools table (`global-pools-table/pool-row.tsx`) measures thead 45px, body
// rows 58px — taller than the shared `TableSkeleton`'s 36px/44px
// (`src/components/skeletons.tsx`) because `TvlCell` stacks a TVL value line
// + a WoW-change sub-line inside every row. Composed locally (not through
// `TableSkeleton`) so this number doesn't bend the shared component's
// calibration for the tables it already serves — same approach as
// `pools/_components/pools-skeletons.tsx`'s `SwapsTableSkeleton` and
// `cdps/_components/cdps-skeletons.tsx`'s `CdpTxTableSkeleton`.
// `skeletons.tsx` stays untouched.

// The pools table's row source (`buildGlobalPoolEntries`, fed by
// `useAllNetworksData`) is runtime GraphQL data from the indexer per chain,
// not a static list — @mento-protocol/config has no pool registry to derive
// a count from statically. 27 approximates the current live pool count
// (repo guidance: ~30-50 pools at current scale); nudge this constant if the
// live count drifts materially from that.
export const POOLS_TABLE_SKELETON_ROWS = 27;

const POOLS_TABLE_HEADER_HEIGHT_PX = 45;
const POOLS_TABLE_ROW_HEIGHT_PX = 58;

function liveRegion(
  presentational: boolean | undefined,
): Record<string, string> {
  if (presentational) return {};
  return {
    role: "status",
    "aria-live": "polite",
    "aria-label": "Loading table",
  };
}

export function PoolsTableSkeleton({
  presentational,
  showFilters = false,
}: {
  /** True when a parent already provides the live region (route fallback). */
  presentational?: boolean;
  /** Reserves the homepage-only name and chain-filter toolbar. */
  showFilters?: boolean;
} = {}) {
  return (
    <div {...liveRegion(presentational)}>
      {showFilters && (
        <div className="mb-2 h-[28px] animate-pulse rounded bg-slate-800/30" />
      )}
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
      {!presentational && <span className="sr-only">Loading…</span>}
    </div>
  );
}
