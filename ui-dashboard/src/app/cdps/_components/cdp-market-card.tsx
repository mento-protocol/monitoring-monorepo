import Link from "next/link";
import type { CdpCollateral, CdpInstance } from "../_lib/types";
import { type CdpAggregates, deriveCdpHealth } from "../_lib/health";
import {
  cdpSymbolSlug,
  formatAggregateAmount,
  formatTokenAmount,
} from "../_lib/format";
import { CdpHealthBadge } from "./cdp-health-badge";

export function CdpMarketCard({
  collateral,
  instance,
  aggregates,
}: {
  collateral: CdpCollateral;
  instance: CdpInstance | undefined;
  aggregates: CdpAggregates;
}) {
  const health = deriveCdpHealth(collateral, instance, aggregates);
  return (
    <Link
      href={`/cdps/${cdpSymbolSlug(collateral.symbol)}`}
      className="block rounded-lg border border-slate-800 bg-slate-950/60 p-4 hover:border-indigo-500 transition-colors"
    >
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-xl font-semibold text-white">
            {collateral.symbol}
          </h2>
          <p className="text-sm text-slate-400">USDm-backed CDP market</p>
        </div>
        <CdpHealthBadge health={health} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Metric
          label="System Debt"
          value={formatAggregateAmount(
            aggregates.totalDebt,
            collateral.symbol,
            aggregates.truncated,
          )}
        />
        <Metric
          label="System Collateral"
          value={formatTokenAmount(instance?.systemColl, "USDm")}
        />
        <Metric
          label="Stability Pool"
          value={formatTokenAmount(instance?.spDeposits, collateral.symbol)}
        />
        <Metric
          label="Open Troves"
          value={
            instance == null
              ? "—"
              : `${aggregates.truncated ? "≥" : ""}${aggregates.openTroveCount}`
          }
        />
      </div>
    </Link>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-semibold text-white">{value}</p>
    </div>
  );
}
