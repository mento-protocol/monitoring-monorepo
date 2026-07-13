"use client";

import { ErrorBox } from "@/components/feedback";
import { useNetwork } from "@/components/network-provider";
import { TableSkeleton } from "@/components/skeletons";
import { useGQL } from "@/lib/graphql";
import { OLS_POOL } from "@/lib/queries";
import { hasErrorWithoutData, isLoadingWithoutData } from "@/lib/swr-state";
import type { OlsPool, Pool } from "@/lib/types";
import { OlsLiquidityEvents } from "../_components/ols-liquidity-events";
import { OlsStatusPanel } from "../_components/ols-status-panel";
import { selectActiveOlsPool } from "../_lib/helpers";

export function OlsTab({
  poolId,
  limit,
  pool,
  search,
  onSearchChange,
}: {
  poolId: string;
  limit: number;
  pool: Pool | null;
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const { network } = useNetwork();
  // Re-fetches OLS_POOL even though `PoolDetail` already calls it for the
  // tab-visibility check. This is intentional: keeping the tab self-contained
  // means it has its own error/loading branches and doesn't need olsData
  // prop-drilled through the orchestrator. SWR dedupes on the (network.id,
  // query, vars) key, so only one network request actually fires while both
  // are mounted.
  const {
    data: olsData,
    error: olsErr,
    isLoading: olsLoading,
  } = useGQL<{
    OlsPool: OlsPool[];
  }>(OLS_POOL, { poolId });
  const olsPool = selectActiveOlsPool(olsData?.OlsPool);

  if (hasErrorWithoutData(olsErr, olsData))
    return <ErrorBox message={olsErr.message} />;
  if (isLoadingWithoutData(olsLoading, olsData))
    return <OlsTabSkeleton limit={limit} />;

  return (
    <div className="space-y-6">
      <OlsStatusPanel olsPool={olsPool} pool={pool} network={network} />
      <OlsLiquidityEvents
        poolId={poolId}
        olsAddress={olsPool?.olsAddress ?? null}
        limit={limit}
        pool={pool}
        network={network}
        search={search}
        onSearchChange={onSearchChange}
      />
    </div>
  );
}

const OLS_SKELETON_SHIMMER = "animate-pulse rounded bg-slate-800/50";

// Approximates OlsStatusPanel's shape (title+badge row, then 3 labelled
// stat-grid sections) stacked above the liquidity-events table, sized to
// `limit`. The OLS_POOL query resolves whether this pool is registered at
// all, so — unlike the other tabs — the loaded outcome can be much smaller
// (the "not registered" message) than this skeleton; that's an accepted
// asymmetry, matching the checklist's "loading vs empty are distinct" rule.
function OlsTabSkeleton({ limit }: { limit: number }) {
  return (
    <div className="space-y-6">
      <div className="space-y-5 rounded-lg border border-slate-800 bg-slate-900/60 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className={`h-5 w-48 ${OLS_SKELETON_SHIMMER}`} />
          <div className={`h-5 w-16 rounded-full ${OLS_SKELETON_SHIMMER}`} />
        </div>
        {Array.from({ length: 3 }, (_, section) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <div
            key={`ols-skel-section-${section}`}
            className="grid grid-cols-2 gap-4 border-t border-slate-800 pt-4 sm:grid-cols-3"
          >
            {Array.from({ length: 3 }, (_, stat) => (
              <div
                // react-doctor-disable-next-line react-doctor/no-array-index-as-key
                key={`ols-skel-stat-${section}-${stat}`}
              >
                <div className={`h-3 w-16 ${OLS_SKELETON_SHIMMER}`} />
                <div className={`mt-1.5 h-4 w-20 ${OLS_SKELETON_SHIMMER}`} />
              </div>
            ))}
          </div>
        ))}
      </div>
      <TableSkeleton variant="rows" rows={limit} />
    </div>
  );
}
