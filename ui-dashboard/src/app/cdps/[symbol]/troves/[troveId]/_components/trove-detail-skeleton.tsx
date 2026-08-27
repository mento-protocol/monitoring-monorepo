import { TableSkeleton } from "@/components/skeletons";

// Header card + totals + op-list skeleton matching the loaded grid
// (trove-header-card.tsx / trove-lifetime-totals.tsx / trove-operations-list.tsx).
// Single source of truth for this route's loading geometry: the route's
// `loading.tsx` Suspense fallback (initial navigation) and
// `trove-detail-client.tsx`'s own SWR loading branches (post-hydration data
// fetch) both render this, so a client-side load never swaps a generic
// bar-list skeleton in over the page-shaped one and back — the geometry jump
// AGENTS.md's skeleton/content parity rule exists to avoid. ARIA live region
// lives on the trailing skeleton block so we don't nest live regions
// (mirrors address-book/[address]/loading.tsx).
//
// Four post-header blocks, matching the sections the loaded view can show:
// the TroveLifetimeTotals | TroveRedemptionQueuePanel two-up row (the totals
// card conditional — only for a trove with redemption/liquidation history —
// and the queue panel always present), the TroveBalanceChart card
// (complete-ledger mode only), and the history section (always present).
// Which trove this is — and whether the live schema serves the complete
// ledger — isn't known until data resolves, so the totals and chart blocks
// are reserved unconditionally; a trove without that history (or an interim
// view without a chart) loses a placeholder when it resolves, which is a
// smaller mismatch than the alternative — a whole card appearing with no
// skeleton anticipating it.

const SHIMMER = "animate-pulse rounded bg-slate-800/50";

/** TroveBalanceChart: title + range-pill row, then the fixed-height plot
 *  area (380px — mirrors TROVE_CHART_HEIGHT_PX in trove-balance-chart.tsx,
 *  which keeps that height for both its two- and three-panel layouts). No
 *  live region — the trailing history block announces loading for the
 *  whole page. */
function ChartCardSkeleton() {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <div className={`h-4 w-48 ${SHIMMER}`} />
          <div className={`h-3 w-72 max-w-full ${SHIMMER}`} />
        </div>
        <div className={`h-6 w-40 ${SHIMMER}`} />
      </div>
      <div className={`mt-4 ${SHIMMER}`} style={{ height: 380 }} />
    </div>
  );
}

export function TroveDetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className={`h-4 w-32 ${SHIMMER}`} />
      <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
        {/* `justify-between` + a third bar: the loaded header puts the
            "Manage in app ↗" link on the far right of this row (separate
            flex child from the h1), not bunched left with the title/status
            bar — reserving it lets flex-wrap behave the same loading and
            loaded at narrow widths. */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className={`h-7 w-64 ${SHIMMER}`} />
            <div className={`h-5 w-16 ${SHIMMER}`} />
          </div>
          <div className={`h-5 w-32 ${SHIMMER}`} />
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
          {/* 7 stats (owner/opened/closed-or-updated/rate/coll/debt/icr) —
              matches TroveHeaderStats exactly, so the `lg` 6-col grid wraps
              the same way loading and loaded: the 7th (ICR) starts a second
              row in both, instead of the skeleton reserving only one row and
              the loaded card growing when data resolves. */}
          {Array.from({ length: 7 }, (_, i) => (
            // react-doctor-disable-next-line react-doctor/no-array-index-as-key
            <div key={`trove-header-skel-${i}`}>
              <div className={`h-3 w-16 ${SHIMMER}`} />
              <div className={`mt-1 h-4 w-20 ${SHIMMER}`} />
            </div>
          ))}
        </div>
        {/* Reserves TroveHeaderCard's unconditional `mt-4` footer paragraph
            (always renders — "Values shown are indexed as of..." — and can
            grow a second sentence for a batch-managed rate). Without this,
            the header grows by at least one line the moment data resolves,
            even with the stat count and grid now matching exactly. */}
        <div className="mt-4 space-y-1.5">
          <div className={`h-3 w-full max-w-2xl ${SHIMMER}`} />
          <div className={`h-3 w-2/3 max-w-md ${SHIMMER}`} />
        </div>
      </div>
      {/* Mirrors the loaded view's totals | queue two-up grid exactly, so
          the row splits into two columns at the same breakpoint loading and
          loaded. */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 space-y-3">
          <div className={`h-4 w-56 ${SHIMMER}`} />
          {/* TroveLifetimeTotals's description is three sentences — two lines
              approximates its wrapped height better than one. */}
          <div className="space-y-1.5">
            <div className={`h-3 w-full max-w-md ${SHIMMER}`} />
            <div className={`h-3 w-1/2 max-w-xs ${SHIMMER}`} />
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            {/* 7 cells: the loaded card's maximum shape, not its minimum — 4
                redemption stats + 2 liquidation stats + the optional
                collateral-surplus cell, all of which can render together for
                a trove that was partially redeemed and later liquidated.
                Reserving fewer would still under-count that combined case. */}
            {Array.from({ length: 7 }, (_, i) => (
              // react-doctor-disable-next-line react-doctor/no-array-index-as-key
              <div key={`trove-totals-skel-${i}`}>
                <div className={`h-3 w-20 ${SHIMMER}`} />
                <div className={`mt-1 h-4 w-16 ${SHIMMER}`} />
              </div>
            ))}
          </div>
        </div>
        {/* TroveRedemptionQueuePanel: title, two-line explainer, and a
            ladder-shaped block (the panel's own post-hydration loading state
            renders the same bar rhythm). No live region here — the trailing
            operations block below announces loading for the whole page. */}
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 space-y-3">
          <div className={`h-4 w-40 ${SHIMMER}`} />
          <div className="space-y-1.5">
            <div className={`h-3 w-full max-w-md ${SHIMMER}`} />
            <div className={`h-3 w-2/3 max-w-xs ${SHIMMER}`} />
          </div>
          <div className="space-y-2">
            <div className={`h-3 w-full max-w-sm ${SHIMMER}`} />
            <div className={`h-3 w-full ${SHIMMER}`} />
            <div className={`h-3 w-5/6 ${SHIMMER}`} />
            <div className={`h-3 w-2/3 ${SHIMMER}`} />
          </div>
        </div>
      </div>
      <ChartCardSkeleton />
      <div
        className="space-y-3"
        role="status"
        aria-live="polite"
        aria-label="Loading trove"
      >
        <div className={`h-5 w-40 ${SHIMMER}`} />
        {/* The partial-view notice is two sentences and commonly wraps to
            two lines. */}
        <div className="space-y-1.5">
          <div className={`h-3 w-full max-w-lg ${SHIMMER}`} />
          <div className={`h-3 w-2/3 max-w-sm ${SHIMMER}`} />
        </div>
        {/* Mirrors TroveOperationsList's own loading branch exactly
            (TableSkeleton, variant="rows") — this route-level fallback and
            that component's post-hydration loading state must render the
            same shape, or navigation swaps structurally different subtrees
            right before the real table appears. `presentational`: the
            surrounding `role="status"` above already covers this block, so
            it doesn't announce a second nested live region. */}
        <TableSkeleton rows={4} variant="rows" presentational />
      </div>
    </div>
  );
}
