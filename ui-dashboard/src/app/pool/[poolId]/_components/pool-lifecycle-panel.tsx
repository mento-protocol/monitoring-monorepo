"use client";

import { Stat } from "@/components/stat";
import { useNetwork } from "@/components/network-provider";
import { useGQL } from "@/lib/graphql";
import { hasErrorWithoutData, isLoadingWithoutData } from "@/lib/swr-state";
import { formatTimestamp, relativeTime, truncateAddress } from "@/lib/format";
import { VIRTUAL_POOL_LIFECYCLE } from "@/lib/queries";
import type { Pool, VirtualPoolLifecycle } from "@/lib/types";

/**
 * Deploy / deprecation timeline for VirtualPools. The factory always emits
 * a DEPLOYED row; DEPRECATED is appended once governance removes the
 * underlying v2 exchange.
 */
export function PoolLifecyclePanel({ pool }: { pool: Pool }) {
  const { network } = useNetwork();
  const { data, isLoading, error } = useGQL<{
    VirtualPoolLifecycle: VirtualPoolLifecycle[];
  }>(VIRTUAL_POOL_LIFECYCLE, { poolId: pool.id });

  const rows = data?.VirtualPoolLifecycle ?? [];

  if (isLoadingWithoutData(isLoading, data)) {
    return <LifecycleSkeleton />;
  }
  // Surface fetch failure explicitly. Without this, a Hasura schema lag /
  // transient outage collapses to `rows = []` and the whole lifecycle
  // section disappears as if the pool had no records — operators can't
  // tell "no data yet" from "fetch failed."
  if (hasErrorWithoutData(error, data)) {
    return (
      <p className="text-sm text-slate-500">
        Lifecycle unavailable: {error.message}
      </p>
    );
  }
  const deployed = rows.find((r) => r.action === "DEPLOYED");
  const deprecated = rows.find((r) => r.action === "DEPRECATED");

  if (!deployed && !deprecated) return null;

  const explorerTx = (txHash: string) =>
    `${network.explorerBaseUrl}/tx/${txHash}`;

  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm sm:grid-cols-3">
      {deployed && (
        <>
          <Stat
            label="Deployed"
            value={
              <a
                href={explorerTx(deployed.txHash)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-300 hover:text-indigo-400 transition-colors"
                title={formatTimestamp(deployed.blockTimestamp)}
              >
                {relativeTime(deployed.blockTimestamp)}
              </a>
            }
          />
          <Stat
            label="Factory"
            value={
              <a
                href={`${network.explorerBaseUrl}/address/${deployed.factoryAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-300 hover:text-indigo-400 font-mono transition-colors"
              >
                {truncateAddress(deployed.factoryAddress)}
              </a>
            }
          />
        </>
      )}
      {deprecated && (
        <Stat
          label={<span className="text-amber-300">Deprecated</span>}
          value={
            <a
              href={explorerTx(deprecated.txHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-amber-300 hover:text-amber-200 transition-colors"
              title={formatTimestamp(deprecated.blockTimestamp)}
            >
              {relativeTime(deprecated.blockTimestamp)}
            </a>
          }
        />
      )}
    </dl>
  );
}

const LIFECYCLE_SKELETON_SHIMMER = "animate-pulse rounded bg-slate-800/50";
// The factory always emits a DEPLOYED row (Deployed + Factory Stat cells);
// the DEPRECATED cell is only appended once governance removes the
// underlying v2 exchange. Reserve for the guaranteed-present 2-cell shape.
const LIFECYCLE_STAT_COUNT = 2;

// Mirrors the loaded shape once the always-present DEPLOYED row resolves:
// identical `<dl>` grid classes plus one placeholder cell per guaranteed
// stat, so the header card doesn't grow once VirtualPoolLifecycle resolves.
// Same label/value Stat convention as `header-card-skeleton.tsx` (h-4 label
// + mt-1 h-5 value = 40px) — this dl uses the same container classes and
// `Stat` component as that grid.
//
// Accepted tradeoff, same shape as BreakerPanel: the (defensive-only, per
// the factory-always-emits-DEPLOYED invariant above) `!deployed &&
// !deprecated` branch still renders `null` rather than reserving this
// grid's height.
function LifecycleSkeleton() {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm sm:grid-cols-3">
      {Array.from({ length: LIFECYCLE_STAT_COUNT }, (_, i) => (
        // react-doctor-disable-next-line react-doctor/no-array-index-as-key
        <div key={`lifecycle-skel-stat-${i}`}>
          <div className={`h-4 w-16 ${LIFECYCLE_SKELETON_SHIMMER}`} />
          <div className={`mt-1 h-5 w-20 ${LIFECYCLE_SKELETON_SHIMMER}`} />
        </div>
      ))}
    </dl>
  );
}
