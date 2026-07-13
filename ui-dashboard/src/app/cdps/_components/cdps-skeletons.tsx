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
// heading + subtitle line (h2/p line-height rhythm, ~52px), then a
// table-shaped block — a thead-height header bar plus one body-row bar per
// market (real `td`s use `py-2`, ~35-36px per row). ≈254px, within
// tolerance of the ≈245px production audit measurement.
export function CdpActivityDigestSkeleton() {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
      <div className={`h-7 w-36 ${SHIMMER}`} />
      <div className={`mt-1 h-5 w-64 ${SHIMMER}`} />
      <div className="mt-4 space-y-1">
        <div className={`h-8 ${SHIMMER}`} />
        {Array.from({ length: 3 }, (_, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <div key={`skel-digest-row-${i}`} className={`h-9 ${SHIMMER}`} />
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

// The shared `TableSkeleton` (src/components/skeletons.tsx) reserves a
// 36px header + 44px rows — the measured rhythm for the pool/pool-row
// tables it was built for. The cdps overview table runs a different
// rhythm: badge + market-link cells wrap at 1440px on some rows, and the
// header wraps a "Block" column. Production audit (2026-07-14, 1440x900,
// live data): thead ~45px, tbody rows average ~47px. Composed locally
// with `TableSkeleton`'s own rows-variant markup rather than reusing it,
// since its 36/44 constants are shared with other tables and shouldn't
// bend to this table's geometry.
const CDP_TX_TABLE_HEADER_HEIGHT_PX = 45;
const CDP_TX_TABLE_ROW_HEIGHT_PX = 47;

function CdpTxTableSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-800 bg-slate-900/30">
      <div
        className="animate-pulse border-b border-slate-800 bg-slate-800/50"
        style={{ height: CDP_TX_TABLE_HEADER_HEIGHT_PX }}
      />
      <div className="divide-y divide-slate-800/50">
        {Array.from({ length: CDP_OVERVIEW_TABLE_PAGE_SIZE }, (_, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <div
            key={`skel-tx-row-${i}`}
            className="animate-pulse bg-slate-800/30"
            style={{ height: CDP_TX_TABLE_ROW_HEIGHT_PX }}
          />
        ))}
      </div>
    </div>
  );
}

// Mirrors the two-piece footer under the table: `OverviewFootnotes`'s
// "Showing X-Y of Z" line (`px-1 pt-2`, ~24px) and `Pagination`'s own
// `px-1 pt-2 pb-1` row holding the page-count text plus the 4 nav
// buttons (~36px) — the overview table almost always has more than one
// page of results in production, so the nav row is present far more
// often than not. Replaces a single generic bar that undercounted this
// chrome by roughly half.
function CdpTxFooterSkeleton() {
  return (
    <>
      <div className="px-1 pt-2">
        <div className={`h-4 w-56 ${SHIMMER}`} />
      </div>
      <div className="flex items-center justify-between px-1 pt-2 pb-1">
        <div className={`h-4 w-20 ${SHIMMER}`} />
        <div className={`h-6 w-40 ${SHIMMER}`} />
      </div>
    </>
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
      <CdpTxTableSkeleton />
      <CdpTxFooterSkeleton />
    </div>
  );
}
