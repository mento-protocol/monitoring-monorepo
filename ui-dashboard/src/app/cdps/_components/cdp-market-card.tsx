import Link from "next/link";
import type { CdpCollateral, CdpInstance } from "../_lib/types";
import { cdpSymbolSlug, formatTokenAmount } from "../_lib/format";

export function CdpMarketCard({
  collateral,
  instance,
}: {
  collateral: CdpCollateral;
  instance: CdpInstance | undefined;
}) {
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
        <span className="text-xs rounded border border-slate-700 px-2 py-1 text-slate-300">
          {instance?.isShutDown ? "Shutdown" : "Live"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Metric
          label="System Debt"
          value={formatTokenAmount(instance?.systemDebt, collateral.symbol)}
        />
        <Metric
          label="System Collateral"
          value={formatTokenAmount(instance?.systemColl, "USDm")}
        />
        <Metric
          label="SP Headroom"
          value={formatTokenAmount(instance?.spHeadroom, collateral.symbol)}
        />
        <Metric
          label="Active Troves"
          value={instance == null ? "—" : String(instance.activeTroveCount)}
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
