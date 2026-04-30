"use client";

import { AddressLink } from "@/components/address-link";
import type { useNetwork } from "@/components/network-provider";
import { Stat } from "@/components/stat";
import { formatTimestamp, relativeTime, toPercent } from "@/lib/format";
import { tokenSymbol } from "@/lib/tokens";
import type { OlsPool, Pool } from "@/lib/types";
import { getDebtTokenSideLabel } from "../_lib/helpers";

export function OlsStatusPanel({
  olsPool,
  pool,
  network,
}: {
  olsPool: OlsPool | null;
  pool: Pool | null;
  network: ReturnType<typeof useNetwork>["network"];
}) {
  if (!olsPool) {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
        <p className="text-slate-400 text-sm">
          This pool is not registered with the Open Liquidity Strategy.
        </p>
      </div>
    );
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const lastRebalance = Number(olsPool.lastRebalance);
  const cooldown = Number(olsPool.rebalanceCooldown);
  const elapsed = lastRebalance > 0 ? nowSeconds - lastRebalance : null;

  const cooldownReady =
    lastRebalance > 0 && elapsed !== null && elapsed >= cooldown;
  const cooldownActive =
    lastRebalance > 0 && elapsed !== null && elapsed < cooldown;
  const cooldownPct =
    cooldownActive && cooldown > 0
      ? Math.max(0, Math.min((elapsed! / cooldown) * 100, 100))
      : 0;
  const cooldownRemaining = cooldownActive
    ? Math.max(0, cooldown - elapsed!)
    : 0;
  const cooldownH = Math.floor(cooldownRemaining / 3600);
  const cooldownM = Math.floor((cooldownRemaining % 3600) / 60);

  const debtTokenSym = tokenSymbol(network, olsPool.debtToken || null);
  const debtTokenSide = getDebtTokenSideLabel(pool, olsPool.debtToken);

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-base font-semibold text-white">
          Open Liquidity Strategy
        </h3>
        {olsPool.isActive ? (
          <span className="inline-flex items-center rounded-full bg-emerald-900/60 px-2.5 py-0.5 text-xs font-medium text-emerald-300 ring-1 ring-emerald-700/50">
            Active
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-red-900/60 px-2.5 py-0.5 text-xs font-medium text-red-300 ring-1 ring-red-700/50">
            Removed
          </span>
        )}
      </div>

      <dl className="text-sm space-y-4">
        <div>
          <h4 className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">
            Configuration
          </h4>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <Stat
              label="Debt Token"
              value={
                !olsPool.debtToken
                  ? "Unknown"
                  : `${debtTokenSym} (${debtTokenSide})`
              }
            />
            <Stat
              label="Cooldown"
              value={
                cooldown > 0
                  ? `${Math.floor(cooldown / 3600)}h ${Math.floor((cooldown % 3600) / 60)}m`
                  : "None"
              }
            />
            <Stat
              label="OLS Contract"
              value={<AddressLink address={olsPool.olsAddress} />}
            />
          </div>
        </div>

        <div className="border-t border-slate-800 pt-4">
          <h4 className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">
            Activity
          </h4>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <Stat
              label="OLS Rebalances"
              value={String(olsPool.olsRebalanceCount)}
            />
            <Stat
              label="Last Rebalance"
              value={
                lastRebalance > 0
                  ? relativeTime(String(lastRebalance))
                  : "Never"
              }
              title={
                lastRebalance > 0
                  ? formatTimestamp(String(lastRebalance))
                  : undefined
              }
            />
            <Stat
              label="Protocol Fee Recipient"
              value={
                olsPool.protocolFeeRecipient ? (
                  <AddressLink address={olsPool.protocolFeeRecipient} />
                ) : (
                  "Unknown"
                )
              }
            />
            <div className="col-span-2 sm:col-span-3">
              <dt className="text-slate-400 mb-1">Cooldown Status</dt>
              <dd className="text-white">
                {lastRebalance === 0 ? (
                  <span className="text-slate-500">Never rebalanced</span>
                ) : cooldownReady ? (
                  <span className="text-emerald-400">Ready to rebalance</span>
                ) : (
                  <div className="space-y-1">
                    <span>
                      {cooldownH}h {cooldownM}m remaining
                    </span>
                    <div className="w-full max-w-xs h-2 bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-indigo-500 rounded-full transition-all"
                        style={{ width: `${cooldownPct}%` }}
                      />
                    </div>
                  </div>
                )}
              </dd>
            </div>
          </div>
        </div>

        <div className="border-t border-slate-800 pt-4">
          <h4 className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">
            Incentive Structure
          </h4>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Stat
              label="Expansion (Source)"
              value={toPercent(olsPool.liquiditySourceIncentiveExpansion)}
            />
            <Stat
              label="Contraction (Source)"
              value={toPercent(olsPool.liquiditySourceIncentiveContraction)}
            />
            <Stat
              label="Expansion (Protocol)"
              value={toPercent(olsPool.protocolIncentiveExpansion)}
            />
            <Stat
              label="Contraction (Protocol)"
              value={toPercent(olsPool.protocolIncentiveContraction)}
            />
          </div>
        </div>
      </dl>
    </div>
  );
}
