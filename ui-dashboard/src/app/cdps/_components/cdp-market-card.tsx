import Link from "next/link";
import type { CdpCollateral, CdpInstance } from "../_lib/types";
import {
  type CdpAggregates,
  type CdpHealth,
  deriveCdpHealth,
  healthBadgeClasses,
} from "../_lib/health";
import { cdpSymbolSlug, formatTokenAmount } from "../_lib/format";

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
        <HealthBadge health={health} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Metric
          label="System Debt"
          value={formatTokenAmount(
            aggregates.totalDebt.toString(),
            collateral.symbol,
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
          value={instance == null ? "—" : String(aggregates.openTroveCount)}
        />
      </div>
    </Link>
  );
}

function HealthBadge({ health }: { health: CdpHealth }) {
  const cls = healthBadgeClasses(health.state);
  const title = health.reasons.join(" · ") || health.label;
  return (
    <span
      className={`text-xs rounded px-2 py-1 font-medium ${cls}`}
      title={title}
      aria-label={`Health: ${health.label}. ${title}`}
    >
      {health.label}
    </span>
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
