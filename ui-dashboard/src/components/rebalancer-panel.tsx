"use client";

import type { Pool, RebalanceEvent } from "@/lib/types";
import { RebalancerBadge } from "@/components/badges";
import { computeRebalancerLiveness } from "@/lib/health";
import { relativeTime, formatTimestamp, truncateAddress } from "@/lib/format";
import { TxHashCell } from "@/components/tx-hash-cell";
import { Table, Row, Th, Td } from "@/components/table";

interface RebalancerPanelProps {
  pool: Pool;
  rebalances: RebalanceEvent[];
}

export function RebalancerPanel({ pool, rebalances }: RebalancerPanelProps) {
  const isVirtual = pool.source?.includes("virtual");
  const nowSeconds = Math.floor(Date.now() / 1000);
  const livenessStatus = computeRebalancerLiveness(pool, nowSeconds);

  const formatEffectiveness = (ratio: string | undefined) => {
    if (!ratio) return "—";
    const pct = Number(ratio) * 100;
    return `${pct.toFixed(1)}%`;
  };

  const formatImprovement = (val: string | undefined) => {
    if (!val) return "—";
    return val;
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-base font-semibold text-white">Rebalancer</h2>
        <RebalancerBadge status={livenessStatus} />
      </div>

      {isVirtual ? (
        <p className="text-sm text-slate-400">
          VirtualPool — rebalancer not applicable.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-slate-400 mb-1">Rebalancer Address</dt>
              <dd className="text-white font-mono">
                {pool.rebalancerAddress && pool.rebalancerAddress !== "" ? (
                  <a
                    href={`https://celoscan.io/address/${pool.rebalancerAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-indigo-400 hover:text-indigo-300"
                  >
                    {truncateAddress(pool.rebalancerAddress)}
                  </a>
                ) : (
                  <span className="text-slate-500">—</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400 mb-1">Last Rebalanced</dt>
              <dd
                className="text-white"
                title={
                  pool.lastRebalancedAt && pool.lastRebalancedAt !== "0"
                    ? formatTimestamp(pool.lastRebalancedAt)
                    : undefined
                }
              >
                {pool.lastRebalancedAt && pool.lastRebalancedAt !== "0" ? (
                  relativeTime(pool.lastRebalancedAt)
                ) : (
                  <span className="text-slate-500">Never</span>
                )}
              </dd>
            </div>
          </dl>

          {rebalances.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-slate-400 mb-2">
                Rebalance History (last {rebalances.length})
              </h3>
              <Table>
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-900/50">
                    <Th>Time</Th>
                    <Th align="right">Effectiveness</Th>
                    <Th align="right">Improvement</Th>
                    <Th>Tx</Th>
                  </tr>
                </thead>
                <tbody>
                  {rebalances.map((r) => (
                    <Row key={r.id}>
                      <Td small muted title={formatTimestamp(r.blockTimestamp)}>
                        {relativeTime(r.blockTimestamp)}
                      </Td>
                      <Td mono small align="right">
                        {formatEffectiveness(r.effectivenessRatio)}
                      </Td>
                      <Td mono small align="right">
                        {formatImprovement(r.improvement)}
                      </Td>
                      <TxHashCell txHash={r.txHash} />
                    </Row>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
