import { TableSkeleton } from "@/components/skeletons";
import { CDP_OVERVIEW_TABLE_PAGE_SIZE } from "../_lib/transactions";

// Loading-state placeholders for the /cdps overview page (issue #1220,
// 2026-07-10 production skeleton-parity audit). The page-level gate in
// `cdps-page-client.tsx` used to collapse the whole page into six bare 40px
// bars that were replaced in one repaint by the real ~2,100px layout. These
// pieces mirror the loaded section shapes (market-card grid, activity
// digest, transactions table) so the swap doesn't collapse the subtree.
//
// `CdpTransactionsBodySkeleton` is shared between the page-level skeleton
// (nested, presentational) and `CdpAllTransactionsTable`'s own Suspense
// fallback + internal SWR loading branch (standalone, its own live region)
// so all three call sites render the identical shape.

const SHIMMER = "animate-pulse rounded bg-slate-800/50";

type SkeletonAriaProps = {
  // When true, strips role/aria-live from this component so a parent
  // (e.g. the page-level skeleton) can provide a single live-region
  // wrapper instead of each child announcing independently.
  presentational?: boolean;
};

function liveRegion(
  label: string,
  presentational: boolean | undefined,
): Record<string, string> {
  if (presentational) return {};
  return { role: "status", "aria-live": "polite", "aria-label": label };
}

// Mirrors CdpMarketCard: p-4 card, text-xl title + 2-line activity subtitle
// + a health-badge pill, then a `grid grid-cols-2 gap-3` of 4 metric blocks
// (label + value bars). Card ≈212px (production audit).
function CdpMarketCardSkeleton() {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className={`h-7 w-20 ${SHIMMER}`} />
          <div className={`mt-2 h-4 w-32 ${SHIMMER}`} />
          <div className={`mt-1 h-4 w-40 ${SHIMMER}`} />
        </div>
        <div className={`h-5 w-16 rounded ${SHIMMER}`} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <div key={`skel-metric-${i}`}>
            <div className={`h-3 w-16 ${SHIMMER}`} />
            <div className={`mt-1 h-4 w-20 ${SHIMMER}`} />
          </div>
        ))}
      </div>
    </div>
  );
}

// Mirrors the real market grid: `grid grid-cols-1 md:grid-cols-3 gap-4` of
// 3 CdpMarketCard instances (current CDP collateral count).
export function CdpMarketCardGridSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {Array.from({ length: 3 }, (_, i) => (
        // react-doctor-disable-next-line react-doctor/no-array-index-as-key
        <CdpMarketCardSkeleton key={`skel-market-card-${i}`} />
      ))}
    </div>
  );
}

// Mirrors CdpActivityDigest: `rounded-lg border bg-slate-950/60 p-4` card,
// heading + subtitle line, then table-shaped content bars (one per market
// row). ≈245px (production audit).
export function CdpActivityDigestSkeleton() {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
      <div className={`h-6 w-36 ${SHIMMER}`} />
      <div className={`mt-1 h-4 w-64 ${SHIMMER}`} />
      <div className="mt-4 space-y-2">
        {Array.from({ length: 3 }, (_, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <div key={`skel-digest-row-${i}`} className={`h-6 ${SHIMMER}`} />
        ))}
      </div>
    </div>
  );
}

// Mirrors OverviewFilterBar: type-pill row, market-pill row, and the
// free-text address input row.
function CdpTxFilterBarSkeleton() {
  return (
    <div className="mb-3 space-y-2">
      <div className={`h-5 w-64 ${SHIMMER}`} />
      <div className={`h-5 w-48 ${SHIMMER}`} />
      <div className={`h-6 w-72 ${SHIMMER}`} />
    </div>
  );
}

// Shared skeleton body for the "Recent CDP Transactions" section: filter
// bar + a table-shaped placeholder at `CDP_OVERVIEW_TABLE_PAGE_SIZE` rows
// (the table's real first-page size, referenced rather than a diverging
// hardcoded number) + a pagination-footer placeholder. Used by both
// `CdpTransactionsSection`'s Suspense fallback and
// `CdpAllTransactionsTable`'s internal SWR loading branch so the
// fallback→internal-loading handoff is pixel-identical.
export function CdpTransactionsBodySkeleton({
  presentational,
}: SkeletonAriaProps) {
  return (
    <div {...liveRegion("Loading transactions", presentational)}>
      <CdpTxFilterBarSkeleton />
      <TableSkeleton
        variant="rows"
        rows={CDP_OVERVIEW_TABLE_PAGE_SIZE}
        presentational
      />
      <div className="flex items-center justify-between px-1 pt-2 pb-1">
        <div className={`h-4 w-24 ${SHIMMER}`} />
      </div>
    </div>
  );
}
