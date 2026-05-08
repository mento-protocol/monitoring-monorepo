"use client";

import { Stat } from "@/components/stat";
import { useNetwork } from "@/components/network-provider";
import { useGQL } from "@/lib/graphql";
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
  const { data, isLoading } = useGQL<{
    VirtualPoolLifecycle: VirtualPoolLifecycle[];
  }>(VIRTUAL_POOL_LIFECYCLE, { poolId: pool.id });

  if (isLoading) {
    return <div className="h-12 animate-pulse rounded-md bg-slate-800/40" />;
  }
  const rows = data?.VirtualPoolLifecycle ?? [];
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
