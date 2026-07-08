import Link from "next/link";
import { relativeTime } from "@/lib/format";
import type { CdpCollateral, CdpInstance } from "../_lib/types";
import { type CdpAggregates, deriveCdpHealth } from "../_lib/health";
import { cdpSymbolSlug, formatTokenAmount } from "../_lib/format";
import {
  EMPTY_CDP_MARKET_ACTIVITY,
  type CdpMarketActivity,
} from "../_lib/transactions";
import { CdpHealthBadge } from "./cdp-health-badge";

export function CdpMarketCard({
  collateral,
  instance,
  aggregates,
  activity24h,
  ops24hCapped,
  ops24hLoading,
  ops24hHasError,
}: {
  collateral: CdpCollateral;
  instance: CdpInstance | undefined;
  aggregates: CdpAggregates;
  activity24h: CdpMarketActivity | undefined;
  ops24hCapped: boolean;
  ops24hLoading: boolean;
  ops24hHasError: boolean;
}) {
  const health = deriveCdpHealth(collateral, instance);
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
          <CardActivitySubtitle
            lastEventTimestamp={instance?.lastEventTimestamp}
            activity24h={activity24h}
            ops24hCapped={ops24hCapped}
            ops24hLoading={ops24hLoading}
            ops24hHasError={ops24hHasError}
          />
        </div>
        <CdpHealthBadge health={health} />
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

function CardActivitySubtitle({
  lastEventTimestamp,
  activity24h,
  ops24hCapped,
  ops24hLoading,
  ops24hHasError,
}: {
  lastEventTimestamp: string | undefined;
  activity24h: CdpMarketActivity | undefined;
  ops24hCapped: boolean;
  ops24hLoading: boolean;
  ops24hHasError: boolean;
}) {
  const lastActivity = lastEventTimestamp
    ? relativeTime(lastEventTimestamp)
    : "—";
  const activity = activity24h ?? EMPTY_CDP_MARKET_ACTIVITY;
  // Loading and error both render `—` so a failed fetch isn't masquerading
  // as a "no activity in 24h" zero. The Recent CDP Transactions table below
  // surfaces the actual error message; the card just stays out of the way.
  const opsLabel =
    ops24hLoading || ops24hHasError
      ? "—"
      : `${ops24hCapped ? "≥" : ""}${activity.total24h}`;
  const detailLabel =
    ops24hLoading || ops24hHasError
      ? "activity unavailable"
      : `${opsLabel} ops · ${activity.liquidations24h} liq · ${activity.redemptions24h} red`;
  return (
    <div className="space-y-0.5 text-sm text-slate-400">
      <p>Last activity {lastActivity}</p>
      <p>24h: {detailLabel}</p>
    </div>
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
