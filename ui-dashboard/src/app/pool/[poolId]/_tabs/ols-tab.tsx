"use client";

import { ErrorBox, Skeleton } from "@/components/feedback";
import { useNetwork } from "@/components/network-provider";
import { useGQL } from "@/lib/graphql";
import { OLS_POOL } from "@/lib/queries";
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

  if (olsErr) return <ErrorBox message={olsErr.message} />;
  if (olsLoading) return <Skeleton rows={3} />;

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
