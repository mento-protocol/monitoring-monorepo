"use client";

import { isVirtualPool, type Pool, type TradingLimit } from "@/lib/types";
import { BrokerLimitPanel } from "@/components/broker-limit-panel";
import { LimitBadge } from "@/components/badges";
import { PressureBar } from "@/components/pressure-bar";
import { computeLimitStatus } from "@/lib/health";
import { tokenSymbol } from "@/lib/tokens";
import { formatWei, TRADING_LIMITS_INTERNAL_DECIMALS } from "@/lib/format";
import type { BrokerLimitsState } from "@/lib/broker-limits";
import { useNetwork } from "@/components/network-provider";

/** FPMM TradingLimitsV2 stores limits and netflow at 15-decimal internal
 * precision. Module scope keeps the prop identity stable across renders. */
const formatFpmmAmount = (raw: string) =>
  formatWei(raw, TRADING_LIMITS_INTERNAL_DECIMALS, 2);

interface LimitPanelProps {
  pool: Pool;
  tradingLimits: TradingLimit[];
  /** v2 Broker limits for the exchange a VirtualPool wraps. Ignored on FPMM
   * pools, which carry their own `TradingLimit` rows. */
  brokerLimits: BrokerLimitsState;
  hasError?: boolean;
  /** True while the trading-limits query is genuinely in flight and hasn't
   * resolved data yet. Distinguishes "still loading" from "confirmed no
   * limits configured" so the panel doesn't briefly show the empty-state
   * copy for a pool that does have configured limits (issue #1222
   * criterion #3: no sliver→expand on first load or tab switch). */
  isLoading?: boolean;
}

export function LimitPanel({
  pool,
  tradingLimits,
  brokerLimits,
  hasError = false,
  isLoading = false,
}: LimitPanelProps) {
  if (isVirtualPool(pool)) {
    return <BrokerLimitPanel pool={pool} state={brokerLimits} />;
  }
  return (
    <FpmmLimitPanel
      pool={pool}
      tradingLimits={tradingLimits}
      hasError={hasError}
      isLoading={isLoading}
    />
  );
}

function FpmmLimitPanel({
  pool,
  tradingLimits,
  hasError,
  isLoading,
}: {
  pool: Pool;
  tradingLimits: TradingLimit[];
  hasError: boolean;
  isLoading: boolean;
}) {
  const { network } = useNetwork();

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-base font-semibold text-white">Trading Limits</h2>
        <LimitBadge status={computeLimitStatus(pool)} />
      </div>

      {hasError ? (
        <p className="text-sm text-red-400">
          Unable to load trading limits — try again later.
        </p>
      ) : isLoading && tradingLimits.length === 0 ? (
        <LimitPanelSkeleton />
      ) : tradingLimits.length === 0 ? (
        <p className="text-sm text-slate-400">
          No trading limit data available yet.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {tradingLimits.map((tl) => {
            const sym = tokenSymbol(network, tl.token);
            return (
              <div key={tl.id} className="flex flex-col gap-3">
                <div className="text-xs font-medium text-slate-400 uppercase tracking-wide">
                  {sym}
                </div>
                <PressureBar
                  pressure={tl.limitPressure0}
                  label="5-minute limit (L0)"
                  netflow={tl.netflow0}
                  limit={tl.limit0}
                  formatValue={formatFpmmAmount}
                  tokenSymbol={sym}
                />
                <PressureBar
                  pressure={tl.limitPressure1}
                  label="Daily limit (L1)"
                  netflow={tl.netflow1}
                  limit={tl.limit1}
                  formatValue={formatFpmmAmount}
                  tokenSymbol={sym}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const LIMIT_SKELETON_SHIMMER = "animate-pulse rounded bg-slate-800/50";

// Mirrors the loaded shape for the common two-token case (a pool's token0 +
// token1, each with an L0 + L1 PressureBar) so the panel doesn't briefly
// render the "No trading limit data available yet." copy — which reads as a
// confirmed empty state — while a pool that does have configured limits is
// still loading (issue #1222 criterion #3).
function LimitPanelSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: 2 }, (_, tokenIdx) => (
        // react-doctor-disable-next-line react-doctor/no-array-index-as-key
        <div
          key={`limit-skel-token-${tokenIdx}`}
          className="flex flex-col gap-3"
        >
          <div className={`h-3 w-16 ${LIMIT_SKELETON_SHIMMER}`} />
          {Array.from({ length: 2 }, (_, barIdx) => (
            <div
              // react-doctor-disable-next-line react-doctor/no-array-index-as-key
              key={`limit-skel-bar-${tokenIdx}-${barIdx}`}
              className="flex flex-col gap-1"
            >
              <div className="flex items-center justify-between">
                <div className={`h-4 w-28 ${LIMIT_SKELETON_SHIMMER}`} />
                <div className={`h-4 w-10 ${LIMIT_SKELETON_SHIMMER}`} />
              </div>
              <div className={`h-2 w-full ${LIMIT_SKELETON_SHIMMER}`} />
              <div className={`h-3 w-40 ${LIMIT_SKELETON_SHIMMER}`} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
