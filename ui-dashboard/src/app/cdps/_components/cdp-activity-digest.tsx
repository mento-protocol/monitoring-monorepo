import { CdpHealthBadge } from "./cdp-health-badge";
import { type CdpAggregates, deriveCdpHealth } from "../_lib/health";
import type {
  CdpActivitySummary,
  CdpMarketActivity,
} from "../_lib/transactions";
import { EMPTY_CDP_MARKET_ACTIVITY } from "../_lib/transactions";
import type { CdpCollateral, CdpInstance } from "../_lib/types";

export function CdpActivityDigest({
  collaterals,
  instances,
  aggregatesByCollateral,
  queryTruncated,
  activityByInstance,
  totalActivity,
  activityCapped,
  activityLoading,
  activityHasError,
}: {
  collaterals: CdpCollateral[];
  instances: Map<string, CdpInstance>;
  aggregatesByCollateral: Map<string, CdpAggregates>;
  queryTruncated: boolean;
  activityByInstance: Map<string, CdpMarketActivity>;
  totalActivity: CdpActivitySummary;
  activityCapped: boolean;
  activityLoading: boolean;
  activityHasError: boolean;
}) {
  const activityUnavailable = activityLoading || activityHasError;
  const summaryText = activityUnavailable
    ? "Last 24h: activity unavailable"
    : `Last 24h: ${countLabel(totalActivity.total24h, "operation", activityCapped)} · ${countLabel(totalActivity.liquidations24h, "liquidation")} · ${countLabel(totalActivity.userRedemptions24h, "redemption")}`;

  return (
    <section
      aria-labelledby="cdp-activity-digest-heading"
      className="rounded-lg border border-slate-800 bg-slate-950/60 p-4"
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2
            id="cdp-activity-digest-heading"
            className="text-lg font-semibold text-white"
          >
            24h CDP activity
          </h2>
          <p className="mt-1 text-sm text-slate-400">{summaryText}</p>
        </div>
        {activityCapped ? (
          <p className="text-xs text-amber-400" role="status">
            Counts may be incomplete because the fetched event window is capped.
          </p>
        ) : null}
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-slate-500">
              <th className="py-2 pr-4">Market</th>
              <th className="py-2 pr-4">Health</th>
              <th className="py-2 pr-4 text-right">Liquidations</th>
              <th className="py-2 pr-4 text-right">Redemptions</th>
              <th className="py-2 pr-4 text-right">Rebalances</th>
              <th className="py-2 text-right">Other ops</th>
            </tr>
          </thead>
          <tbody>
            {collaterals.map((collateral) => {
              const instance = instances.get(collateral.id);
              const aggregates = aggregatesByCollateral.get(collateral.id) ?? {
                openTroveCount: 0,
                truncated: queryTruncated,
              };
              const activity = activityUnavailable
                ? null
                : (activityByInstance.get(collateral.id) ??
                  EMPTY_CDP_MARKET_ACTIVITY);
              return (
                <tr
                  key={collateral.id}
                  className="border-t border-slate-800/60"
                >
                  <td className="py-2 pr-4 font-medium text-slate-100">
                    {collateral.symbol}
                  </td>
                  <td className="py-2 pr-4">
                    <CdpHealthBadge
                      health={deriveCdpHealth(collateral, instance)}
                    />
                    {aggregates.truncated ? (
                      <span className="ml-2 text-xs text-amber-400">
                        Trove count capped
                      </span>
                    ) : null}
                  </td>
                  <DigestNumber value={activity?.liquidations24h} />
                  <DigestNumber value={activity?.userRedemptions24h} />
                  <DigestNumber value={rebalanceCount(activity)} />
                  <DigestNumber value={otherOpsCount(activity)} isLast />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DigestNumber({
  value,
  isLast,
}: {
  value: number | undefined;
  isLast?: boolean;
}) {
  const isUnavailable = value === undefined;
  return (
    <td
      className={[
        "py-2 text-right tabular-nums",
        isLast ? "" : "pr-4",
        !isUnavailable && value > 0 ? "text-slate-100" : "text-slate-500",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {isUnavailable ? "—" : value.toLocaleString()}
    </td>
  );
}

function rebalanceCount(
  activity: CdpMarketActivity | null,
): number | undefined {
  if (activity === null) return undefined;
  return activity.rebalanceRedemptions24h + activity.spRebalances24h;
}

function otherOpsCount(activity: CdpMarketActivity | null): number | undefined {
  if (activity === null) return undefined;
  return activity.stabilityPoolOps24h + activity.troveOps24h;
}

function countLabel(value: number, singular: string, capped = false): string {
  const label = value === 1 ? singular : `${singular}s`;
  return `${capped ? "≥" : ""}${value.toLocaleString()} ${label}`;
}
